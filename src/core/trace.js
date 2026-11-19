// 小脑留底：后台每一次模型调用都记一行完整记录（发了什么、模型原样回了什么、思考、结束原因、用量、耗时、报错），
// 排查「她当时看到了什么、为什么这么决定、为什么返回空」用。
// 三个入口会写：core/llm.js 的 askModel、扩展模块自己直接调模型的地方（如 autonomy 的 ask）、hub.runSystemTurn（后台会话一轮）。
// 只存本机：plugins-data/aurabot/traces/YYYY-MM-DD.jsonl，按天一个文件，默认留 7 天。写失败不影响调用方。
import { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir, ensureDir } from './store.js'

let options = () => ({ trace: true, traceDays: 7 })

/** 宿主启动时接上配置（config.debug）：{ trace: 开关, traceDays: 留几天 } */
export function setTraceOptions (fn) {
  if (typeof fn === 'function') options = fn
}

function opts () {
  try { return options() || {} } catch (error) { return {} }
}

export const traceEnabled = () => opts().trace !== false

const pad = (n) => String(n).padStart(2, '0')
/** 本地日期 YYYY-MM-DD（和 chatlog 一样按本机时区分天） */
export function traceDay (t = Date.now()) {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const traceDir = () => dataDir('traces')

let prunedFor = ''
function prune (dir, day) {
  if (prunedFor === day) return
  prunedFor = day
  const keep = Math.max(1, Math.round(Number(opts().traceDays) || 7))
  const cutoff = traceDay(Date.now() - (keep - 1) * 86400_000)
  try {
    for (const f of readdirSync(dir)) if (FILE.test(f) && f.slice(0, 10) < cutoff) unlinkSync(join(dir, f))
  } catch (error) {}
}

export const newTraceId = () => randomUUID().replace(/-/g, '').slice(0, 10)

const SKIP_FN = new Set(['writeTrace', 'callerOf', 'askModel', 'runStream', 'ask', 'runSystemTurn', 'runSystemTurnInner', 'Object.think', 'think', 'value'])

/**
 * 从调用栈认出是谁发起的这次调用（不用每个调用点都传 key）：返回「函数名 @ 文件:行」，
 * 跳过留底本身和几层通用包装（askModel / ask / runSystemTurn ……）。
 */
export function callerOf (extraSkip = []) {
  const skip = new Set([...SKIP_FN, ...extraSkip])
  const lines = String(new Error().stack || '').split('\n').slice(1)
  for (const line of lines) {
    const m = line.match(/^\s*at\s+(?:async\s+)?(?:(.+?)\s+\()?(.+?):(\d+):\d+\)?\s*$/)
    if (!m) continue
    const fn = (m[1] || '').replace(/^async\s+/, '')
    const file = m[2]
    if (/node:|internal\//.test(file) || /[\\/]trace\.js$/.test(file)) continue
    // 「Object.value [as runSystemTurn]」这类转发层：按 as 后面的名字认，一样跳过
    const alias = (fn.match(/\[as ([^\]]+)\]/) || [])[1] || ''
    const base = fn.replace(/\s*\[as [^\]]+\]/, '')
    const short = base.split('.').pop()
    if (skip.has(fn) || skip.has(base) || skip.has(short) || (alias && skip.has(alias))) continue
    return `${base || '(匿名)'} @ ${basename(file.replace(/^file:\/+/, ''))}:${m[3]}`
  }
  return ''
}

/**
 * 写一行留底。entry 里放什么都行，常用字段：
 *   kind  'ask'（无状态单次调用）| 'system-turn'（后台会话一轮）
 *   key   用途（plan / wake / web-pick / hold / memory-extract ……），caller 自动认出来的调用位置
 *   provider / model / system / input / output / reasoning / finish / usage / ms / error / attempts
 * @returns {string|null} 这条的 id
 */
export function writeTrace (entry) {
  if (!traceEnabled()) return null
  try {
    const dir = ensureDir(traceDir())
    const at = Number(entry && entry.at) || Date.now()
    const day = traceDay(at)
    prune(dir, day)
    const rec = { id: (entry && entry.id) || newTraceId(), at, time: new Date(at).toLocaleString('zh-CN', { hour12: false }), ...entry }
    rec.at = at
    appendFileSync(join(dir, `${day}.jsonl`), JSON.stringify(rec) + '\n', 'utf8')
    return rec.id
  } catch (error) {
    return null
  }
}

const LONG = ['system', 'input', 'output', 'reasoning']
function clipRecord (r, n) {
  const out = { ...r }
  for (const k of LONG) if (typeof out[k] === 'string' && out[k].length > n) out[k] = out[k].slice(0, n) + `…（共 ${out[k].length} 字）`
  if (Array.isArray(out.attempts)) {
    out.attempts = out.attempts.map((a) => {
      const b = { ...a }
      for (const k of ['output', 'reasoning']) if (typeof b[k] === 'string' && b[k].length > n) b[k] = b[k].slice(0, n) + `…（共 ${b[k].length} 字）`
      return b
    })
  }
  return out
}

/**
 * 查留底。q：{ day?: 'YYYY-MM-DD'（默认今天）, key?: 用途/调用位置里包含的字, q?: 全文包含的字, id?, limit?: 默认 30, full?: '1' 不截断 }
 * 新的在前。
 */
export function readTraces (q = {}) {
  const dir = traceDir()
  const days = existsSync(dir) ? readdirSync(dir).filter((f) => FILE.test(f)).map((f) => f.slice(0, 10)).sort().reverse() : []
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(q.day || '')) ? String(q.day) : traceDay()
  const f = join(dir, `${day}.jsonl`)
  let list = []
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { list.push(JSON.parse(line)) } catch (error) {}
    }
  }
  if (q.id) list = list.filter((r) => r.id === String(q.id))
  if (q.key) {
    const k = String(q.key)
    list = list.filter((r) => String(r.key || '').includes(k) || String(r.caller || '').includes(k) || String(r.kind || '') === k)
  }
  if (q.q) {
    const s = String(q.q)
    list = list.filter((r) => JSON.stringify(r).includes(s))
  }
  const total = list.length
  const limit = Math.max(1, Math.min(500, Math.round(Number(q.limit) || 30)))
  list = list.slice(-limit).reverse()
  const full = q.full === '1' || q.full === true || q.id
  return { enabled: traceEnabled(), day, days, total, entries: full ? list : list.map((r) => clipRecord(r, 400)) }
}
