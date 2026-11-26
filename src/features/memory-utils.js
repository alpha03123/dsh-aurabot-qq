// 记忆模块纯逻辑工具：切词、相似度、倒排索引与 BM25 检索、时间/有效期解析、遗忘衰减与模型输出解析。
import { clipText } from '../core/text.js'

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const RELATED_MIN_SCORE = 0.8
export const RELATED_LIMIT = 6
export const SEEN_META_LIMITS = { title: 160, author: 80, url: 500, platform: 40, id: 100 }

export const validFromOf = (m) => m.validFrom ?? saidTime(m)
export const validUntilOf = (m) => m.validUntil ?? m.invalidAt
export const isCurrent = (m, now = Date.now()) => !m.invalidAt && (!validUntilOf(m) || validUntilOf(m) > now) && (!validFromOf(m) || validFromOf(m) <= now)

/** 只接受明确的日期或相对于说话时间明确的年月；模糊时间留空。 */
export function parseValidityDate(value, reference = Date.now()) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined
  const text = String(value || '').trim()
  const ref = new Date(reference)
  const relative = text.match(/^(去年|今年|上个月|本月|这个月)(?:(\d{1,2})月)?(?:(\d{1,2})日?)?$/)
  if (relative) {
    const [, word, month, day] = relative
    if (/月/.test(word) && month) return undefined
    const year = ref.getFullYear() - (word === '去年' ? 1 : 0)
    const mon = month ? Number(month) - 1 : /月/.test(word) ? ref.getMonth() - (word === '上个月' ? 1 : 0) : 0
    const date = new Date(year, mon, Number(day) || 1)
    if ((month && (Number(month) < 1 || Number(month) > 12)) || (day && date.getDate() !== Number(day))) return undefined
    return date.getTime()
  }
  const m = text.replace(/年|月/g, '-').replace(/日$/, '').replace(/-$/, '').match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/)
  if (!m) return undefined
  const year = Number(m[1]), month = Number(m[2] || 1), day = Number(m[3] || 1)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : undefined
}

/** 时间范围沿用 whenText 的今年/去年判断，给召回和面板同一个显示结果。 */
export function validityText(m, now = Date.now()) {
  if (m.source === 'event' || m.source === 'diary') return ''
  const month = (at) => {
    const d = new Date(at)
    const when = whenText(at, now)
    const year = d.getFullYear() === new Date(now).getFullYear() ? '今年' : when.startsWith('去年') ? '去年' : `${d.getFullYear()}年`
    return `${year}${d.getMonth() + 1}月`
  }
  // 开始时间就是说话那天的不标，不然每条都带「今年X月起」，白占字数
  const from = Math.abs(validFromOf(m) - (saidTime(m) || 0)) > 86400_000 ? validFromOf(m) : 0
  const until = validUntilOf(m)
  return [from ? month(from) + '起' : '', until ? '到' + month(until) : ''].filter(Boolean).join('，')
}

export function eventText(m) {
  return m.kind === 'seen' ? `看过《${m.meta?.title || m.text || '未命名内容'}》${m.meta?.author ? `（${m.meta.author}）` : ''}` : m.text
}

export function seenMeta(meta) {
  return Object.fromEntries(Object.entries(SEEN_META_LIMITS).flatMap(([key, limit]) => {
    const value = typeof meta?.[key] === 'string' || typeof meta?.[key] === 'number' ? String(meta[key]).trim().slice(0, limit) : ''
    return value ? [[key, value]] : []
  }))
}

/** 精确年月按区间重叠检索；「以前 / 那时候」没有日期时只放宽到过去。 */
export function pastWindow(query, now = Date.now(), triggers = []) {
  const text = String(query || '')
  const hit = text.match(/(?:\d{4}年|去年|前年|今年)(?:\d{1,2}月)?|上个月|上月|昨天|前天/)
  if (hit) {
    const word = hit[0]
    const n = new Date(now)
    let start, end
    if (/昨天|前天/.test(word)) {
      start = new Date(n.getFullYear(), n.getMonth(), n.getDate() - (word === '昨天' ? 1 : 2)).getTime()
      end = start + 86400_000
    } else {
      start = word === '前年' ? new Date(n.getFullYear() - 2, 0, 1).getTime() : parseValidityDate(word === '上月' ? '上个月' : word, now)
      if (!start) return null
      const d = new Date(start)
      end = /月/.test(word) ? new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() : new Date(d.getFullYear() + 1, 0, 1).getTime()
    }
    return { start, end: Math.min(end, now + 1) }
  }
  return [...triggers.filter((word) => /上次|上回|之前|以前|那天|那次|那时候|过去|曾经/.test(word)), '以前', '那时候', '过去', '之前'].some((word) => word && text.includes(word)) ? { start: -Infinity, end: now + 1 } : null
}

/** 所有删除、遗忘、过时和容量清理都在保存时收拾引用。 */
export function cleanRelated(items) {
  const active = new Map(items.filter((m) => isCurrent(m) && m.kind !== 'seen').map((m) => [m.id, m]))
  for (const m of items) {
    if (!Array.isArray(m.related)) continue
    m.related = [...new Set(m.related)].filter((id) => id !== m.id && active.has(m.id) && active.get(id)?.related?.includes(m.id)).slice(0, RELATED_LIMIT)
  }
  for (const m of items) if (m.related) m.related = m.related.filter((id) => active.get(id)?.related?.includes(m.id))
}

// ---------------- 纯函数：切词与打分 ----------------

const STOP = new Set('的了是我你他她它们在有和就不也都很吗吧呢啊呀哦嗯这那个一上下来去说要会能着过'.split(''))
const NOISE = new Set('哈呵嘿嘻嗯哦啊呀吗呢吧'.split(''))

/** 切词：英文/数字整词；中文连续段拆成二元字组（单字段保留单字，去掉停用字）。 */
export function tokenize(text) {
  const out = []
  const s = String(text || '').toLowerCase()
  for (const m of s.matchAll(/[a-z0-9_]{2,}|[一-鿿]+/g)) {
    const w = m[0]
    if (/^[a-z0-9_]+$/.test(w)) { out.push(w); continue }
    if (w.length === 1) { if (!STOP.has(w)) out.push(w); continue }
    for (let i = 0; i < w.length - 1; i++) {
      const pair = w.slice(i, i + 2)
      if (!(NOISE.has(pair[0]) && NOISE.has(pair[1]))) out.push(pair)
    }
  }
  return out
}

/** 两段文字有多像（字组 Jaccard），用于去重。 */
export function similarity(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/** 字面很像但说的不是一回事：否定词个数不同、数字不同，或者两句中间各有一段不一样（北京 / 上海、周六 / 周日）。 */
export function conflicting(a, b) {
  const x = String(a)
  const y = String(b)
  const count = (s) => (s.match(/[不没未别无非]/g) || []).length
  if (count(x) !== count(y)) return true
  const nums = (s) => (s.match(/\d+/g) || []).join(',')
  if (nums(x) && nums(y) && nums(x) !== nums(y)) return true
  let head = 0
  while (head < x.length && head < y.length && x[head] === y[head]) head++
  let tail = 0
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++
  return x.length - head - tail >= 1 && y.length - head - tail >= 1
}

/** 能不能当成同一条记忆合并。 */
export const sameFact = (a, b) => similarity(a, b) >= 0.6 && !conflicting(a, b)

/** 建索引：返回 { docs, df, avgLen }。 */
export function buildIndex(items) {
  const df = new Map()
  const docs = items.map((it) => {
    const toks = tokenize(`${it.text} ${it.kind === 'seen' ? `${it.meta?.title || ''} ${it.meta?.author || ''}` : ''} ${(it.tags || []).join(' ')} ${it.aboutName || ''}`)
    const tf = new Map()
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1)
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1)
    return { it, tf, len: toks.length || 1 }
  })
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1)
  return { docs, df, avgLen, N: docs.length }
}

/**
 * 检索。
 * @param idx buildIndex() 的结果
 * @param {string} query
 * @param {{about?:string|string[], now?:number, limit?:number, minScore?:number, includeInvalid?:boolean, period?:{start:number,end:number}|null, related?:boolean, vectorHits?:{id:string, similarity:number}[], ownerScope?:boolean, scopeChatId?:string}} [o]
 *   about：关于这些人（QQ 号）的记忆加分；群里可以传这一段里所有说话的人
 *   ownerScope：true/不传 = 主人视角，可以看到所有来源（面板、内部整理、主人私聊）；
 *     false = 社交视角（群聊 / 非主人私聊），普通记忆只保留 chatId === scopeChatId 的条目。
 *   scopeChatId：社交视角下的当前聊天 id（private:QQ / group:群号）。
 */
export function search(idx, query, o = {}) {
  const q = [...new Set(tokenize(query))]
  const now = o.now ?? Date.now()
  const aboutSet = new Set((Array.isArray(o.about) ? o.about : o.about ? [o.about] : []).map(String))
  const excludeSet = new Set((Array.isArray(o.excludeAbout) ? o.excludeAbout : o.excludeAbout ? [o.excludeAbout] : []).map(String))
  const onlyAbout = o.onlyAbout
    ? new Set((Array.isArray(o.onlyAbout) ? o.onlyAbout : [o.onlyAbout]).map(String))
    : null
  const vectors = new Map()
  if (Array.isArray(o.vectorHits)) for (const hit of o.vectorHits) {
    if (hit && Number.isFinite(hit.similarity) && hit.similarity >= 0.55 && (!vectors.has(hit.id) || vectors.get(hit.id) < hit.similarity)) vectors.set(hit.id, hit.similarity)
  }
  const k1 = 1.4
  const b = 0.7
  const scored = []
  const eligible = new Map()
  const period = o.period === undefined ? pastWindow(query, now) : o.period
  for (const d of idx.docs) {
    // 群聊 / 非主人私聊里只允许想起「和这一段说话的人有关」的记忆；
    // requireAbout 再收紧：社交场景连没有 about 的旧日记/事件也不放进来。
    // 已移除的旧梗概条目不再参与检索。
    if (d.it.kind === 'gist') continue
    const group = d.it.scope === 'group'
    if (group && (!String(d.it.chatId || '').startsWith('group:') || d.it.about)) continue
    if (group && !o.includeGroup && (!o.groupChatId || d.it.chatId !== o.groupChatId)) continue
    // F1 来源可见性（统一在检索层判定）：社交视角只看当前聊天里产生的记忆。
    // 旧数据/面板导入没有 chatId 的条目只留在主人视角；群公共记忆走上面的 scope==='group' 分支。
    if (!group && o.ownerScope === false && String(d.it.chatId || '') !== String(o.scopeChatId || '')) continue
    if (!group && d.it.about && excludeSet.has(String(d.it.about))) continue
    if (!group && onlyAbout && d.it.about && !onlyAbout.has(String(d.it.about))) continue
    if (!group && o.requireAbout && !d.it.about) continue
    let s = 0
    const why = []
    for (const t of q) {
      const f = d.tf.get(t)
      if (!f) continue
      const n = idx.df.get(t) || 0
      const idf = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5))
      const part = idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / idx.avgLen))
      s += part
      why.push([t, part])
    }
    const it = d.it
    if (!o.includeInvalid) {
      if (period) {
        const from = validFromOf(it) || 0
        const until = validUntilOf(it) ?? Infinity
        if (from >= period.end || until <= period.start || until <= from) continue
      } else if (!isCurrent(it, now)) continue
    }
    eligible.set(it.id, it)
    const aboutHit = Boolean(it.about) && aboutSet.has(String(it.about))
    const vector = vectors.get(it.id)
    if (s <= 0 && vector === undefined) continue // 零关键词只能由足够相似的向量召回
    const importance = 0.6 + 0.8 * (Number(it.importance) || 0.5)
    // 问的是某个过去时间段（「去年」「那时候」）就是在找旧事，不按新不新鲜打折
    const fresh = period ? 1 : retention(it, now)
    // relevance：够不够相关（门槛只看它）；score：再按激活度排先后——淡了的事排后面，但直接问到还是想得起来
    const relevance = ((s > 0 ? s : vector) + (aboutHit ? 0.8 : 0)) * importance
    const score = relevance * (0.55 + 0.45 * fresh)
    scored.push({ it, score, relevance, keyword: s, vector, why: why.sort((x, y) => y[1] - x[1]).slice(0, 3).map((w) => w[0]).concat(aboutHit ? ['（关于这个人）'] : [], vector !== undefined ? ['（语义相关）'] : []) })
  }
  // 关键词名次始终从关键词候选里算，向量候选不能改变原本的关键词排序。
  const hits = scored.filter((x) => x.keyword > 0 && x.relevance >= (o.minScore ?? 0.35))
  if (o.rrf !== false) {
    const ranks = (value) => {
      const sorted = [...hits].sort((a, b) => value(b) - value(a))
      let rank = 0
      return new Map(sorted.map((h, i) => { if (!i || value(h) !== value(sorted[i - 1])) rank = i + 1; return [h, rank] }))
    }
    const keywordRank = ranks((h) => h.keyword)
    const timeRank = ranks((h) => saidTime(h.it) || 0)
    const fused = (h) => 1 / (60 + keywordRank.get(h)) + 1 / (60 + timeRank.get(h))
    hits.sort((a, b) => Math.floor(b.score * 10) - Math.floor(a.score * 10) || fused(b) - fused(a) || b.score - a.score)
  } else hits.sort((a, b) => b.score - a.score)
  if (vectors.size) {
    // 先保留原来的关键词排序，再与相似度排序按名次融合，分数不能直接相加。
    const keywordRank = new Map(hits.map((h, i) => [h, i + 1]))
    const have = new Set(hits)
    for (const hit of scored) if (hit.vector !== undefined && !have.has(hit)) hits.push(hit)
    const vectorRank = new Map(hits.filter((h) => h.vector !== undefined).sort((a, b) => b.vector - a.vector).map((h, i) => [h, i + 1]))
    const fused = (h) => (keywordRank.has(h) ? 1 / (60 + keywordRank.get(h)) : 0) + (vectorRank.has(h) ? 1 / (60 + vectorRank.get(h)) : 0)
    hits.sort((a, b) => fused(b) - fused(a) || b.score - a.score)
  }
  const limit = Math.max(0, o.limit ?? 6)
  const selected = hits.slice(0, limit)
  if (o.related !== false) {
    const have = new Set(selected.map((h) => h.it.id))
    for (const hit of [...selected]) for (const id of hit.it.related || []) {
      if (selected.length >= limit) break
      const it = eligible.get(id)
      if (!it || have.has(id)) continue
      selected.push({ it, score: hit.score * 0.6, why: ['（相关的事）'] })
      have.add(id)
    }
  }
  return selected.map(({ keyword, vector, ...hit }) => hit)
}

/** 「刚才」「3 小时前」「昨天」这样的说法。 */
export function agoText(at, now = Date.now()) {
  const m = Math.max(0, Math.round((now - at) / 60000))
  if (m < 30) return '刚才'
  if (m < 60 * 20) return `${Math.max(1, Math.round(m / 60))} 小时前`
  return '昨天'
}

/** 一条记忆是什么时候的：今天 / 昨天 / 3 天前 / 09-17 / 去年 03-02 / 2024-05-01。 */
export function whenText(at, now = Date.now()) {
  if (!at) return ''
  const d = new Date(at)
  const n = new Date(now)
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day0(n) - day0(d)) / 86400_000)
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  if (d.getFullYear() === n.getFullYear()) return md
  if (d.getFullYear() === n.getFullYear() - 1) return '去年 ' + md
  return `${d.getFullYear()}-${md}`
}

/** 这件事是什么时候说的。at 是最后改动时间，整理、合并都会刷新，老记忆没有 saidAt 才退回 at。 */
export const saidTime = (m) => m.saidAt || m.at

/** 模型写的「MM-DD HH:mm」换成时间戳；对不上这批聊天的时间范围就用这批最后一句的时间。 */
export function parseSaidAt(value, first, last) {
  const m = String(value || '').match(/(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/)
  if (!m || !last) return last || 0
  const at = (year) => new Date(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4])).getTime()
  const year = new Date(last).getFullYear()
  const t = at(year) > last + 60_000 ? at(year - 1) : at(year) // 跨年的批次
  return t >= first - 60_000 && t <= last + 60_000 ? t : last
}

export const stamp = (t) => {
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 想起来的一条记忆怎么写给她：[什么时候] [关于谁] 内容。 */
export function memoryLine(it, now = Date.now()) {
  // 名字可能重名，带上 QQ 号才分得清是谁的事（#160）
  const qq = /^\d+$/.test(String(it.about || '')) && !String(it.aboutName || '').includes(String(it.about)) ? `(${it.about})` : ''
  const status = it.status === 'hearsay' ? '听说' : it.status === 'guess' ? '可能' : ''
  // 带上出处：哪个群或私聊的事，减少张冠李戴
  const from = String(it.chatId || '')
  const where = from.startsWith('group:') ? ` 群${from.slice(6)}` : from.startsWith('private:') ? ' 私聊' : ''
  const range = validityText(it, now)
  const then = validUntilOf(it) && validUntilOf(it) <= now ? '当时：' : ''
  return `[${whenText(saidTime(it), now)}${where}] ` + (range ? `[${range}] ` : '') + (it.kind !== 'seen' && it.aboutName ? `[${it.aboutName}${qq}] ` : '') + then + status + eventText(it)
}

/** 目录 / 常驻要紧事里的极简短标题（只展示标题不展开全文）。 */
export function shortTitle(m, maxChars = 24) {
  const raw = String(eventText(m) || '').replace(/\s+/g, ' ').trim()
  return [...raw].length > maxChars ? [...raw].slice(0, maxChars).join('') + '…' : raw
}

/** 本地回环地址的向量服务零费用，峰时不推迟同步。 */
export function isLocalVectorUrl(baseUrl) {
  try {
    const host = new URL(String(baseUrl || '').trim()).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch (error) {
    return false
  }
}

/**
 * 该不该忘掉：自动提炼的按遗忘曲线淡了忘掉（见 retention）；桌宠行为回执只留 3 天，到期清掉。
 * 经历留 90 天，重要经历、她自己记的、你加的和日记不自动忘。
 */
export function shouldForget(m, now = Date.now(), eventExpireDays = 90) {
  // 过时的留半年（面板里能看到、能恢复），之后清掉
  // 成立时间可能很早，刚补记的往事仍应保留半年；沿用 invalidAt / at 计算清理时间。
  if (m.invalidAt || (validUntilOf(m) && validUntilOf(m) <= now)) return now - (m.invalidAt || m.at || validUntilOf(m)) > 180 * 86400_000
  // 桌宠行为回执（source='pet'，比如「执行了 wander 动作」）只留 3 天：
  // 写下来是给后续几天聊天的，过了就没什么用了，不然每个琐碎动作都永久占着记忆库。
  if (m.source === 'pet') return now - (m.at || 0) > 3 * 86400_000
  // 刷到 / 看过的（seen）：压缩、合并、关联都不管它，只靠到期删会一直攒着。改成和自动提炼的事实一样按遗忘曲线淡掉，
  // 没档位的按「琐碎」档（淡得快一倍）：一直没被想起的大约 4 周忘掉，聊天里被想起过的会留得久一些；到期天数仍是上限
  if (m.kind === 'seen') {
    if ((Number(m.importance) || 0) >= 0.6 || isPermanent(m)) return false
    if (eventExpireDays >= 0 && now - (saidTime(m) || 0) > eventExpireDays * 86400_000) return true
    return retention(m.tier == null ? { ...m, tier: 1 } : m, now) < 0.05
  }
  if (m.source === 'event') return eventExpireDays >= 0 && (Number(m.importance) || 0) < 0.6 && now - (saidTime(m) || 0) > eventExpireDays * 86400_000
  if (m.source !== 'auto') return false
  if ((Number(m.importance) || 0) >= 0.6 || isPermanent(m)) return false
  return retention(m, now) < 0.05
}

/** 档位只调「淡得多快」：琐碎的快一倍，重要的慢一倍；0 档（旧数据里写作 'core'）永久。 */
const TIER_SCALE = { 1: 0.5, 2: 1, 3: 2 }
export const isPermanent = (m) => m?.tier === 0 || m?.tier === 'core'

/**
 * 激活度（0~1）——记忆机制里唯一的「这条还活不活跃」指标：检索加权、细节压缩、遗忘、容量淘汰、常驻挑选都看它。
 * R = e^(-Δt/τ)。Δt 是离上次被用到过了多久：这件事说出来的时间、之后又被提到（mentionedAt）、被想起、被主动翻开，取最近的；
 * 只改了存储时间（at，比如补提炼几天前的聊天）不算「用到」。
 * τ = 20 天 ×（1 + 用过几次）×（0.5 + 重要度）× 档位系数。「用过几次」= 被想起的天数 + 主动翻开次数 × 2（最多算 10）。
 * 一条普通记忆两个月没被用到就淡了；隔几天就聊到一次的能记很久，带档位的也一样。
 */
export function retention(m, now = Date.now()) {
  if (isPermanent(m)) return 1
  const last = Math.max(Number(m.saidAt) || Number(m.at) || 0, Number(m.mentionedAt) || 0, Number(m.lastHit) || 0, Number(m.lastClickAt) || 0)
  const days = Math.max(0, (now - last) / 86400_000)
  const uses = Math.min(10, (Number(m.hitDays) || 0) + 2 * (Number(m.clicks) || 0))
  const tau = 20 * (1 + uses) * (0.5 + (Number(m.importance) || 0.5)) * (TIER_SCALE[m.tier] ?? 1)
  return Math.exp(-days / tau)
}

/** 重排召回结果，同一话题不占满名额（MMR）：每选一条，和它太像的候选降分。sim(a, b) 返回 0~1。 */
export function diversify(hits, { limit = hits.length, sim, lambda = 0.5 } = {}) {
  const pool = [...hits]
  const top = Math.max(...pool.map((h) => h.score), 1e-9)
  const picked = []
  while (picked.length < limit && pool.length) {
    let best = 0
    let bestValue = -Infinity
    pool.forEach((h, i) => {
      const most = picked.length ? Math.max(...picked.map((p) => sim(h.it, p.it))) : 0
      const value = lambda * (h.score / top) - (1 - lambda) * most
      if (value > bestValue) { bestValue = value; best = i }
    })
    picked.push(pool.splice(best, 1)[0])
  }
  return picked
}

/** 私聊里明确要求记住或忘掉，其他说法照常聊天。 */
export function parseMemoryCommand(text) {
  const m = String(text || '').trim().match(/^(?:请|麻烦|你)?\s*(记住|你要记得|要记得|忘掉|忘记|别记|不要记)(?:[：:,，\s]+)?(.+?)\s*[。！!]*$/s)
  if (!m) return null
  const content = m[2].trim().replace(/^[「『“"]|[」』”"]$/g, '').trim()
  // 「记住了吗」「忘掉吧」「别记这个」是聊天不是吩咐，也说不清要记什么、忘什么
  if ([...content.replace(/[\s\p{P}\p{S}]/gu, '')].length < 3 || /^(?:了|吧|吗|呢|啊|呀|哦|嘛|没)|^(?:这个|那个|这些|那些|它|这件事|那件事|刚才的?|上面的?)[\s\p{P}\p{S}]*$/u.test(content)) return null
  // 密码这类东西不该长期存着
  if (/密码|口令|验证码|token|api.?key|身份证|银行卡/i.test(content)) return null
  return { action: /^(忘|别|不要)/.test(m[1]) ? 'forget' : 'remember', text: content.slice(0, 200) }
}

/** 非主人不能把指令和权限写成长久记忆。 */
export function looksLikeRuleMemory(text) {
  const t = String(text || '')
  if (!t) return false
  if (/(规则|指令|命令|权限|白名单|管理员|群主|主人让你|主人的话|等同主人|不用确认|都先|一律|不许|不要|禁止|听我的|听他的|听她的|服从)/.test(t)) return true
  if (/(主人说|主人让|主人要求).{0,30}(发|给|做|先|都|不许|不要|禁止|只能)/.test(t)) return true
  if (/(以后|今后|每次|永远).{0,30}(都|必须|只能|先|不许|不要|禁止|一律).{0,30}(发|给|做|听|按|文件|群|主人|规则|命令|权限)/.test(t)) return true
  return false
}

export function stripMemoryHints(text) {
  const s = String(text || '')
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const rest = s.slice(i)
    if (rest.startsWith('【上次聊天的延续')) {
      const end = s.indexOf('【延续结束，接着回下面这条】', i + 1)
      if (end >= 0) { i = end + '【延续结束，接着回下面这条】'.length - 1; continue }
    }
    if (/^【(?:当前背景|刚才背景|当前时间|在外面|出门|精力|今天做过的事)/.test(rest)) {
      const nl = s.indexOf('\n', i)
      i = nl < 0 ? s.length - 1 : nl
      continue
    }
    if (!/^（(?:你记得这些事|这个聊天里之前的原话|以下只是印象|这个群的印象|你对.{0,30}的印象|和.{0,30}相处的经验|说话方式：|你最近做过的事|最近常浮在脑海里的事|你现在心情|刚才聊到的|下面是你最近在几个群里|你写过的认识页|关于他，你记得这几件要紧的事|以下是原话归档记录)/.test(rest)) { out += s[i]; continue }
    let depth = 0
    for (; i < s.length; i++) {
      if (s[i] === '（') depth++
      if (s[i] === '）' && --depth === 0) break
    }
    if (rest.startsWith('（下面是你最近在几个群里')) {
      const end = s.indexOf('【以上是最近群里的情况】', i + 1)
      if (end >= 0) i = end + '【以上是最近群里的情况】'.length - 1
    }
  }
  return out.trim()
}

export function matchesMemoryKeyword(text, query) {
  const a = String(text || '').toLowerCase()
  const b = String(query || '').toLowerCase().trim()
  if (!a || !b) return false
  if (a.includes(b) || (a.length >= 2 && b.includes(a))) return true
  const words = [...new Set(tokenize(b))]
  if (!words.length) return false
  const have = new Set(tokenize(a))
  const n = words.filter((w) => have.has(w)).length
  return n >= Math.min(2, words.length) && n / words.length >= 0.6
}

// ---------------- 记忆库 ----------------

/** 解析「回顾」的模型输出：{insights:[], style:[]}；老格式的纯数组当作 insights。 */
export function parseReflection(out) {
  const str = (t) => String(typeof t === 'string' ? t : t?.text || '').trim()
  const obj = String(out || '').match(/\{[\s\S]*\}/)
  if (obj) {
    try {
      const j = JSON.parse(obj[0])
      if (Array.isArray(j.insights) || Array.isArray(j.style)) {
        return { insights: (j.insights || []).map(str).filter(Boolean), style: (j.style || []).map(str).filter(Boolean) }
      }
    } catch (error) {}
  }
  const arr = String(out || '').match(/\[[\s\S]*\]/)
  try {
    return { insights: arr ? JSON.parse(arr[0]).map(str).filter(Boolean) : [], style: [] }
  } catch (error) {
    return { insights: [], style: [] }
  }
}

/** 解析提炼结果：容忍前后的废话、多余的逗号和被截断的结尾。解析不出来返回 null。 */
export function parseFacts(out) {
  const s = String(out || '')
  const start = s.includes('[{') ? s.indexOf('[{') : s.indexOf('[')
  if (start < 0) return null
  const body = s.slice(start)
  const clean = (x) => x.replace(/,\s*([\]}])/g, '$1')
  const whole = body.slice(0, body.lastIndexOf(']') + 1)
  const cut = clean(body.slice(0, body.lastIndexOf('}') + 1))
  for (const text of [whole, clean(whole), cut ? cut + ']' : '']) {
    try {
      const arr = JSON.parse(text)
      if (Array.isArray(arr)) return arr
    } catch (error) {}
  }
  return null
}

// 新格式和旧版纯数组都可读，旧模型不需要一次性迁移。
export function parseExtraction(out) {
  const text = String(out || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start && (text.indexOf('[') < 0 || start < text.indexOf('['))) {
    try {
      const result = JSON.parse(text.slice(start, end + 1).replace(/,\s*([\]}])/g, '$1'))
      if (Array.isArray(result.facts)) return result
      if (Array.isArray(result.people) || Array.isArray(result.relations) || (result.chat && typeof result.chat === 'object' && !Array.isArray(result.chat))) return { ...result, facts: [] }
    } catch (error) {}
    return null
  }
  const facts = parseFacts(out)
  return facts ? { facts } : null
}

/**
 * 校验模型提炼的人物关系。身份由程序定：依据必须是这批真说过话的人，
 * 而且本人或主人说的才算，别人传的不记。不合格返回 null。
 */
export function normalizeRelation(x, { chatId = '', names = new Map(), owner = '' } = {}) {
  const word = (v) => (typeof v === 'string' ? v.trim() : '')
  const subj = word(x?.subj)
  const pred = word(x?.pred)
  const obj = word(x?.obj)
  if (!subj || !pred || !obj || subj === obj || [subj, pred, obj].some((v) => v.length > 20) || looksLikeRuleMemory(pred)) return null
  const qqOf = (v) => (/^\d+$/.test(String(v ?? '')) ? String(v) : '')
  const subjQq = qqOf(x.subj_qq)
  const objQq = qqOf(x.obj_qq)
  const author = String(x.speaker || (chatId.startsWith('private:') ? chatId.slice(8) : ''))
  if (!names.has(author)) return null
  const who = names.get(author)
  if (author !== String(owner) && subjQq !== author && objQq !== author && subj !== who && obj !== who) return null
  return { id: randomUUID().slice(0, 8), subj, subjQq, pred, obj, objQq, chatId, speaker: author, at: Date.now() }
}

const relationText = (r) => `${r.subj} ${r.pred} ${r.obj}`
const relationPair = (r) => [r.subjQq || r.subj, r.objQq || r.obj].sort().join('|')
const relationHas = (r, qq, names = []) => r.subjQq === qq || r.objQq === qq || names.includes(r.subj) || names.includes(r.obj)

const SENSITIVE_TEXT = /密码|口令|验证码|token|api.?key|secret|身份证|银行卡/i

// ---------------- 原话指针（sourceRef）与离线原话纠错（Dreaming Audit） ----------------

/** 校验并裁剪一条记忆指向原对话的位置指针。 */
export function normalizeSourceRef(ref) {
  if (!ref || typeof ref !== 'object') return undefined
  const chatId = String(ref.chatId || '').trim().slice(0, 64)
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(ref.day || '')) ? String(ref.day) : ''
  const t = Number(ref.t) > 0 && Number.isFinite(Number(ref.t)) ? Math.floor(Number(ref.t)) : 0
  const lineIndex = Number.isInteger(ref.lineIndex) && ref.lineIndex >= 0 ? ref.lineIndex : undefined
  const quote = String(ref.quote || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!day && !t && !quote) return undefined
  return {
    ...(chatId ? { chatId } : {}),
    ...(day ? { day } : {}),
    ...(t ? { t } : {}),
    ...(lineIndex !== undefined ? { lineIndex } : {}),
    ...(quote ? { quote } : {}),
  }
}

/**
 * 把模型提炼出的事实锚定回本批真实聊天流水中的最匹配原话，
 * 优先按说话人 + 时间接近度 + 字组相似度打分，保证 quote 与行号均来自真实流水而非模型编造。
 */
export function matchSourceLine(entries, { text = '', quote = '', speaker = '', saidAt = 0, chatId = '', day = '' } = {}) {
  const list = Array.isArray(entries) ? entries.filter((l) => l && String(l.text || '').trim()) : []
  if (!list.length) return undefined
  const spk = String(speaker || '').trim()
  const qText = String(quote || '').trim()
  const refText = qText || String(text || '').trim()
  const refToks = new Set(tokenize(refText))
  if (!qText && !refToks.size) return undefined
  let best = null
  let bestScore = -1
  for (const l of list) {
    const clean = String(l.text || '').replace(/\s+/g, ' ').trim()
    const qHit = Boolean(qText && (clean.includes(qText) || qText.includes(clean)))
    let tokOverlap = 0
    if (refToks.size) {
      const ltks = new Set(tokenize(clean))
      let hit = 0
      for (const tk of refToks) if (ltks.has(tk)) hit++
      tokOverlap = ltks.size ? hit / Math.max(1, Math.min(refToks.size, ltks.size)) : 0
    }
    // 必须有最低文本相关度门槛，避免把毫无关系的寒暄（如「晚安」）错锚定为原话指针。
    if (!qHit && tokOverlap < 0.25) continue
    let score = tokOverlap * 2.5 + (qHit ? 3.0 : 0)
    const lUid = String(l.uid || '')
    if (spk && lUid && lUid === spk) score += 2.0
    const lt = Number(l.t) || 0
    if (saidAt && lt) {
      const diffMin = Math.abs(lt - saidAt) / 60_000
      if (diffMin <= 1.5) score += 2.5
      else if (diffMin <= 5) score += 1.2
      else if (diffMin <= 30) score += 0.4
    }
    if (score > bestScore) { bestScore = score; best = l }
  }
  if (!best) return undefined
  const lt = Number(best.t) || Number(saidAt) || 0
  const d = best._day || day || (lt ? (() => { const dt = new Date(lt); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}` })() : '')
  return normalizeSourceRef({
    chatId: best.chatId || chatId,
    day: d,
    t: lt,
    lineIndex: Number.isInteger(best._logIndex) ? best._logIndex : undefined,
    quote: String(best.text || '').replace(/\s+/g, ' ').trim().slice(0, 100),
  })
}

/** 解析离线原话复核（Dreaming Audit）的模型输出 {"audits":[{id,action,text?,reason?}]}。 */
export function parseDreamAudits(out) {
  const s = String(out || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const hit = s.match(/\{[\s\S]*\}/)
  if (!hit) return []
  try {
    const j = JSON.parse(hit[0].replace(/,\s*([\]}])/g, '$1'))
    const arr = Array.isArray(j?.audits) ? j.audits : []
    return arr.filter((x) => x && typeof x.id === 'string' && ['keep', 'fix', 'drop'].includes(x.action))
      .map((x) => ({
        id: String(x.id).replace(/^#/, '').trim(),
        action: x.action,
        text: typeof x.text === 'string' ? x.text.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
        reason: typeof x.reason === 'string' ? x.reason.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
      }))
  } catch {
    return []
  }
}

/** 校验原话纠错改写后的记忆：不能含敏感词，不能出现原话窗口与原记忆里都没有的多位数字。 */
export function checkAuditFix(text, sourceTexts = []) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  const chars = [...t.replace(/\s/g, '')]
  if (chars.length < 4) return { ok: false, message: '太短' }
  if (chars.length > 200) return { ok: false, message: '太长' }
  if (SENSITIVE_TEXT.test(t)) return { ok: false, message: '含敏感词' }
  const source = (Array.isArray(sourceTexts) ? sourceTexts : [sourceTexts]).join(' ')
  const known = new Set([...source.matchAll(/\d{2,}/g)].map((m) => m[0]))
  for (const n of [...t.matchAll(/\d{2,}/g)].map((m) => m[0])) {
    if (!known.has(n)) return { ok: false, message: `出现原话中没有的数字 ${n}` }
  }
  return { ok: true, text: t }
}
