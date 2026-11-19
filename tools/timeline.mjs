#!/usr/bin/env node
// 排查用的时间线：把一段时间里她「收到什么、想了什么、说了什么、决策层决定了什么、做了什么、想起了什么、哪里报错」
// 按时间排成一条。只读，不改任何数据。在 DSH 所在的那台机器上跑（要读 DSH 数据目录）。
//
//   node tools/timeline.mjs                         最近 3 小时
//   node tools/timeline.mjs --last 30m
//   node tools/timeline.mjs --from "2026-11-19 13:00" --to "2026-11-19 15:00"
//   node tools/timeline.mjs --from 13:00 --to 15:00 --q 蛋糕      只看含「蛋糕」的行
//   node tools/timeline.mjs --src chat,brain,cere           只要某几类（chat brain cere act recall log）
//   node tools/timeline.mjs --full                          不截断
//   node tools/timeline.mjs --show t:3f9a2c1d0e             展开一条决策层留底（行尾 ‹t:…›）
//   node tools/timeline.mjs --show b:2fe0a013#16            展开一条语言层会话记录（行尾 ‹b:…›）
//   node tools/timeline.mjs --home C:\Users\22161\.dsh-bot2  看汐（另一个 DSH）
//   node tools/timeline.mjs --out E:\...\timeline.txt       同时写进文件
//   --logs all   日志里 info 也要（默认只要 warn / error）
//
// 时间按这台机器的本地时区显示。
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const k = a.slice(2)
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
  opt[k] = v
}
const HOME = String(opt.home || process.env.DSH_HOME || join(homedir(), '.dsh'))
const DATA = join(HOME, 'plugins-data', 'aurabot')
const FULL = !!opt.full
const WIDTH = FULL ? Infinity : Number(opt.width) || 160
const SRC = new Set(String(opt.src || 'chat,brain,cere,act,recall,log').split(',').map((s) => s.trim()).filter(Boolean))
const Q = opt.q ? String(opt.q) : ''

function parseWhen(s, base = new Date()) {
  const t = String(s).trim()
  let m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (m) { const d = new Date(base); d.setHours(+m[1], +m[2], +(m[3] || 0), 0); return d.getTime() }
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime()
  const n = Date.parse(t)
  if (Number.isFinite(n)) return n
  throw new Error(`看不懂的时间：${s}`)
}
function parseSpan(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*(m|h|d)$/i)
  if (!m) throw new Error(`--last 要写成 30m / 3h / 1d：${s}`)
  return Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2].toLowerCase()]
}
const now = Date.now()
let TO = opt.to ? parseWhen(opt.to) : now
let FROM = opt.from ? parseWhen(opt.from) : TO - parseSpan(opt.last || '3h')
if (opt.from && !opt.to && opt.last) TO = FROM + parseSpan(opt.last)
if (FROM > TO) [FROM, TO] = [TO, FROM]
const inRange = (t) => Number.isFinite(t) && t >= FROM && t <= TO

const pad = (n) => String(n).padStart(2, '0')
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const days = (() => { const out = []; for (let t = new Date(ymd(FROM) + 'T00:00:00').getTime(); t <= TO; t += 86400e3) out.push(ymd(t)); return [...new Set(out)] })()
const multiDay = days.length > 1
const stamp = (t) => { const d = new Date(t); return `${multiDay ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` : ''}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s, n = WIDTH) => { const t = one(s); return t.length > n ? t.slice(0, n) + `…(${t.length}字)` : t }

function readJsonl(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch (error) { /* 半行（正在写）就跳过 */ }
  }
  return out
}
const readJson = (file, fb) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) { return fb } }

const config = readJson(join(DATA, 'config.json'), {})
const ownerId = String(config.ownerId || config.ownerQQ || '')
const ownerName = String(config.ownerName || '主人')
const who = (chatId) => {
  const id = String(chatId || '')
  if (ownerId && id === `private:${ownerId}`) return '主人私聊'
  if (id.startsWith('group:')) return `群${id.slice(6)}`
  if (id.startsWith('private:')) return `私聊${id.slice(8)}`
  return id
}

// ---------- 各个来源 → { t, tag, text, ref, full } ----------
const rows = []
const push = (r) => { if (inRange(r.t) && one(r.text)) rows.push(r) }

// 聊天流水：真正收发的消息
if (SRC.has('chat')) {
  for (const day of days) {
    for (const r of readJsonl(join(DATA, 'chatlog', `${day}.jsonl`))) {
      const place = who(r.chatId)
      const speaker = r.who === 'bot' ? '她' : r.uid && r.uid === ownerId ? `${ownerName}` : (r.who || '对方')
      push({ t: r.t, tag: `聊天·${place}`, text: `${speaker}：${r.text || ''}${r.forgottenAt ? '（已被要求忘掉）' : ''}` })
    }
  }
}

// 语言层（以前叫大脑）：DSH 会话（收到的完整消息、想法、说的话、工具调用）
const sessionFiles = () => {
  const root = join(HOME, 'sessions')
  if (!existsSync(root)) return []
  const out = []
  for (const ws of readdirSync(root)) {
    const wsDir = join(root, ws)
    let list = []
    try { list = readdirSync(wsDir) } catch (error) { continue }
    for (const s of list) {
      if (!s.startsWith('session-')) continue
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const f = join(wsDir, s, name)
        if (!existsSync(f)) continue
        const st = statSync(f)
        if (st.mtimeMs >= FROM) out.push({ f, id: s.slice('session-'.length), ws })
        break
      }
    }
  }
  return out
}
// DSH 往会话文件里一段一段追加 zstd 帧；Node 的 zstdDecompressSync 只解第一帧，所以按帧头切开逐帧解。
// 帧头字节也可能碰巧出现在压缩数据里：切出来的那段解不开，就并上下一段再试。
function zstdAllFrames(buf) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let i = 0; (i = buf.indexOf(magic, i)) >= 0; i++) starts.push(i)
  const parts = []
  let s = 0
  for (let k = 1; k <= starts.length; k++) {
    const end = k < starts.length ? starts[k] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(starts[s], end)))
      s = k
    } catch (error) {
      if (k === starts.length) throw error
    }
  }
  return Buffer.concat(parts).toString('utf8')
}
function readSession(f) {
  const buf = readFileSync(f)
  const text = f.endsWith('.zstd') ? zstdAllFrames(buf) : buf.toString('utf8')
  return text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch (error) { return null } }).filter(Boolean)
}
const textOf = (content) => (Array.isArray(content) ? content : []).filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n')
const sessions = new Map() // short id → records（给 --show 用）
if (SRC.has('brain') || String(opt.show || '').startsWith('b:')) {
  for (const { f, id } of sessionFiles()) {
    let recs
    try { recs = readSession(f) } catch (error) { rows.push({ t: FROM, tag: '工具', text: `读不了会话 ${id}：${error.message}` }); continue }
    const short = id.slice(0, 8)
    sessions.set(short, recs)
    if (!SRC.has('brain')) continue
    const title = (recs.find((r) => r.type === 'session/title') || {}).data?.title || ''
    const tag = (k) => `语言层·${k}${title ? `·${title}` : ''}`
    // 插进收件箱的消息之后会原样变成 user/message，同一个 id 只留后者
    const userIds = new Set(recs.filter((r) => r.type === 'user/message' && r.data && r.data.id).map((r) => r.data.id))
    for (const r of recs) {
      const t = r.time ?? r.createdAt
      const ref = `b:${short}#${r.seq ?? ''}`
      const d = r.data || {}
      if (r.type === 'session') push({ t, tag: tag('新会话'), text: `${d.agentPreset || r.agentPreset || ''} ${r.cwd || ''}`, ref })
      else if (r.type === 'model/selection') push({ t, tag: tag('模型'), text: `${d.provider}/${d.model}${d.reasoningEffort ? ` effort=${d.reasoningEffort}` : ''}`, ref })
      else if (r.type === 'system/message') push({ t, tag: tag('系统提示'), text: `（${textOf(d.message?.content).length} 字，--show ${ref} 看全文）`, ref })
      else if (r.type === 'agent/inbox/spliced') {
        for (const m of d.inserted || []) if (!userIds.has(m.id)) push({ t, tag: tag('插入'), text: textOf(m.content), ref })
      } else if (r.type === 'user/message') push({ t, tag: tag('收到'), text: textOf(d.content), ref })
      else if (r.type === 'assistant/message') {
        for (const c of d.message?.content || []) {
          if (c.type === 'reasoning') push({ t, tag: tag('想'), text: c.text, ref })
          else if (c.type === 'text') push({ t, tag: tag('说'), text: c.text, ref })
          else if (/tool/i.test(c.type)) push({ t, tag: tag('调工具'), text: `${c.name || c.toolName || ''} ${JSON.stringify(c.input ?? c.arguments ?? c.args ?? '')}`, ref })
        }
      } else if (/tool.*result|result.*tool/i.test(r.type)) {
        const body = d.message?.content ?? d.content ?? d.result ?? d.output ?? d
        push({ t, tag: tag('工具结果'), text: typeof body === 'string' ? body : textOf(body) || JSON.stringify(body), ref })
      } else if (r.type === 'turn/end' && d.reason && d.reason.kind && d.reason.kind !== 'completed') push({ t, tag: tag('本轮结束'), text: JSON.stringify(d.reason), ref })
    }
  }
}

// 决策层（以前叫小脑）：后台模型调用留底
const traces = new Map()
if (SRC.has('cere') || String(opt.show || '').startsWith('t:')) {
  for (const day of days) {
    for (const r of readJsonl(join(DATA, 'traces', `${day}.jsonl`))) {
      traces.set(String(r.id), r)
      if (!SRC.has('cere')) continue
      const key = r.key || one(r.caller).split(' ')[0] || r.kind || '?'
      const out = r.output ?? (Array.isArray(r.attempts) && r.attempts.length ? r.attempts[r.attempts.length - 1].output : '')
      const extra = [r.ms != null ? `${r.ms}ms` : '', r.error ? `❌${r.error}` : ''].filter(Boolean).join(' ')
      push({ t: r.at, tag: `决策层·${key}`, text: `${extra ? `[${extra}] ` : ''}→ ${out || '（无输出）'}`, ref: `t:${r.id}` })
    }
  }
}

// 自主生活：她实际做了什么
if (SRC.has('act')) {
  for (const r of readJsonl(join(DATA, 'modules-data', 'autonomy', 'activity.jsonl'))) {
    const head = `${r.action}${r.topic ? `〔${r.topic}〕` : ''}${r.agendaId ? ` [${r.agendaId}${r.agendaDone === false ? ' 只是准备' : ''}]` : ''}`
    const ops = Array.isArray(r.agenda) && r.agenda.length ? ` ｜改日程：${r.agenda.join('；')}` : ''
    push({ t: r.at, tag: '自主', text: `${head}：${r.why ? `（${r.why}）` : ''}${r.note || r.detail || ''}${r.nextMinutes ? ` ｜${r.nextMinutes} 分钟后再醒` : ''}${ops}` })
  }
}

// 召回：每一轮想起了哪几条记忆
if (SRC.has('recall')) {
  for (const r of readJson(join(DATA, 'recall-log.json'), [])) {
    const shown = new Set(r.shown || [])
    const hits = (r.hits || []).map((h) => `${shown.size && !shown.has(h.id) ? '(没给她)' : ''}#${h.id} ${one(h.text).slice(0, 40)}`).join('；')
    push({ t: r.at, tag: `召回·${who(String(r.where || '').split('（')[0]) || r.where}`, text: `「${one(r.query).slice(0, 60)}」→ ${hits || '（没想起什么）'}` })
  }
}

// 日志：默认只要 warn / error
if (SRC.has('log')) {
  const all = opt.logs === 'all'
  for (const day of days) {
    const f = join(DATA, 'logs', `aurabot-${day}.log`)
    if (!existsSync(f)) continue
    let cur = null
    const flush = () => { if (cur && (all || cur.level !== 'info' && cur.level !== 'debug')) push(cur) }
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \[(\w+)\] \[([^\]]*)\] (.*)$/)
      if (m) { flush(); cur = { t: parseWhen(`${m[1]} ${m[2]}`), level: m[3], tag: `日志·${m[3]}·${m[4]}`, text: m[5] } } else if (cur && line.trim()) cur.text += ' ' + line.trim()
    }
    flush()
  }
}

// ---------- 输出 ----------
const lines = []
const say = (s) => lines.push(s)

if (opt.show) {
  const ref = String(opt.show)
  if (ref.startsWith('t:')) {
    const r = traces.get(ref.slice(2))
    if (!r) say(`没找到留底 ${ref}（看看日期范围是否覆盖它：--from / --to）`)
    else {
      const { system, input, output, reasoning, attempts, ...meta } = r
      say(`== 决策层留底 ${ref}  ${stamp(r.at)}`)
      say(JSON.stringify(meta, null, 1))
      if (system) say(`\n--- system ---\n${system}`)
      if (input) say(`\n--- input ---\n${input}`)
      if (reasoning) say(`\n--- reasoning ---\n${reasoning}`)
      if (output) say(`\n--- output ---\n${output}`)
      if (Array.isArray(attempts) && attempts.length > 1) say(`\n--- attempts ---\n${JSON.stringify(attempts, null, 1)}`)
    }
  } else if (ref.startsWith('b:')) {
    const [short, seq] = ref.slice(2).split('#')
    const recs = sessions.get(short)
    const r = recs && recs.find((x) => String(x.seq) === seq)
    if (!r) say(`没找到会话记录 ${ref}（会话文件要在 --from 之后改过才会被读到）`)
    else {
      say(`== 语言层会话 ${ref}  ${stamp(r.time)}  ${r.type}`)
      const content = r.data?.message?.content || r.data?.content || r.data?.inserted?.flatMap((m) => m.content) || null
      if (Array.isArray(content)) for (const c of content) say(`\n--- ${c.type} ---\n${c.text ?? JSON.stringify(c, null, 1)}`)
      else say(JSON.stringify(r.data, null, 1))
    }
  } else say('--show 要写成 t:<留底 id> 或 b:<会话前 8 位>#<seq>')
} else {
  rows.sort((a, b) => a.t - b.t)
  const shown = Q ? rows.filter((r) => `${r.tag} ${r.text}`.includes(Q)) : rows
  say(`== ${HOME}  ${stamp(FROM)} → ${stamp(TO)}  共 ${shown.length} 行${Q ? `（含「${Q}」）` : ''}  来源：${[...SRC].join(',')}`)
  for (const r of shown) say(`${stamp(r.t)}  [${r.tag}] ${clip(r.text)}${r.ref ? `  ‹${r.ref}›` : ''}`)
}

const out = lines.join('\n')
if (opt.out) writeFileSync(String(opt.out), out + '\n', 'utf8')
process.stdout.write(out + '\n')
