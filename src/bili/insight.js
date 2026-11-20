// 看视频时的「读法」：把字幕 / 转写、弹幕、画面指标整理成她能读的几行。全是纯函数，不碰网络。
//
// 思路参考 CZX2244/dsh-bilibili（MIT）：按画面变化挑帧、在附近挑最清楚的一帧、弹幕看密度峰值。
// 和它不同的地方：弹幕峰值按全片算（它只取前 200 条，峰值总落在开头）；画面另外算「剪辑节奏」和「动得多不多」；
// 截图候选里优先放弹幕最热闹的时刻（观众反应最大的地方往往就是看点）。

/** 秒 → m:ss（一小时以上 h:mm:ss）。 */
export function clock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const decodeXml = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')

/** B 站弹幕 XML → [{ t, text }]，按时间排好。 */
export function parseDanmakuXml(xml) {
  const out = []
  const re = /<d p="([^"]*)">([\s\S]*?)<\/d>/g
  let m
  while ((m = re.exec(String(xml || '')))) {
    const t = Number.parseFloat(m[1].split(',')[0])
    const text = decodeXml(m[2]).trim()
    if (Number.isFinite(t) && text) out.push({ t, text })
  }
  return out.sort((a, b) => a.t - b.t)
}

// 「哈哈哈哈哈哈」「哈哈哈」算一种；全角半角问号感叹号统一
const normDm = (s) => String(s).replace(/[？]/g, '?').replace(/[！]/g, '!').replace(/(.)\1{2,}/gu, '$1$1$1').trim()

function topTexts(list, n) {
  const count = new Map()
  for (const d of list) { const k = normDm(d.text); count.set(k, (count.get(k) || 0) + 1) }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([text, n]) => ({ text, n }))
}

/**
 * 弹幕读法：总数、刷得最多的几句、最热闹的几个时刻（每段 10 秒，按全片算，开头 5 秒不算——那是「来了」「第一」）。
 * 返回 { total, top:[{text,n}], peaks:[{at, n, texts:[...]}] }
 */
export function danmakuInsight(entries, duration = 0, { peaks: maxPeaks = 3, win = 10 } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const total = list.length
  if (!total) return { total: 0, top: [], peaks: [] }
  const top = topTexts(list, 8).filter((x) => x.n >= 2).slice(0, 6)
  const end = Math.max(Number(duration) || 0, list[list.length - 1].t)
  const buckets = new Array(Math.max(1, Math.ceil(end / win))).fill(0)
  for (const d of list) buckets[Math.min(buckets.length - 1, Math.floor(d.t / win))]++
  const mean = total / buckets.length
  const order = buckets.map((n, i) => ({ i, n })).filter((b) => b.i * win >= Math.min(30, end * 0.05)).sort((a, b) => b.n - a.n)
  const peaks = []
  for (const b of order) {
    if (peaks.length >= maxPeaks) break
    if (b.n < Math.max(8, mean * 2.5)) break
    if (peaks.some((p) => Math.abs(p.i - b.i) * win < 30)) continue
    const inWin = list.filter((d) => d.t >= b.i * win && d.t < (b.i + 1) * win)
    peaks.push({ i: b.i, at: b.i * win, n: b.n, texts: topTexts(inWin, 3).map((x) => x.text) })
  }
  return { total, top, peaks: peaks.sort((a, b) => a.at - b.at).map(({ i, ...p }) => p) }
}

/** ffmpeg metadata=print 的输出 → [{ t, scene, blur, ydif }]。 */
export function parseFrameMetrics(text) {
  const out = []
  let cur = null
  for (const line of String(text || '').split('\n')) {
    const t = /pts_time:([\d.]+)/.exec(line)
    if (t) { cur = { t: Number.parseFloat(t[1]), scene: 0, blur: NaN, ydif: NaN }; out.push(cur); continue }
    if (!cur) continue
    const s = /lavfi\.scene_score=([\d.]+)/.exec(line)
    if (s) { cur.scene = Number.parseFloat(s[1]); continue }
    const b = /lavfi\.blur=([\d.]+)/.exec(line)
    if (b) { cur.blur = Number.parseFloat(b[1]); continue }
    const y = /lavfi\.signalstats\.YDIF=([\d.]+)/.exec(line)
    if (y) cur.ydif = Number.parseFloat(y[1])
  }
  return out
}

const median = (xs) => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y)
  return a.length ? a[Math.floor(a.length / 2)] : 0
}

export const CUT_SCENE = 0.3

/**
 * 画面读法：镜头切换（scene > 0.3，间隔至少 1 秒）、平均镜头长度、动得多不多（镜头内相邻帧的亮度差中位数）、
 * 几乎不动的画面占比。metrics 来自每 0.5 秒一帧、320 宽的分析。
 */
export function visualInsight(metrics, duration = 0) {
  const ms = Array.isArray(metrics) ? metrics : []
  if (ms.length < 4) return null
  const cuts = []
  for (const m of ms) if (m.scene > CUT_SCENE && (!cuts.length || m.t - cuts[cuts.length - 1] >= 1)) cuts.push(m.t)
  const inside = ms.filter((m) => m.scene <= CUT_SCENE && m.t > 0)
  const motion = median(inside.map((m) => m.ydif))
  const still = inside.length ? inside.filter((m) => m.ydif < 0.6).length / inside.length : 0
  const span = Math.max(Number(duration) || 0, ms[ms.length - 1].t)
  const shots = cuts.length + 1
  return { cuts, shots, avgShot: span / shots, motion, still, span }
}

/** 给她看的一句：「镜头切换 42 次（平均 7 秒一个），画面动得挺多」。档位按 2026-11-20 实测校准：PPT 4、对谈 8、解说 11、vlog / MC 实况 23~24、舞蹈 36。 */
export function visualLine(v) {
  if (!v) return ''
  const pace = v.avgShot >= 30 ? '几乎是一镜到底' : `镜头切换 ${v.shots - 1} 次（平均 ${v.avgShot < 10 ? v.avgShot.toFixed(1) : Math.round(v.avgShot)} 秒一个）`
  const move = v.still >= 0.7 ? '画面大多是静止的（像幻灯片、静态图或固定机位讲话）'
    : v.motion < 3 ? '画面几乎不怎么动'
      : v.motion < 10 ? '画面动得不多（像讲话、PPT、对谈）'
        : v.motion < 25 ? '画面动得挺多（像 vlog、解说、游戏实况）'
          : '画面动作很大（像舞蹈、运动、激烈的游戏）'
  return `${pace}，${move}`
}

/**
 * 挑截图时间点：分成 n 段，每段优先放弹幕高峰，其次放这段里最大的那次镜头切换（切换后 0.8 秒，落在新镜头里），
 * 都没有就取段中间；再在 ±1 秒、同一个镜头内挑最清楚的一帧（blur 最小）。时间点至少隔 3 秒。
 */
export function pickFrameTimes({ metrics = [], duration = 0, n = 6, peaks = [] } = {}) {
  const span = Math.max(Number(duration) || 0, metrics.length ? metrics[metrics.length - 1].t : 0)
  if (!(span > 0)) return []
  const count = Math.max(1, Math.min(12, Math.round(n)))
  const lo = span * 0.03
  const hi = span * 0.97
  const step = (hi - lo) / count
  const cutsAll = metrics.filter((m) => m.scene > CUT_SCENE)
  const picks = []
  for (let k = 0; k < count; k++) {
    const a = lo + k * step
    const b = a + step
    const peak = peaks.find((p) => p.at + 5 >= a && p.at + 5 < b)
    let t
    if (peak) t = peak.at + 5
    else {
      const cut = cutsAll.filter((m) => m.t >= a && m.t < b - 1).sort((x, y) => y.scene - x.scene)[0]
      t = cut ? Math.min(cut.t + 0.8, span - 0.5) : (a + b) / 2
    }
    picks.push(refineSharp(metrics, t))
  }
  const out = []
  for (const t of picks.sort((x, y) => x - y)) if (!out.length || t - out[out.length - 1] >= 3) out.push(Math.round(t * 10) / 10)
  return out
}

/** 在 t ± 1 秒内、不跨镜头切换，挑 blur 最小的那一帧的时间；没指标就原样返回。 */
export function refineSharp(metrics, t, half = 1) {
  const near = metrics.filter((m) => Math.abs(m.t - t) <= half && Number.isFinite(m.blur))
  if (!near.length) return t
  // 同一个镜头：t 前后最近的切换之间
  const before = metrics.filter((m) => m.scene > CUT_SCENE && m.t <= t).pop()
  const after = metrics.find((m) => m.scene > CUT_SCENE && m.t > t)
  const same = near.filter((m) => (!before || m.t >= before.t) && (!after || m.t < after.t))
  const pool = same.length ? same : near
  return pool.slice().sort((x, y) => x.blur - y.blur)[0].t
}

/** t 时刻在说的那句（覆盖 t 的，或 3 秒内最近的）。 */
export function lineAt(segments, t) {
  const segs = Array.isArray(segments) ? segments : []
  const hit = segs.find((s) => s.start <= t && t <= s.end)
  if (hit) return hit.text
  let best = null
  let dist = 3
  for (const s of segs) {
    const d = Math.min(Math.abs(s.start - t), Math.abs(s.end - t))
    if (d < dist) { dist = d; best = s }
  }
  return best ? best.text : ''
}

/**
 * 字幕 / 转写截给她看：够短就全给（每 30 秒左右标一次时间）；太长就在全片均匀取几段，每段开头标时间，段之间用「……」。
 */
export function transcriptExcerpt(segments, budget = 2500, { pieces = 5 } = {}) {
  const segs = (Array.isArray(segments) ? segments : []).filter((s) => s && s.text)
  if (!segs.length) return ''
  const join = (list) => {
    let out = ''
    let mark = -Infinity
    for (const s of list) {
      if (s.start - mark >= 30) { out += (out ? ' ' : '') + `[${clock(s.start)}] `; mark = s.start }
      else out += ' '
      out += s.text
    }
    return out.trim()
  }
  const full = join(segs)
  if (full.length <= budget) return full
  const per = Math.floor(budget / pieces) - 12
  const parts = []
  for (let k = 0; k < pieces; k++) {
    const startIdx = Math.floor((segs.length * k) / pieces)
    const take = []
    let len = 0
    for (let i = startIdx; i < segs.length && len < per; i++) { take.push(segs[i]); len += segs[i].text.length + 1 }
    let txt = join(take)
    if (txt.length > per + 12) txt = txt.slice(0, per + 12) + '…'
    parts.push(txt)
  }
  return parts.join(' …… ')
}

/** 字幕和视频对不对得上：最后一句比视频长出 20 秒以上，多半是别的视频的字幕（B 站接口偶尔串）。 */
export function subtitleFits(segments, duration) {
  const segs = Array.isArray(segments) ? segments : []
  if (!segs.length) return false
  const d = Number(duration) || 0
  if (!d) return true
  const last = segs[segs.length - 1].end || segs[segs.length - 1].start
  return last <= d + 20
}
