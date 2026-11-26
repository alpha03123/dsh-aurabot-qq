// 刷 B 站：定时挑她和你感兴趣的方向去搜视频，读简介、字幕、热评，再按她的人格决定评不评论、分不分享给你、记住什么；
// 定时看别人回她的评论并接着回；你在 QQ 里发链接，她也能点进去看完再聊。看过的、评过的都记成她的经历。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { createBiliApi, findVideoId, parseCookie } from './api.js'
import { loginSessionKey, recoverLoginPause } from './login-pause.js'
import { lookWithVision, visionState } from './vision.js'
import { createShotStore, shotPath, clockOf } from './shots.js'
import { createParaformer } from './asr.js'
import { saveVideo, findVideo, videoText, appendVideoInteraction } from './videos.js'
import { danmakuInsight, parseDanmakuXml, transcriptExcerpt, subtitleFits, visualLine, clock, commentLines } from './insight.js'
import { findFfmpeg } from '../core/img.js'
import { assertPublicUrl } from '../core/net.js'

// 这些错误说明今天别再发了：没登录 / Cookie 过期、csrf 不对、风控、要验证码、太频繁
const PAUSE_CODES = { '-101': 'B 站没登录或 Cookie 过期了', '-111': 'Cookie 里的 bili_jct 不对', '-352': '被 B 站风控了', '-509': '发得太频繁', '12015': 'B 站要求验证码' }
import { isSilence, cleanOutboundText } from '../chat/reply.js'

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const link = (bvid) => `https://www.bilibili.com/video/${bvid}`
/** B 站评论/回复是一整条发的：把模型偶尔带出的 QQ 拆气泡符（||| 或换行）柔顺拼成一行，避免截断丢半句或原样发出 |||。 */
const flattenBiliText = (s) => String(s || '')
  .replace(/\s*\|\|\|\s*/g, '\n')
  .split(/[\r\n]+/)
  .map((p) => p.trim())
  .filter(Boolean)
  .reduce((acc, p) => (!acc ? p : /[，。！？!?、…~～)$）》」"'`]$/.test(acc) ? `${acc} ${p}` : `${acc}，${p}`), '')

/** 从模型输出里取 JSON（对象或数组），取不到返回 fallback。 */
export function pickJson(out, fallback) {
  const s = String(out || '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '').trim()
  if (!s) return fallback
  try { return JSON.parse(s) } catch (error) {}
  const iArr = s.indexOf('[')
  const iObj = s.indexOf('{')
  const order = iObj !== -1 && (iArr === -1 || iObj < iArr)
    ? [/\{[\s\S]*\}/, /\[[\s\S]*\]/]
    : [/\[[\s\S]*\]/, /\{[\s\S]*\}/]
  for (const re of order) {
    const m = s.match(re)
    if (!m) continue
    try { return JSON.parse(m[0]) } catch (error) {}
  }
  return fallback
}

/** 搜到的视频按门槛过滤：播放量够、不太老、没看过。 */
export function filterVideos(list, { minViews = 0, maxAgeDays = 0, seen = new Set(), now = Date.now() } = {}) {
  return (list || []).filter((v) => v.bvid && !seen.has(v.bvid) && (v.play || 0) >= minViews && (!maxAgeDays || !v.pubdate || now - v.pubdate <= maxAgeDays * 86400_000))
}

const SOURCE_LABEL = { subtitle: '字幕', ai: '字幕（B 站 AI 字幕）', asr: '语音转写（机器识别，可能有错字）' }

/**
 * 一个视频交给她看的样子：标题、UP 主、简介、字幕 / 语音转写、画面（节奏 + 抽帧描述）、弹幕、热评。
 * subtitle 是已经截好的文字；source 说明它从哪来（subtitle / ai / asr）。
 */
export function digestOf(v, { subtitle = '', source = 'subtitle', comments = [], vision = '', visual = null, danmaku = null } = {}) {
  const dm = danmaku && danmaku.total ? danmaku : null
  return [
    `《${v.title}》 UP主：${v.author || '?'}  播放 ${v.play || 0}${v.tname ? '  分区：' + v.tname : ''}${v.duration ? '  时长 ' + clock(v.duration) : ''}  ${v.bvid}`,
    v.desc ? `简介：${v.desc.slice(0, 300)}` : '',
    subtitle
      ? `${SOURCE_LABEL[source] || '字幕'}（节选）：${subtitle.slice(0, 2600)}`
      : `（没有字幕${vision ? '，只看了画面' : '，只能看标题、简介和评论'}）`,
    visual ? `画面节奏：${visualLine(visual)}` : '',
    vision ? `画面（抽帧）：${vision.slice(0, 900)}` : '',
    dm ? `弹幕：共 ${dm.total} 条` + (dm.top.length ? `；刷得最多的：${dm.top.slice(0, 5).map((x) => `「${x.text.slice(0, 20)}」×${x.n}`).join(' ')}` : '') : '',
    dm && dm.peaks.length ? '弹幕最热闹的时刻：' + dm.peaks.map((p) => `${clock(p.at)}（${p.texts.map((t) => '「' + t.slice(0, 16) + '」').join('')}）`).join('；') : '',
    comments.length ? '评论区：\n' + commentLines(comments, 8).join('\n') : '',
  ].filter(Boolean).join('\n')
}

export function createBili({ getConfig, hub, memory, log, dsh, api: injected, vision: see = lookWithVision, afterBrowse }) {
  const cfg = () => getConfig().bili
  const api = injected || createBiliApi({ getCookie: () => cfg().cookie, log })
  const shots = createShotStore({ max: () => getConfig().bili.shotLibrary })
  const file = () => dataDir('bili.json')
  const load = () => readJson(file(), () => ({ day: '', runs: 0, comments: 0, replies: 0, lastRun: 0, lastReplyCheck: 0, seen: [], repliedFeed: [], history: [] }))
  const save = (s) => writeJson(file(), s)
  const today = (s) => { if (s.day !== dayKey()) Object.assign(s, { day: dayKey(), runs: 0, comments: 0, replies: 0 }) ; return s }
  let busy = false
  let stopped = false
  let login = { at: 0, key: '', value: { isLogin: false, uname: '' } }

  const owner = () => getConfig().ownerName || '主人'
  /** 最近一天和主人的私聊（最多 8 行）：判断「这个视频跟最近聊的有没有关系」用 */
  const ownerChat = () => {
    const id = getConfig().ownerId
    if (!id || typeof hub.chatLogOf !== 'function') return []
    const since = Date.now() - 24 * 3600_000
    const days = [dayKey(new Date(since)), dayKey()]
    const rows = [...new Set(days)].flatMap((d) => hub.chatLogOf(d) || []).filter((r) => r && r.chatId === `private:${id}` && Number(r.t) >= since && r.text)
    const lines = rows.slice(-8).map((r) => `${hm(r.t)} ${r.who === 'bot' ? `你发给${owner()}` : owner()}：${String(r.text).slice(0, 60)}`)
    // 最后一条是她发的、主人还没回：标出来（之前只写「你：」，模型常把她自己的话当成主人说的）
    if (rows.length && rows[rows.length - 1].who === 'bot') lines.push(`（${owner()}到现在还没回）`)
    return lines
  }
  const hm = (t) => { const d = new Date(Number(t) || Date.now()); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  const whenLabel = (t) => {
    const d = new Date(Number(t) || Date.now())
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const targetStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const days = Math.round((todayStart - targetStart) / 86_400_000)
    const time = hm(d.getTime())
    if (days <= 0) return `今天 ${time}`
    if (days === 1) return `昨天 ${time}`
    if (days === 2) return `前天 ${time}`
    return `${d.getMonth() + 1}月${d.getDate()}日 ${time}（${days}天前）`
  }
  // 能不能发评论 / 回复：Cookie 里要有 bili_jct，今天也没因为风控之类暂停
  const canPost = (s) => Boolean(parseCookie(cfg().cookie).bili_jct) && s.pauseDay !== dayKey()
  const pauseIf = (s, error) => {
    const why = PAUSE_CODES[String(error.code)]
    if (!why) return
    s.pauseDay = dayKey()
    s.pauseReason = why
    log.warn(`今天先不在 B 站发评论了：${why}`)
  }
  const record = (s, item) => { s.history.unshift({ at: Date.now(), ...item }); s.history = s.history.slice(0, 40) }
  // 攒着想跟主人说的视频：她刷到时选了「先攒着」（或那会儿不方便发），等主人下次来私聊时作为背景给她，提不提她自己定。
  // 存在 bili.json 的 saved 里，不随每天清零；没提过的留 SAVED_KEEP_MS，第一次给她看过之后再留 SAVED_SHOWN_MS（那次聊天里没提就算了）
  const SAVED_KEEP_MS = 2 * 86_400_000
  const SAVED_SHOWN_MS = 40 * 60_000
  const SAVED_MAX = 5
  const freshSaved = (s) => (Array.isArray(s.saved) ? s.saved : []).filter((x) => x && x.bvid && (x.shownAt ? Date.now() - x.shownAt < SAVED_SHOWN_MS : Date.now() - x.at < SAVED_KEEP_MS))
  function saveForLater(s, { x, why, feeling, mode = 'later' }) {
    const v = x.info
    s.saved = [{ at: Date.now(), bvid: v.bvid, title: String(v.title || '').slice(0, 80), author: String(v.author || '').slice(0, 30), why: String(why || '').slice(0, 160), feeling: String(feeling || '').slice(0, 120), mode: mode === 'seed' ? 'seed' : 'later' },
      ...freshSaved(s).filter((y) => y.bvid !== v.bvid)].slice(0, SAVED_MAX)
    record(s, { kind: 'save', title: v.title, bvid: v.bvid, text: why })
  }
  /** 主人来私聊时给她的背景：攒着的那几个视频。同一个会话里每条只贴一次（已经在会话历史里，不再每轮刷屏）；换了新会话 40 分钟内仍可带一次 */
  function savedForChat(sessionId = '') {
    const s = load()
    const list = freshSaved(s)
    if (!list.length) { if ((s.saved || []).length) { s.saved = []; save(s) } return '' }
    const sid = String(sessionId || '')
    const toShow = sid ? list.filter((x) => x.shownSession !== sid) : list
    if (!toShow.length) return ''
    const now = Date.now()
    const shownIds = new Set(toShow.map((x) => x.bvid))
    s.saved = list.map((x) => (shownIds.has(x.bvid) ? { ...x, shownAt: x.shownAt || now, ...(sid ? { shownSession: sid } : {}) } : x))
    save(s)
    return [
      '【你攒着想跟他说的】（之前刷 B 站看到的备选话头；注意每条标注的观看日期，不是今天刚看的别说成「刚看」。如果对方现在只是刚打招呼或聊别的事，先正常接他的话，别一上来急着甩视频链接；真聊到相关话题或自然闲着时再顺嘴提一句，不合适就先留着不提）',
      ...toShow.map((x) => x.mode === 'seed'
        ? `- 《${x.title}》（${whenLabel(x.at)} 看的，碎碎念话头）：${x.why}${x.feeling ? `；当时反应：${x.feeling}` : ''}（不用主动甩链接，他真问起再用 bili_recent 翻）`
        : `- 《${x.title}》（UP主 ${x.author || '?'}，${whenLabel(x.at)} 看的）：想提是因为${x.why}${x.feeling ? `；你当时的反应：${x.feeling}` : ''}；链接 ${link(x.bvid)}`),
      '细节用 bili_video 翻；不必硬塞链接，他想看再发也行。',
    ].join('\n')
  }

  async function account(force = false) {
    const key = loginSessionKey(cfg().cookie)
    if (!force && key === login.key && Date.now() - login.at < 10 * 60_000) return login.value
    try {
      const value = await api.nav()
      if (stopped || key !== loginSessionKey(cfg().cookie)) return { isLogin: false, uname: '', error: '登录态已变化，请重新检查' }
      login = { at: Date.now(), key, value }
      const s = load()
      if (recoverLoginPause(s, { isLogin: value.isLogin, sessionKey: key, day: dayKey() })) {
        save(s)
        log.info('B 站登录核验通过，已解除登录失效导致的评论暂停')
      }
    } catch (error) {
      login = { at: Date.now(), key, value: { isLogin: false, uname: '', error: error.message } }
    }
    return login.value
  }

  async function think(prompt) {
    const nowStr = new Date().toLocaleString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false })
    return hub.runSystemTurn('bili', '刷B站', `【刷 B 站，不是聊天，这一轮不会发到聊天里；现在是 ${nowStr}】\n${prompt}`, { timeoutMs: 180000 })
  }

  /** 这一轮搜什么：她自己的兴趣 + 记忆里你喜欢的东西 + 面板里填的关键词，让她挑 3 个。 */
  async function chooseKeywords() {
    const c = cfg()
    const interests = [...(c.keywords || []), ...(getConfig().group.interests || [])]
    // 本地改（2026-11-17）：她自己看过 / 做过的事（seen、经历）不算「关于主人的事」，否则「我想补几部番」会被当成主人推荐的
    const about = (memory?.list?.('') || []).filter((m) => m.kind !== 'seen' && m.source !== 'event' && (String(m.about) === String(getConfig().ownerId) || /喜欢|爱|想|在玩|在看|追/.test(m.text))).slice(0, 12).map((m) => m.text)
    const recent = (memory?.recentEvents?.(72, 8) || []).filter((m) => m.kind === 'seen' || (m.tags || []).includes('B站')).slice(0, 6).map((m) => m.text)
    try {
      const out = await think(`你想去 B 站刷点视频。你感兴趣的：${interests.join('、') || '随便看看'}。\n你记得的关于${owner()}和大家的事：\n${about.map((t) => '- ' + t).join('\n') || '（暂无）'}\n你自己最近刷过 / 看过的：\n${recent.map((t) => '- ' + t).join('\n') || '（暂无）'}\n\n挑 3 个这次想搜的关键词（可以是你自己想看的，也可以是${owner()}可能喜欢、你想分享给${owner()}的），别和最近刷过的重复。只输出 JSON 数组，例如 ["白米饭 做法","猫咪 搞笑"]。`)
      const arr = pickJson(out, []).map((k) => String(k).trim()).filter(Boolean)
      if (arr.length) return arr.slice(0, 3)
    } catch (error) {
      log.debug('挑关键词失败：', error.message)
    }
    return interests.sort(() => Math.random() - 0.5).slice(0, 3)
  }

  // 没字幕时用阿里云百炼 Paraformer 转写：key 优先面板里填的，其次 DSH 凭据 / 环境变量 DASHSCOPE_API_KEY
  async function asrKey() {
    const own = String(cfg().asrKey || '').trim()
    if (own) return own
    try {
      const cred = dsh && typeof dsh.get === 'function' ? dsh.get('credentials') : null
      if (cred && typeof cred.resolve === 'function') {
        const r = await cred.resolve('DASHSCOPE_API_KEY')
        if (r && r.value) return String(r.value)
      }
    } catch (error) {}
    return String(process.env.DASHSCOPE_API_KEY || '')
  }
  const asr = createParaformer({ getKey: asrKey, getBase: () => cfg().asrBaseUrl, getModel: () => cfg().asrModel || 'paraformer-v2', log })

  /** 转写一个视频的声音（最低码率那路音频，最多转前 asrMaxMinutes 分钟）。失败返回 []。 */
  async function transcribe(info, ffmpeg) {
    try {
      const pu = await api.playurl({ bvid: info.bvid, aid: info.aid, cid: info.cid, qn: 32 })
      const audio = (pu.audio || []).slice().sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0]
      const url = audio?.baseUrl || pu.durl?.[0]?.url
      if (!url) return []
      await assertPublicUrl(url)
      const segs = await asr.transcribeStream({ ffmpeg, audioUrl: url, maxSec: Math.round((cfg().asrMaxMinutes || 30) * 60) })
      log.debug(`《${info.title}》转写出 ${segs.length} 句`)
      return segs
    } catch (error) {
      log.warn(`《${info.title}》语音转写失败：${error.message}`)
      return []
    }
  }

  async function lookAt(v, { depth = 'watch' } = {}) {
    const skim = depth === 'skim'
    const rawInfo = await api.view({ bvid: v.bvid })
    const info = {
      ...rawInfo,
      title: cleanOutboundText(rawInfo.title, { warn: (message) => log.warn(`B 站标题：${message}`) }).trim(),
      author: cleanOutboundText(rawInfo.author, { warn: (message) => log.warn(`B 站作者：${message}`) }).trim(),
    }
    const c = cfg()
    // 字幕（带时间）、热评、弹幕一起取；老的 api 只有 subtitle() 返回纯文字
    const [track, comments, dmXml] = await Promise.all([
      api.subtitleTrack
        ? api.subtitleTrack(info).catch((error) => { log.debug('拿字幕失败：', error.message); return null })
        : api.subtitle(info).then((text) => (text ? { plain: String(text) } : null)).catch(() => null),
      api.comments(info.aid).catch(() => []),
      c.readDanmaku !== false && api.danmakuXml && info.cid ? api.danmakuXml(info.cid).catch(() => '') : '',
    ])
    let segments = track?.segments || []
    if (segments.length && !subtitleFits(segments, info.duration)) {
      log.debug(`《${info.title}》的字幕和视频时长对不上，当作没有字幕`)
      segments = []
    }
    let source = segments.length ? (track.ai ? 'ai' : 'subtitle') : ''
    const danmaku = danmakuInsight(parseDanmakuXml(dmXml), info.duration)

    // 没字幕就转写；skim（快扫模式）跳过抽帧视觉和超长音频转写，省时省流量
    const ffmpeg = findFfmpeg(c.ffmpegPath)
    const needAsr = !segments.length && !track?.plain && c.asr && ffmpeg && Number(info.duration) > 0 && (!skim || Number(info.duration) <= 600)
    const asrDone = needAsr && (await asrKey()) ? transcribe(info, ffmpeg) : Promise.resolve([])
    const lines = asrDone.then((a) => (segments.length ? segments : a))

    let vision = ''
    let visual = null
    let shotIds = []
    if (c.vision && !skim) {
      try {
        const r = await see({ dsh, api, info, getConfig, log, peaks: danmaku.peaks, segments: lines })
        vision = r.text || ''
        visual = r.visual || null
        if (vision) log.debug(`看了《${info.title}》的画面：${vision.slice(0, 40)}…`)
        // 抽到的帧顺手存进截图库：之后她自己发、或主人让她挑一张发
        for (const f of r.frames || []) {
          const it = shots.put(f.buf, { bvid: info.bvid, title: info.title, sec: f.sec, note: vision.slice(0, 120) })
          if (it) shotIds.push(it.file)
        }
      } catch (error) {
        log.debug(`看画面失败（${info.bvid}）：`, error.message)
      }
    }
    const heard = await asrDone
    if (!segments.length && heard.length) { segments = heard; source = 'asr' }
    const subtitle = track?.plain ? track.plain.slice(0, 2500) : transcriptExcerpt(segments, 2500)
    // 完整内容存一份，聊天里聊到细节时用 bili_video 翻（不整段塞进聊天会话）
    try {
      saveVideo({
        bvid: info.bvid, title: info.title, author: info.author, url: link(info.bvid), duration: info.duration, play: info.play, tname: info.tname, desc: info.desc,
        source, segments, plain: track?.plain || '', vision, visual, danmaku, comments: (comments || []).slice(0, 20), watchedAt: Date.now(),
      })
    } catch (error) {
      log.debug('存视频内容失败：', error.message)
    }
    return { info, subtitle, source, segments, comments, vision, visual, danmaku, shotIds, digest: digestOf(info, { subtitle, source, comments, vision, visual, danmaku }) }
  }

  /** 挑一张存下来的截图发到指定会话（主人让她发 / 她刷完顺手发）。 */
  async function sendShot({ chatId, query = '' } = {}) {
    const g = getConfig()
    if (!g.enabled || !g.bili.enabled) return { ok: false, sent: false, message: '插件或 B 站没打开' }
    if (!/^(private|group):\d+$/.test(String(chatId || ''))) return { ok: false, sent: false, message: '没有可发送的会话' }
    const it = shots.pick(query)
    if (!it) {
      return {
        ok: false,
        message: query ? `没有和「${query}」对得上的截图（不带条件再挑就是最近的一张）` : '我还没截过图（刷 B 站看画面的时候才会截）',
      }
    }
    if (!shots.exists(it)) return { ok: false, message: '那张截图的文件已经没有了' }
    if (g.dryRun) return { ok: true, sent: false, simulated: true, message: `试运行：准备发送《${it.title}》${clockOf(it.sec)} 的截图，未实际发送` }
    let r
    try { r = await hub.sendImage(chatId, shotPath(it)) } catch (error) {
      return { ok: false, sent: false, message: '图没发出去：' + error.message }
    }
    if (String(r?.message_id || '').startsWith('sim-')) return { ok: true, sent: false, simulated: true, message: '模拟发送：未实际发出' }
    if (r?.message_id === undefined) return { ok: false, sent: false, message: '图没发出去或未收到消息回执，看日志' }
    const st = load()
    record(st, { kind: 'shot', title: it.title, bvid: it.bvid, text: `第 ${clockOf(it.sec)} 的截图` })
    save(st)
    log.info(`发了一张截图《${it.title}》${clockOf(it.sec)} → ${chatId}`)
    return { ok: true, sent: true, message: `发了《${it.title}》${clockOf(it.sec)} 那一帧`, shot: { title: it.title, bvid: it.bvid, sec: it.sec } }
  }

  /** 让她自己看看手上有哪些截图（挑之前先看）。 */
  function listShots(query = '') {
    const list = shots.list(query).slice(0, 20).map((i) => ({ title: i.title, bvid: i.bvid, sec: i.sec, clock: clockOf(i.sec), note: i.note }))
    return list.length
      ? { ok: true, list, message: `手上有 ${shots.count()} 张截图，这是${query ? `和「${query}」有关的 ` : '最近的 '}${list.length} 张` }
      : { ok: false, list: [], message: query ? `没有和「${query}」对得上的截图` : '还没有截图' }
  }

  /** 面板用：截图库全量列表（按当前上限先裁一遍）。 */
  function libraryShots() {
    return { ok: true, items: shots.panel() }
  }

  /** 面板用：某张截图在本机的绝对路径；文件不在就返回 ''。 */
  function shotFileOf(name) {
    const it = shots.list('').find((i) => i.file === String(name || ''))
    if (!it || !shots.exists(it)) return ''
    return shotPath(it)
  }

  /** 面板用：手动删掉库里的一张。 */
  function deleteShot(name) {
    const r = shots.remove(name)
    if (r.ok) log.info(r.message)
    return r
  }

  /** 她写 @主人 时换成主人的 B 站昵称，名字后面要有空格才算结束。 */
  const atOwner = (text) => {
    const name = String(cfg().ownerName || '').trim()
    return name ? String(text).replace(/[@＠]主人\s*/g, `@${name} `) : String(text)
  }

  /**
   * 把想分享的视频交给主人私聊会话：系统提示里给视频事实、链接、她的感受和想分享的理由，
   * 由聊天那边用平常的口气说（或者沉默）。shot：先发一张截图（她选的，开了「允许配截图」才发）。
   * 返回 { delivered, shot, silent }。
   */
  async function deliverShare({ x, why, feeling, shot }) {
    const g = getConfig()
    const chatId = `private:${g.ownerId}`
    if (g.dryRun || !g.enabled) {
      log.info(`试运行 / 总开关关：本来要把《${x.info.title}》分享给主人：${why}`)
      return { delivered: false, shot: false, silent: false }
    }
    if (typeof hub.pushToSession !== 'function') return { delivered: false, shot: false, silent: false }
    let shotSent = false
    if (shot && Number(g.bili.shotChance) > 0 && x.shotIds && x.shotIds.length) {
      try {
        const file = x.shotIds[Math.floor((x.shotIds.length - 1) / 2)]
        const r = await hub.sendImage(chatId, shotPath({ file }))
        shotSent = r?.message_id !== undefined && !String(r.message_id).startsWith('sim-')
      } catch (error) {
        log.debug('分享时发截图失败：', error.message)
      }
    }
    const v = x.info
    // 内容要点：几百字，够自然地聊、接住一般的追问；细节用工具翻
    const brief = [
      v.desc ? `简介：${String(v.desc).slice(0, 120)}` : '',
      x.subtitle ? `${x.source === 'asr' ? '语音转写' : '字幕'}节选：${x.segments?.length ? transcriptExcerpt(x.segments, 450, { pieces: 3 }) : String(x.subtitle).slice(0, 450)}` : '',
      x.visual ? `画面：${visualLine(x.visual)}` : '',
      x.vision ? `截图里：${String(x.vision).slice(0, 150)}` : '',
      x.danmaku?.peaks?.length ? `弹幕最热闹：${x.danmaku.peaks.slice(0, 1).map((p) => `${clock(p.at)}（${p.texts.slice(0, 2).map((t) => '「' + t.slice(0, 16) + '」').join('')}）`).join('')}` : '',
      x.comments?.length ? '评论区：\n' + commentLines(x.comments, 3).map((l) => l.replace(/^ {2}/, '  ').slice(0, 110)).join('\n') : '',
    ].filter(Boolean).join('\n')
    const prompt = [
      `【系统提醒，不是${owner()}说的话】你刚在 B 站看了个视频，想拿给${owner()}看。`,
      `视频：《${v.title}》（UP主 ${v.author || '?'}）`,
      `链接：${link(v.bvid)}`,
      feeling ? `你刚看完的直觉反应：${feeling}` : '',
      `想给他看是因为：${why}`,
      brief ? `视频里的内容（要点）：\n${brief}` : '',
      '完整的字幕、画面、评论存着，聊到具体哪段时用 bili_video 翻。',
      shotSent ? '你已经先把视频里的一张截图发给他了。' : '',
      '现在就跟他说吧：像平时刷到好玩/馋人/离谱的东西顺手甩给朋友那样，挑最戳你的一个小点随口吐槽或安利，别写推荐语、内容简介或总结陈词，控制成 2~4 条短气泡（每条一小句）。这会儿觉得不合适，就只回 [沉默]。',
    ].filter(Boolean).join('\n')
    const before = Number(hub.lastBotToOwner?.at) || 0
    try {
      await hub.pushToSession({ chatId, kind: 'private', userId: String(g.ownerId), nickname: owner() }, [{ type: 'text', text: prompt }], '')
    } catch (error) {
      log.warn(`想分享《${v.title}》给主人，但没递进聊天：${error.message}`)
      return { delivered: false, shot: shotSent, silent: false }
    }
    // pushToSession 只是排进队列：等这一轮说完再看她开没开口
    const waited = typeof hub.waitDelivery === 'function' ? await hub.waitDelivery(chatId).catch(() => 'timeout') : 'timeout'
    const spoke = (Number(hub.lastBotToOwner?.at) || 0) > before
    const delivered = spoke || waited === 'timeout'
    log.info(delivered ? `把《${v.title}》分享给了主人${shotSent ? '（配了截图）' : ''}` : `想分享《${v.title}》，到聊天里又没开口`)
    return { delivered, shot: shotSent, silent: !delivered }
  }

  /** 最近看过 / 评过 / 分享过的视频（带链接与互动状态）：主人问「那个视频链接呢」「你最近刷了啥」时她查这个 */
  function recent(query = '', limit = 8) {
    const q = String(query || '').trim()
    const history = load().history || []
    const out = []
    const seenIds = new Set()
    for (const h of history) {
      if (!h.bvid || !['share', 'save', 'watch', 'shot', 'comment', 'like'].includes(h.kind) || seenIds.has(h.bvid)) continue
      if (q && !String(h.title || '').includes(q)) continue
      seenIds.add(h.bvid)
      const related = history.filter((y) => y.bvid === h.bvid)
      const cmt = related.find((y) => y.kind === 'comment')
      out.push({
        bvid: h.bvid,
        title: h.title,
        link: link(h.bvid),
        shared: related.some((y) => y.kind === 'share'),
        saved: related.some((y) => y.kind === 'save'),
        liked: related.some((y) => y.kind === 'like'),
        commented: Boolean(cmt),
        ...(cmt ? { myComment: String(cmt.text || '').slice(0, 80) } : {}),
        at: new Date(h.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
        note: String(h.text || '').slice(0, 60),
      })
      if (out.length >= limit) break
    }
    return out.length ? { ok: true, list: out } : { ok: false, list: [], message: q ? `最近没看过标题里有「${q}」的视频` : '最近没看过 B 站视频' }
  }

  /** 读一个看过的视频的完整内容（按 BV 号或标题词）；字幕分页。 */
  function video(query = '', page = 1) {
    const rec = findVideo(query)
    if (!rec) return { ok: false, message: query ? `没找到存着的「${query}」（只存最近两周看过的；没看过的可以用 bili_watch 现看）` : '最近没有存着的视频' }
    return { ok: true, bvid: rec.bvid, message: videoText(rec, page) }
  }

  /**
   * 两段式自主挑片：先把搜到的候选列表（标题、UP主、时长、播放量、简介首句）交给她扫一眼，
   * 由她自己决定点开哪几个（最多 maxPick 个，也可以 0 个直接划走）以及看多深（watch 认真看画面+字幕 / skim 快扫字幕热评）。
   * 返回 { decided, picks: [{ video, depth }], skipReason }；解析失败时 decided=false，调用方平滑退回轮询挑选。
   */
  async function pickFromPool(candidates, { maxPick = 3, query = '' } = {}) {
    const list = (candidates || []).slice(0, 10)
    if (list.length <= 1) return { decided: false, picks: list.map((video) => ({ video, depth: 'watch' })), skipReason: '' }
    const lines = list.map((v, idx) => {
      const dur = v.duration ? ` | 时长 ${typeof v.duration === 'number' ? clock(v.duration) : String(v.duration)}` : ''
      const play = v.play ? ` | 播放 ${v.play}` : ''
      const desc = v.desc ? ` | 简介：${String(v.desc).replace(/\s+/g, ' ').slice(0, 60)}` : ''
      return `${idx + 1}. 《${v.title}》（UP主：${v.author || '?'}${dur}${play}）${desc}`
    })
    try {
      const out = await think(
        `${query ? `你这次是专门来 B 站搜「${query}」的，` : '你在 B 站刷到了下面这批候选视频，'}先扫一眼标题和简介，按你当下的兴趣决定点开哪几个看（最多挑 ${maxPick} 个；觉得都没意思也可以一个都不点直接划走）：\n\n` +
        lines.join('\n') +
        `\n\n对想点开的每个视频选一下看多深：\n- "watch"：认真看（读字幕 + 抽帧看画面 + 看弹幕热评，适合搞笑、美食、猫片、日常、画面有意思的）\n- "skim"：快扫一眼（只看字幕和热评、不抽帧，适合超长白噪音、纯音乐或只想快查信息）\n只输出 JSON 对象：{"picks":[{"i":序号,"depth":"watch"}],"skipReason":"一个都不看时写一句原因，否则空字符串"}。`
      )
      const parsed = pickJson(out, null)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.picks)) {
        return { decided: false, picks: [], skipReason: '' }
      }
      const picked = []
      const used = new Set()
      for (const p of parsed.picks) {
        const idx = (Number(p?.i) || 0) - 1
        if (idx < 0 || idx >= list.length || used.has(idx)) continue
        used.add(idx)
        const depth = String(p?.depth || '').trim().toLowerCase() === 'skim' ? 'skim' : 'watch'
        picked.push({ video: list[idx], depth })
        if (picked.length >= maxPick) break
      }
      return { decided: true, picks: picked, skipReason: String(parsed.skipReason || '').trim().slice(0, 80) }
    } catch (error) {
      log.debug('自主挑片失败，退回默认挑选：', error.message)
      return { decided: false, picks: [], skipReason: '' }
    }
  }

  /** 刷一轮。force = 面板里手动点的（不占每天的次数）。 */
  // allowShare=false：只看不分享（autonomy 按「主动找主人」额度决定这一轮能不能分享）
  // query：她这次专门想找的东西（autonomy 的决策层给的搜索词）；有就只搜它，不挑兴趣关键词、不拿热门凑数
  async function run({ force = false, allowShare = true, query = '' } = {}) {
    const c = cfg()
    if (busy) return { ok: false, message: '正在刷' }
    if (!c.enabled && !force) return { ok: false, message: 'B 站没打开' }
    busy = true
    const s = today(load())
    try {
      const seen = new Set(s.seen)
      const q = String(query || '').trim().slice(0, 40)
      const kws = q ? [q] : await chooseKeywords()
      let pool = []
      // 找东西时不限发布时间、播放量门槛放低（教程多半是老视频）
      const gate = q ? { minViews: Math.min(c.minViews, 1000), maxAgeDays: 0, seen } : { minViews: c.minViews, maxAgeDays: c.maxAgeDays, seen }
      for (const kw of kws) {
        try { pool.push(...filterVideos(await api.search(kw), gate).slice(0, q ? Math.max(c.perRun * 2, 6) : 4).map((v) => ({ ...v, kw }))) } catch (error) { log.warn(`B 站搜「${kw}」失败：${error.message}`) }
      }
      if (!q && pool.length < c.perRun) {
        try { pool.push(...filterVideos(await api.popular({ ps: 20 }), { seen }).slice(0, Math.max(c.perRun * 2, 6)).map((v) => ({ ...v, kw: '热门' }))) } catch (error) {}
      }
      // 每个关键词轮着整理候选池（去重，最多 10 个给模型挑）
      const candidates = []
      const byKw = new Map()
      for (const v of pool) { if (!byKw.has(v.kw)) byKw.set(v.kw, []); byKw.get(v.kw).push(v) }
      while (candidates.length < 10 && [...byKw.values()].some((l) => l.length)) {
        for (const l of byKw.values()) {
          if (l.length && candidates.length < 10) {
            const v = l.shift()
            if (!candidates.some((p) => p.bvid === v.bvid)) candidates.push(v)
          }
        }
      }
      if (!candidates.length) return { ok: false, query: q, found: 0, message: q ? `B 站上搜「${q}」没找到合适的视频` : '这次没搜到合适的视频' }
      // 两段式挑片：让她先扫标题/简介决定点开哪几个、看多深；未返回有效 JSON 时平滑退回默认取前 perRun 个
      const pickRes = await pickFromPool(candidates, { maxPick: c.perRun, query: q })
      if (pickRes.decided && !pickRes.picks.length) {
        if (!force) s.runs++
        s.lastRun = Date.now()
        const why = pickRes.skipReason || '扫了一圈没刷到想点开的，划走了'
        log.info(`刷 B 站：候选 ${candidates.length} 个，她决定都不点开（${why}）`)
        return { ok: true, skipped: true, watched: 0, commented: 0, liked: 0, shared: 0, saved: 0, shots: 0, query: q, found: 0, answers: [], items: [], message: `扫了一圈 B 站：${why}` }
      }
      const chosen = pickRes.decided ? pickRes.picks : candidates.slice(0, c.perRun).map((video) => ({ video, depth: 'watch' }))
      const looked = []
      for (const { video: v, depth } of chosen) {
        try { looked.push({ ...(await lookAt(v, { depth })), depth }) } catch (error) { log.debug(`看 ${v.bvid} 失败：`, error.message) }
        seen.add(v.bvid)
      }
      s.seen = [...seen].slice(-500)
      if (!looked.length) return { ok: false, message: '视频都打不开' }
      const commentLeft = c.comment && canPost(s) ? Math.max(0, c.maxCommentsPerDay - s.comments) : 0
      // canShare：能不能想着分享给主人（攒着也算）；canNow：这会儿能不能直接发（主动找主人的额度还有、主人 15 分钟内没刚聊过）
      const canShare = c.shareToOwner && getConfig().ownerId
      const justTalked = Date.now() - Math.max(hub.lastOwnerChatAt || 0, hub.lastBotToOwner?.at || 0) < 15 * 60_000
      const canNow = Boolean(canShare && allowShare && !justTalked)
      const chatLines = canShare ? ownerChat() : []
      const out = await think(`${q ? `你这次是专门上 B 站搜「${q}」的，` : ''}你在 B 站${q ? '搜' : '刷'}到了这几个视频：\n\n${looked.map((x, i) => `【${i + 1}】${x.digest}`).join('\n\n')}\n\n` +
        (chatLines.length ? `最近和${owner()}的私聊（现在 ${hm()}）：\n${chatLines.join('\n')}\n\n` : '') +
        `看完说说你的想法（保持你自己的性格、说话习惯和颜文字，像真人在 B 站刷视频那样自然连贯，严禁写客观观后感、复述剧情或总结腔）。对每个视频给一个对象：{"i":序号, "feeling":"你看完当下的第一反应或随口吐槽（一句话，口语连贯，别写成内容概括）",${q ? ` "found":true 或 false（这个视频里有没有你要找的东西）, "answer":"found 为 true 时写要点（具体数字、步骤），只按上面字幕 / 转写 / 画面 / 评论里真看到的写，别凭印象补；false 就空字符串",` : ''} "like":true 或 false（真喜欢才给视频点赞，一般般就 false）, "comment":"真有冲动才在视频下留一句评论：点进评论区的人都刚看过这视频，完全不用复述视频步骤、名词或桥段当主语！直接顺着看完后脑子里冒出的第一念头、自己的日常联想/破防、歪楼吐槽或接一句热评梗随口写一句（保持你的性格口吻，情绪到了自然带个颜文字，通常 8~25 字一整句，别用 ||| 或换行）；严禁『XX这个细节太救命，原来我以前……』『XX那段也太XX，YY全被ZZ』这类工整两段式总结腔或硬造比喻；没真看清画面细节或没特别想说的就空字符串", "replyTo":"可选：如果上面这条 comment 是想直接接评论区某位网友的话（楼中楼回复），填上面评论区里那位网友的完整昵称；自己发一级评论就空字符串",${canShare ? ` "share":"想不想拿给${owner()}看：真觉得他会喜欢、或者跟最近聊的有关，就写一句具体戳到你的小点；一般般就空字符串。这一轮最多挑一个${canNow ? '' : '。这会儿不方便直接发，写了会先攒着，等下次他来找你聊、聊到合适的时候再提'}",${canNow ? ' "when":"share 不为空时填：now 现在就甩链接发给他；seed 只留一句碎碎念话头（等聊天顺嘴提，不急着甩链接）；later 先攒着，等下次他来找你聊、聊到合适的时候再提",' : ' "when":"share 不为空时填：seed 只留一句碎碎念话头（不急着甩链接）；later 先攒着等合适时再提",'}${canNow && Number(getConfig().bili.shotChance) > 0 ? ' "shot":true 或 false（现在就发时想不想先发一张这个视频的截图，没截图就 false）,' : ''}` : ''} "remember":"仅当有真正值得留作个人见闻或硬核知识时写一句（大多数视频直接空字符串；严禁为了填空去揣测${owner()}的喜好）"}。` +
        `这次最多评论 ${commentLeft} 个（宁缺毋滥，不想评就都留空）。只输出 JSON 数组。`)
      const decisions = pickJson(out, [])
      let commented = 0
      let liked = 0
      let shared = 0
      const answers = [] // 找东西时：哪些视频里有要找的（标题 + 要点）
      const itemsSummary = [] // 给 autonomy / 日志留底的精简观看清单
      // 一轮最多分享一个：她写了 share 的里面取第一个（她自己排的，不随机）；主人 15 分钟内刚聊过就先不发
      const shareOne = (Array.isArray(decisions) ? decisions : []).find((d) => d && String(d.share || '').trim() && !isSilence(String(d.share))) || null
      let shareJob = null
      let saved = 0
      const felt = new Map() // bvid → 她自己的一句感受，发截图时配着用
      for (const d of Array.isArray(decisions) ? decisions : []) {
        const x = looked[(Number(d.i) || 0) - 1]
        if (!x) continue
        const v = x.info
        const feeling = cleanOutboundText(d.feeling, { warn: (message) => log.warn(`B 站感受：${message}`) }).trim()
        const remember = cleanOutboundText(d.remember, { warn: (message) => log.warn(`B 站见闻：${message}`) }).trim()
        const answer = q ? cleanOutboundText(d.answer, { warn: (message) => log.warn(`B 站找到的：${message}`) }).trim() : ''
        // 只认 found 这个是 / 否：模型有时在 answer 里写「没找到……」，不能当成找到了
        const hit = d.found === true || String(d.found).trim().toLowerCase() === 'true'
        if (hit && answer && !isSilence(answer)) answers.push({ title: v.title, bvid: v.bvid, text: answer.slice(0, 300) })
        if (feeling) {
          felt.set(v.bvid, feeling)
          try { saveVideo({ bvid: v.bvid, feeling }) } catch (error) {}
        }
        // 评论：支持自己发一级评论，也支持填 replyTo 直接去楼中楼接热评的梗
        const comment = flattenBiliText(cleanOutboundText(atOwner(d.comment || ''), { warn: (message) => log.warn(`B 站评论：${message}`) })).slice(0, 200)
        const replyToName = String(d.replyTo || '').trim()
        const targetComment = replyToName ? (x.comments || []).find((cm) => cm && cm.rpid && String(cm.name || '').trim() === replyToName) : null
        let postedComment = ''
        let postedReplyTo = ''
        if (comment && !isSilence(comment) && commented < commentLeft && canPost(s)) {
          try {
            const payload = targetComment ? `回复 @${targetComment.name} :${comment}`.slice(0, 200) : comment
            const postOpts = targetComment ? { root: targetComment.rpid, parent: targetComment.rpid } : undefined
            if (getConfig().dryRun) log.info(`试运行：本来要在 B 站《${v.title}》下${targetComment ? `回复 @${targetComment.name}` : '评论'}：${comment}`)
            else await (postOpts ? api.postComment(v.aid, payload, postOpts) : api.postComment(v.aid, payload))
            commented++
            s.comments++
            postedComment = comment
            postedReplyTo = targetComment ? targetComment.name : ''
            memory?.addEvent?.({ text: `在B站《${v.title}》下${postedReplyTo ? `回复了 ${postedReplyTo}` : '评论'}：${comment.slice(0, 60)}`, tags: ['B站'], importance: 0.4 })
            record(s, { kind: 'comment', title: v.title, bvid: v.bvid, text: postedReplyTo ? `回复 @${postedReplyTo}：${comment}` : comment })
          } catch (error) {
            log.warn('B 站评论失败：', error.message)
            pauseIf(s, error)
            record(s, { kind: 'error', title: v.title, bvid: v.bvid, text: '评论没发出去：' + error.message })
          }
        }
        // 点赞：c.like 开关允许时，优先尊重模型自己的 d.like 决定（未填时保持旧行为）
        const wantLike = d.like === undefined ? true : (d.like === true || String(d.like).trim().toLowerCase() === 'true')
        let didLike = false
        if (c.like && wantLike && canPost(s)) {
          if (!getConfig().dryRun) api.likeVideo(v.aid).catch(() => {})
          didLike = true
          liked++
          record(s, { kind: 'like', title: v.title, bvid: v.bvid, text: '' })
        }
        // 把评论/点赞写进同一份视频档案，并合进同一条 seen 记忆，消除记忆断层
        if (postedComment || didLike) {
          try { appendVideoInteraction(v.bvid, { title: v.title, comment: postedComment ? { text: postedComment, replyTo: postedReplyTo } : null, liked: didLike }) } catch (error) {}
        }
        memory?.addEvent?.({
          kind: 'seen',
          meta: { title: v.title, author: v.author, url: link(v.bvid), platform: 'bili', id: v.bvid },
          text: [
            feeling,
            postedComment ? `顺手${postedReplyTo ? `回 ${postedReplyTo} ` : '评了句'}「${postedComment.slice(0, 50)}」` : '',
            !isSilence(remember) ? remember : '',
            answers.some((a) => a.bvid === v.bvid) ? `（找「${q}」）${answer.slice(0, 200)}` : '',
          ].filter(Boolean).join('；') || v.title,
          tags: ['B站'],
          importance: answers.some((a) => a.bvid === v.bvid) ? 0.5 : 0.4,
        })
        const share = cleanOutboundText(d.share, { warn: (message) => log.warn(`B 站分享：${message}`) }).trim()
        const whenMode = String(d.when || '').trim().toLowerCase()
        if (canShare && share && !isSilence(share) && d === shareOne) {
          const later = !canNow || whenMode !== 'now'
          if (later) { saveForLater(s, { x, why: share, feeling, mode: whenMode === 'seed' ? 'seed' : 'later' }); saved++ }
          else shareJob = { x, why: share, feeling, shot: d.shot === true || String(d.shot).trim().toLowerCase() === 'true' }
        }
        record(s, { kind: 'watch', title: v.title, bvid: v.bvid, text: feeling })
        itemsSummary.push({ title: v.title, bvid: v.bvid, depth: x.depth || 'watch', feeling, commented: Boolean(postedComment), liked: didLike })
      }
      // 分享：交给和主人聊天的那个会话去说（带着聊天上下文和人格），她在那儿再决定开不开口、怎么说
      let shotSent = 0
      if (shareJob) {
        const r = await deliverShare(shareJob)
        if (r.delivered) {
          shared++
          shotSent = r.shot ? 1 : 0
          record(s, { kind: 'share', title: shareJob.x.info.title, bvid: shareJob.x.info.bvid, text: shareJob.why })
          if (r.shot) record(s, { kind: 'shot', title: shareJob.x.info.title, bvid: shareJob.x.info.bvid, text: shareJob.feeling || '' })
          memory?.addEvent?.({ kind: 'seen', meta: { title: shareJob.x.info.title, author: shareJob.x.info.author, url: link(shareJob.x.info.bvid), platform: 'bili', id: shareJob.x.info.bvid }, text: `把这个视频分享给了${owner()}：${shareJob.why.slice(0, 80)}`, tags: ['B站'], importance: 0.45 })
        } else {
          record(s, { kind: 'error', title: shareJob.x.info.title, bvid: shareJob.x.info.bvid, text: r.silent ? '想分享，到聊天里又没开口' : '分享没发出去' })
          // 到聊天里觉得这会儿不合适：先攒着，等他来找她时再说
          if (r.silent) { saveForLater(s, shareJob); saved++ }
        }
      }
      if (!force) s.runs++
      s.lastRun = Date.now()
      if (afterBrowse) {
        try { await afterBrowse(looked.map(({ info }) => ({ bvid: info.bvid, title: info.title, text: felt.get(info.bvid) || '' }))) }
        catch (error) { log.debug('本轮弹幕未完成：', error.message) }
      }
      const heard = looked.filter((x) => x.subtitle).length
      const briefList = itemsSummary.slice(0, 3).map((it) => `《${String(it.title || '').slice(0, 18)}》${it.feeling ? `（${it.feeling.slice(0, 28)}）` : ''}`).join('；')
      log.info(`${q ? `B 站搜「${q}」` : '刷了一轮 B 站'}：看了 ${looked.length} 个（${heard} 个有字幕或转写${looked.some((x) => x.vision) ? '，看了画面' : ''}），${q ? `找到答案 ${answers.length} 个，` : ''}点赞 ${liked} 个，评论 ${commented} 条，分享 ${shared} 个，攒着 ${saved} 个，截图 ${shotSent} 张`)
      return {
        ok: true,
        message: `${q ? `搜「${q}」，` : ''}看了 ${looked.length} 个视频${briefList ? `：${briefList}` : ''}${q ? (answers.length ? `；${answers.length} 个里有要找的` : '；都没讲到要找的') : ''}；点赞 ${liked}，评论 ${commented} 条，分享给你 ${shared} 个${saved ? `，攒着 ${saved} 个等你来了再说` : ''}${shotSent ? '，还发了张截图' : ''}`,
        watched: looked.length, liked, commented, shared, saved, shots: shotSent, query: q, found: answers.length, answers, items: itemsSummary,
      }
    } catch (error) {
      log.warn('刷 B 站出错：', error.message)
      return { ok: false, message: error.message }
    } finally {
      save(s)
      busy = false
    }
  }

  /** 看别人回她的评论，接着回。 */
  async function checkReplies() {
    const c = cfg()
    if (!c.reply) return { ok: false, message: '回复没打开' }
    const s = today(load())
    s.lastReplyCheck = Date.now()
    let n = 0
    try {
      const done = new Set(s.repliedFeed)
      const fresh = (await api.replyFeed()).filter((x) => !done.has(x.id) && Number(x.type || 1) === 1 && x.oid).slice(0, 5)
      for (const item of fresh) {
        const x = {
          ...item,
          title: cleanOutboundText(item.title, { warn: (message) => log.warn(`B 站标题：${message}`) }).trim(),
          name: cleanOutboundText(item.name, { warn: (message) => log.warn(`B 站昵称：${message}`) }).trim(),
        }
        done.add(x.id)
        // 记下来：整理记忆时能知道 B 站上谁跟她聊过什么
        hub.logChat?.('bili', x.name, `在 B 站《${x.title}》下回复你：${x.text}`, '')
        if (s.replies >= c.maxRepliesPerDay || !canPost(s)) continue
        const out = await think(`你在 B 站视频《${x.title}》下发过评论：「${x.myText}」\n${x.name} 回复你：「${x.text}」\n想回就按你自己的性格和口吻顺口回一两句（B 站评论回复是一整条发的，写成自然连贯的一整句，禁止用 ||| 或换行拆气泡；情绪到了可以自然带个颜文字，别端着、别写总结或客套话，不想回就只输出 [沉默]）。只输出回复正文。`)
        const reply = flattenBiliText(cleanOutboundText(out, { warn: (message) => log.warn(`B 站回复：${message}`) }))
        if (!reply || isSilence(reply)) continue
        try {
          if (getConfig().dryRun) log.info(`试运行：本来要在 B 站回复 ${x.name}：${reply}`)
          else await api.postComment(x.oid, `回复 @${x.name} :${reply}`.slice(0, 200), { root: x.root, parent: x.parent })
          s.replies++
          n++
          memory?.addEvent?.({ text: `在B站回复了 ${x.name}（《${x.title}》）：${reply.slice(0, 50)}`, tags: ['B站'], importance: 0.35 })
          record(s, { kind: 'reply', title: x.title, text: `${x.name}：${x.text} → ${reply}` })
          try {
            const matched = x.bvid ? { bvid: x.bvid } : findVideo(x.title)
            if (matched?.bvid) appendVideoInteraction(matched.bvid, { title: x.title, reply: { who: x.name, theySaid: x.text, myReply: reply } })
          } catch (error) {}
        } catch (error) {
          log.warn('B 站回复失败：', error.message)
          pauseIf(s, error)
        }
      }
      s.repliedFeed = [...done].slice(-300)
      return { ok: true, message: `回了 ${n} 条`, replied: n }
    } catch (error) {
      return { ok: false, message: error.message }
    } finally {
      save(s)
    }
  }

  /** 她看一个视频（你发的链接 / BV 号），返回给她看的内容。 */
  async function watch(text) {
    let id = findVideoId(text)
    if (!id) return { ok: false, message: '没认出视频链接或 BV 号' }
    if (id.short) {
      const real = await api.resolveShort(id.short).catch(() => '')
      id = findVideoId(real)
      if (!id || id.short) return { ok: false, message: '短链打不开' }
    }
    const x = await lookAt(id)
    memory?.addEvent?.({ kind: 'seen', meta: { title: x.info.title, author: x.info.author, url: link(x.info.bvid), platform: 'bili', id: x.info.bvid }, text: `看了别人发来的 B 站视频《${x.info.title}》`, tags: ['B站'], importance: 0.4 })
    return {
      ok: true,
      message: x.digest + '\n\n（看完按你自己的性格随口聊最戳你的 1~2 个点就行，像平时跟朋友聊刚刷到的视频那样分短句说，别把全片内容挨个盘点报菜名，也别写总结腔。）',
      bvid: x.info.bvid, aid: x.info.aid, title: x.info.title,
    }
  }

  /** 在某个视频下发评论（主人让她发的）。 */
  async function comment(text, rawMessage) {
    const message = flattenBiliText(cleanOutboundText(atOwner(rawMessage || ''), { warn: (message) => log.warn(`B 站评论：${message}`) })).slice(0, 200)
    if (!message.trim()) return { ok: true, silent: true, message: '本轮保持沉默，未发送评论' }
    const w = await watch(text)
    if (!w.ok) return w
    if (getConfig().dryRun) return { ok: true, message: `试运行：本来要在《${w.title}》下评论：${message}` }
    const r = await api.postComment(w.aid, message)
    memory?.addEvent?.({ text: `在B站《${w.title}》下评论：${String(message).slice(0, 60)}`, tags: ['B站'], importance: 0.45 })
    try { appendVideoInteraction(w.bvid, { title: w.title, comment: { text: message } }) } catch (error) {}
    const s = load(); record(s, { kind: 'comment', title: w.title, bvid: w.bvid, text: message }); save(s)
    return { ok: true, message: `评论发出去了（《${w.title}》）${r?.missed?.length ? `；没找到 ${r.missed.join('、')}，这几个没 @ 上` : ''}` }
  }

  /** 改自己的 B 站签名（权限在模块里查）。 */
  async function setSign(text) {
    const sign = cleanOutboundText(text, { warn: (message) => log.warn(`B 站签名：${message}`) }).trim()
    if (!sign) return { ok: false, message: '签名不能是空的' }
    if ([...sign].length > 70) return { ok: false, message: 'B 站签名最多 70 个字' }
    if (getConfig().dryRun) return { ok: true, message: `试运行：本来要把 B 站签名改成：${sign}` }
    if (!parseCookie(cfg().cookie).bili_jct) return { ok: false, message: '没登录 B 站，改不了签名' }
    await api.setSign(sign)
    memory?.addEvent?.({ text: `把B站签名改成了：${sign.slice(0, 70)}`, tags: ['B站'], importance: 0.35 })
    return { ok: true, message: `B 站签名改好了：${sign}` }
  }

  /** 换 B 站头像。file 是已经过 avatarSource 校验的 http(s) 网址。 */
  async function setAvatar(file) {
    if (!/^https?:\/\//i.test(String(file || ''))) return { ok: false, message: '头像只能用网址图片，或者刚才发的那张图' }
    if (getConfig().dryRun) return { ok: true, message: `试运行：本来要把 B 站头像换成：${file}` }
    if (!parseCookie(cfg().cookie).bili_jct) return { ok: false, message: '没登录 B 站，换不了头像' }
    try {
      await api.setFace(file)
    } catch (error) {
      return { ok: false, message: `B 站头像没换成：${error.message}` }
    }
    memory?.addEvent?.({ text: '换了B站头像', tags: ['B站'], importance: 0.35 })
    return { ok: true, message: 'B 站头像换好了（B 站可能要审核一会儿才显示）' }
  }

  /** 每分钟调一次：醒着的时候按间隔刷、看回复。 */
  async function tick() {
    const g = getConfig()
    const c = g.bili
    if (!g.enabled || !c.enabled) return
    const h = new Date().getHours()
    if (h < g.speakUp.awakeFrom || h >= g.speakUp.awakeTo) return
    const s = today(load())
    if (c.reply && Date.now() - (s.lastReplyCheck || 0) > 20 * 60_000 && (await account()).isLogin) await checkReplies()
    if (c.autoBrowse && s.runs < c.maxRunsPerDay && Date.now() - (s.lastRun || 0) > c.intervalHours * 3600_000) await run()
  }

  return {
    run, checkReplies, watch, comment, setSign, setAvatar, tick, account, sendShot, listShots, recent, video,
    libraryShots, shotFileOf, deleteShot, savedForChat,
    dispose() { stopped = true },
    state: () => {
      const s = today(load())
      return { runs: s.runs, comments: s.comments, replies: s.replies, lastRun: s.lastRun, history: s.history.slice(0, 20), canPost: canPost(s), pauseReason: s.pauseDay === dayKey() ? s.pauseReason : '', vision: visionState(cfg()), shots: { count: shots.count() } }
    },
  }
}
