// 看过的视频存一份完整内容（字幕 / 转写全文、画面、弹幕、评论区、链接），聊天里聊到细节时用工具翻，
// 不往聊天会话里整段塞。一个视频一个文件，保留 14 天、最多 200 个。

import { readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, readJson, writeJson, existsSync } from '../core/store.js'
import { clock, visualLine, commentLines } from './insight.js'

const KEEP_MS = 14 * 86_400_000
const KEEP_MAX = 200
const PAGE_CHARS = 3000
const dir = () => dataDir('bili-videos')
const fileOf = (bvid) => join(dir(), `${String(bvid).replace(/[^0-9A-Za-z]/g, '')}.json`)
const SOURCE_LABEL = { subtitle: '字幕', ai: 'B 站 AI 字幕', asr: '语音转写（机器识别，可能有错字）' }

function prune() {
  let files = []
  try {
    files = readdirSync(dir()).filter((f) => f.endsWith('.json')).map((f) => ({ f, at: statSync(join(dir(), f)).mtimeMs }))
  } catch (error) {
    return
  }
  files.sort((a, b) => b.at - a.at)
  files.forEach((x, i) => {
    if (i >= KEEP_MAX || Date.now() - x.at > KEEP_MS) rmSync(join(dir(), x.f), { force: true })
  })
}

/** 存 / 更新一个视频（按 bvid 合并）。 */
export function saveVideo(rec) {
  if (!rec || !rec.bvid) return
  const old = readJson(fileOf(rec.bvid), null) || {}
  writeJson(fileOf(rec.bvid), { ...old, ...rec, savedAt: Date.now() })
  prune()
}

/** 按 BV 号或标题里的词找：BV 号直接取，标题词在最近的里面从新到旧找第一个。 */
export function findVideo(query) {
  const q = String(query || '').trim()
  const bv = q.match(/BV[0-9A-Za-z]{10}/)
  if (bv) return readJson(fileOf(bv[0]), null)
  let files = []
  try {
    files = readdirSync(dir()).filter((f) => f.endsWith('.json')).map((f) => ({ f, at: statSync(join(dir(), f)).mtimeMs })).sort((a, b) => b.at - a.at)
  } catch (error) {
    return null
  }
  for (const { f } of files) {
    const rec = readJson(join(dir(), f), null)
    if (rec && (!q || String(rec.title || '').includes(q))) return rec
  }
  return null
}

export function hasVideo(bvid) {
  return existsSync(fileOf(bvid))
}

/** 是否有存过的视频档案（给只读聊天工具判定用）。 */
export function hasAnyVideos() {
  try {
    return readdirSync(dir()).some((f) => f.endsWith('.json'))
  } catch (error) {
    return false
  }
}

/** 把她在这个视频下的点赞、评论、楼中楼互动记进同一份档案，消除记忆断层。 */
export function appendVideoInteraction(bvid, { title = '', comment = null, reply = null, liked = false } = {}) {
  if (!bvid) return
  const old = readJson(fileOf(bvid), null) || { bvid, title: String(title || '').slice(0, 120), url: `https://www.bilibili.com/video/${bvid}` }
  const next = { ...old, savedAt: Date.now() }
  if (title && !next.title) next.title = String(title).slice(0, 120)
  if (liked) next.liked = true
  if (comment && comment.text) {
    const list = Array.isArray(old.myComments) ? old.myComments.slice() : []
    list.unshift({ at: Date.now(), text: String(comment.text).slice(0, 200), ...(comment.replyTo ? { replyTo: String(comment.replyTo).slice(0, 40) } : {}) })
    next.myComments = list.slice(0, 20)
  }
  if (reply && reply.myReply) {
    const list = Array.isArray(old.myReplies) ? old.myReplies.slice() : []
    list.unshift({ at: Date.now(), who: String(reply.who || '').slice(0, 40), theySaid: String(reply.theySaid || '').slice(0, 140), myReply: String(reply.myReply).slice(0, 200) })
    next.myReplies = list.slice(0, 20)
  }
  writeJson(fileOf(bvid), next)
}

/** 字幕 / 转写排成带时间的行（约 20 秒一行），再按字数分页。 */
function transcriptPages(rec) {
  // 字幕一两秒一句：每 20 秒左右并成一行，标一次时间
  const lines = []
  if (Array.isArray(rec.segments) && rec.segments.length) {
    let start = null
    let buf = []
    for (const s of rec.segments) {
      if (start === null) start = s.start
      if (s.start - start >= 20 && buf.length) {
        lines.push(`[${clock(start)}] ${buf.join(' ')}`)
        start = s.start
        buf = []
      }
      buf.push(s.text)
    }
    if (buf.length) lines.push(`[${clock(start)}] ${buf.join(' ')}`)
  } else if (rec.plain) lines.push(String(rec.plain))
  const pages = []
  let cur = ''
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > PAGE_CHARS) {
      pages.push(cur)
      cur = ''
    }
    cur += (cur ? '\n' : '') + line
  }
  if (cur) pages.push(cur)
  return pages
}

/** 给她看的完整内容：第 1 页带简介、画面、弹幕、评论区；字幕按页给，告诉她一共几页。 */
export function videoText(rec, page = 1) {
  const pages = transcriptPages(rec)
  const n = Math.max(1, Math.min(pages.length || 1, Math.round(Number(page) || 1)))
  const fmtAt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '')
  const myComments = Array.isArray(rec.myComments) ? rec.myComments : []
  const myReplies = Array.isArray(rec.myReplies) ? rec.myReplies : []
  const head = [
    `《${rec.title}》 UP主：${rec.author || '?'}${rec.duration ? '  时长 ' + clock(rec.duration) : ''}  播放 ${rec.play || 0}${rec.tname ? '  分区：' + rec.tname : ''}`,
    `链接：${rec.url}`,
    rec.watchedAt ? `你看的时间：${fmtAt(rec.watchedAt)}${rec.liked ? '（点过赞）' : ''}` : (rec.liked ? '你给这个视频点过赞' : ''),
    rec.feeling ? `你当时的感受：${rec.feeling}` : '',
    myComments.length ? '你在这个视频下评过：\n' + myComments.slice(0, 5).map((c) => `  - ${fmtAt(c.at)} ${c.replyTo ? `回复 @${c.replyTo}：` : ''}${c.text}`).join('\n') : '',
    myReplies.length ? '你和网友的楼中楼互动：\n' + myReplies.slice(0, 5).map((r) => `  - ${fmtAt(r.at)} ${r.who} 说「${r.theySaid}」→ 你回「${r.myReply}」`).join('\n') : '',
  ]
  const extra = n === 1 ? [
    rec.desc ? `简介：${rec.desc}` : '',
    rec.visual ? `画面节奏：${visualLine(rec.visual)}` : '',
    rec.vision ? `画面（抽帧）：${rec.vision}` : '',
    rec.danmaku && rec.danmaku.total ? `弹幕：共 ${rec.danmaku.total} 条${rec.danmaku.top?.length ? '；刷得最多的：' + rec.danmaku.top.slice(0, 5).map((x) => `「${x.text}」×${x.n}`).join(' ') : ''}` : '',
    rec.danmaku?.peaks?.length ? '弹幕最热闹的时刻：' + rec.danmaku.peaks.map((p) => `${clock(p.at)}（${p.texts.map((t) => '「' + t + '」').join('')}）`).join('；') : '',
    rec.comments?.length ? '评论区：\n' + commentLines(rec.comments, 10).join('\n') : '',
  ] : []
  const body = pages.length
    ? `${SOURCE_LABEL[rec.source] || '字幕'}（第 ${n} / ${pages.length} 页）：\n${pages[n - 1]}${n < pages.length ? `\n（还有 ${pages.length - n} 页，要看就带上 page=${n + 1}）` : ''}`
    : '（这个视频没有字幕，也没转写出来）'
  return [...head, ...extra, body].filter(Boolean).join('\n')
}
