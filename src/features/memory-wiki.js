// LLM Wiki 活文档引擎（多页结构 + 作用域硬隔离 + 结构化行级编辑 + .history 版本快照）
// 目录布局（dataDir/memory-wiki/ 或影子期 dataDir/memory-wiki-shadow/）：
//   .history/                  每次修改前的自动版本快照
//   我.md                      [scope: owner] 角色自己的近况、手头小事、成长（主人私聊常驻）
//   认识/主人.md                [scope: owner] 主人的稳定长期认知：性格/喜好/边界/默契（主人私聊常驻）
//   认识/近期与约定.md           [scope: owner] 强时效热层：进行中计划、未兑现承诺、近7~14天状态（主人私聊常驻）
//   认识/目录.md                [scope: owner] 归档与专题索引（含关键词概要，进常驻）
//   回忆/YYYY-MM.md            [scope: owner] 按月归档的共同经历与已核销约定（按需 wiki_open）
//   专题/<标题>.md              [scope: owner] 聊深了再自然生长的专题页（按需 wiki_open）
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { dataDir } from '../core/store.js'
import { MEM_LIMITS } from './memory-limits.js'

// 只拦真实凭据/卡号/证件号（避免误拦「去博物院带身份证」这类普通日常语句）
const SENSITIVE = /(?:密码|口令|验证码|token|api.?key|secret)\s*[:：=是为]\s*\S{4,}|(?:身份证|银行卡)(?:号|号码)?\s*[:：=是为]?\s*\d{6,}|\bsk-[a-zA-Z0-9_-]{16,}\b|\b\d{17}[\dXx]\b/i
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i
const MAX_TITLE_CHARS = 40
const MAX_CONTENT_CHARS = 40000
const MAX_LINKS = 160
const MAX_HISTORY_PER_PAGE = 60

export const SELF_PAGE = '我'
export const OWNER_PAGE = '认识/主人'
export const RECENT_PAGE = '认识/近期与约定'
export const INDEX_PAGE = '认识/目录'
const ALLOWED_FOLDERS = new Set(['认识', '回忆', '专题'])
const RESIDENT_SET = new Set([SELF_PAGE, OWNER_PAGE, RECENT_PAGE, INDEX_PAGE])

function sliceChars(str, max) {
  const cs = [...String(str || '')]
  return cs.length > max ? cs.slice(0, max).join('') + '…' : cs.join('')
}

function historyStamp(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 清洗并校验单个路径段（不含目录分隔符）。 */
export function sanitizeWikiTitle(raw) {
  const s = String(raw || '').trim().replace(/\.md$/i, '').trim()
  if (!s) return ''
  if (s === '.' || s === '..' || s.endsWith('.') || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(s) || s.includes('..')) return ''
  if (WINDOWS_RESERVED.test(s)) return ''
  if ([...s].length > MAX_TITLE_CHARS) return ''
  return s
}

/**
 * 规范化页面路径：支持 `我`、`认识/主人`、`认识/近期与约定`、`认识/目录`、`回忆/YYYY-MM`、`专题/<标题>`，
 * 并兼容简写（`主人`、`近期与约定`、`目录`、`2026-12` 或自定义 ownerName）。
 * 拒绝任何路径穿越、非法字符、未知目录。
 */
export function normalizeWikiPath(raw, { ownerName = '主人' } = {}) {
  const s = String(raw || '').trim().replace(/^\[\[|\]\]$/g, '').trim().replace(/\.md$/i, '').trim()
  if (!s || s.includes('\\') || s.includes('..') || s.startsWith('/') || s.endsWith('/')) return ''
  if (!s.includes('/')) {
    const clean = sanitizeWikiTitle(s)
    if (!clean) return ''
    if (clean === SELF_PAGE) return SELF_PAGE
    if (clean === '主人' || (ownerName && clean === String(ownerName).trim())) return OWNER_PAGE
    if (clean === '近期与约定') return RECENT_PAGE
    if (clean === '目录') return INDEX_PAGE
    if (/^\d{4}-\d{2}$/.test(clean)) return `回忆/${clean}`
    return `认识/${clean}`
  }
  const parts = s.split('/')
  if (parts.length !== 2) return ''
  const [folder, name] = parts
  if (!ALLOWED_FOLDERS.has(folder)) return ''
  const cleanName = sanitizeWikiTitle(name)
  if (!cleanName) return ''
  if (folder === '回忆' && !/^\d{4}-\d{2}$/.test(cleanName)) return ''
  if (folder === '认识' && ownerName && cleanName === String(ownerName).trim()) return OWNER_PAGE
  return `${folder}/${cleanName}`
}

/** 提取正文里的 [[路径]] 互链。 */
export function extractPageLinks(content, { ownerName = '主人' } = {}) {
  const found = new Set()
  for (const m of String(content || '').matchAll(/\[\[([^[\]\r\n]{1,60})\]\]/g)) {
    const p = normalizeWikiPath(m[1], { ownerName })
    if (p) found.add(p)
    if (found.size >= MAX_LINKS) break
  }
  return [...found]
}

/** 提取正文里对主记忆库条目的显式引用（如 #a1b2c3d4，保留兼容旧版）。 */
export function extractMemoryRefs(content) {
  const stripped = String(content || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\r\n]*`/g, ' ')
  const found = new Set()
  for (const m of stripped.matchAll(/(?:^|[\s（(）)，,。.;；:：、！？!?])#([0-9a-f]{8})\b/gi)) {
    found.add(m[1].toLowerCase())
    if (found.size >= MAX_LINKS) break
  }
  return [...found]
}

/** 解析简单 YAML frontmatter。 */
export function parseWikiMarkdown(raw) {
  const text = String(raw || '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  const meta = {}
  if (m) {
    const lines = m[1].split(/\r?\n/).filter((l) => l.trim() !== '')
    const looksLikeYaml = lines.length > 0 && lines.every((l) => /^[a-zA-Z0-9_-]+\s*:/.test(l))
    if (looksLikeYaml) {
      for (const line of lines) {
        const i = line.indexOf(':')
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1')
      }
      return { meta, body: text.slice(m[0].length).trim() }
    }
  }
  return { meta, body: text.trim() }
}

function renderWikiMarkdown(body, meta = {}) {
  const cleanMeta = Object.entries(meta).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
  if (!cleanMeta.length) return `${String(body || '').trim()}\n`
  const head = ['---', ...cleanMeta.map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ').trim()}`), '---', ''].join('\n')
  return `${head}${String(body || '').trim()}\n`
}

function keyOf(p) {
  return String(p || '').trim().toLowerCase()
}

function stripBulletPrefix(line) {
  return String(line || '').trim().replace(/^[-*•]\s+/, '').trim()
}

/** 在页面行数组中定位要修改/删除的行：先精确去首尾空白匹配，再退到去项目符号唯一匹配。 */
function findUniqueLineIndex(lines, matchText) {
  const target = String(matchText || '').trim()
  if (!target) return { ok: false, reason: 'match 为空' }
  const exact = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === target) exact.push(i)
  }
  if (exact.length === 1) return { ok: true, index: exact[0] }
  if (exact.length > 1) return { ok: false, reason: `匹配到 ${exact.length} 行，不唯一` }
  const bareTarget = stripBulletPrefix(target)
  if (!bareTarget) return { ok: false, reason: '未匹配到目标行' }
  const loose = []
  for (let i = 0; i < lines.length; i++) {
    if (stripBulletPrefix(lines[i]) === bareTarget) loose.push(i)
  }
  if (loose.length === 1) return { ok: true, index: loose[0] }
  return { ok: false, reason: loose.length > 1 ? `宽松匹配到 ${loose.length} 行，不唯一` : '未找到目标原文行' }
}

/** 往页面文本的指定小节（## section）或末尾追加一行/多行（已存在完全相同行时幂等跳过）。 */
function addLineToBody(body, text, section = '') {
  const addText = String(text || '').trim()
  if (!addText) return { body, changed: false }
  const lines = body ? body.split(/\r?\n/).filter((l) => l.trim() !== '（暂无进行中的约定）') : []
  const newLines = addText.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '')
  if (!newLines.length) return { body, changed: false }
  const existingSet = new Set(lines.map((l) => l.trim()))
  const toInsert = newLines.filter((l) => !existingSet.has(l.trim()))
  if (!toInsert.length) return { body, changed: false }

  const sec = String(section || '').trim().replace(/^#+\s*/, '')
  if (!sec) {
    const joined = [...lines, ...toInsert].join('\n').replace(/\n{3,}/g, '\n\n').trim()
    return { body: joined, changed: true }
  }
  const headingRe = /^##\s+(.+?)\s*$/
  let secIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i].trim())
    if (m && m[1].trim() === sec) { secIdx = i; break }
  }
  if (secIdx < 0) {
    const next = [...lines, ...(lines.length ? [''] : []), `## ${sec}`, ...toInsert].join('\n').replace(/\n{3,}/g, '\n\n').trim()
    return { body: next, changed: true }
  }
  let insertAt = lines.length
  for (let i = secIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) { insertAt = i; break }
  }
  while (insertAt > secIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--
  lines.splice(insertAt, 0, ...toInsert)
  return { body: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), changed: true }
}

function cleanEmptyLines(lines) {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function createMemoryWiki({ directory = () => dataDir('memory-wiki'), log = console, getOwnerName = () => '主人' } = {}) {
  const rootDir = () => (typeof directory === 'function' ? directory() : directory)
  const historyDir = () => join(rootDir(), '.history')
  const ownerName = () => {
    try { return String(getOwnerName?.() || '主人').trim() || '主人' } catch { return '主人' }
  }

  function resolvePagePath(rawPath) {
    const canonical = normalizeWikiPath(rawPath, { ownerName: ownerName() })
    if (!canonical) return null
    const root = resolve(rootDir())
    const segs = canonical.split('/')
    const file = resolve(root, ...segs) + '.md'
    const expected = join(root, ...segs) + '.md'
    if (file !== expected || !file.startsWith(root + sep)) return null
    return {
      path: canonical,
      title: segs[segs.length - 1],
      folder: segs.length > 1 ? segs[0] : '',
      file,
      isSelf: canonical === SELF_PAGE,
      isIndex: canonical === INDEX_PAGE,
      isResident: RESIDENT_SET.has(canonical),
    }
  }

  function readDoc(info) {
    try {
      if (!info || !existsSync(info.file)) return null
      const raw = readFileSync(info.file, 'utf8')
      const { meta, body } = parseWikiMarkdown(raw)
      const mtimeMs = Number(statSync(info.file).mtimeMs) || 0
      return {
        path: info.path,
        title: info.path,
        shortTitle: info.title,
        folder: info.folder,
        isSelf: info.isSelf,
        isIndex: info.isIndex,
        isResident: info.isResident,
        scope: meta.scope || 'owner',
        updatedAt: Number(meta.updatedAt) || mtimeMs,
        body,
        raw,
        links: extractPageLinks(body, { ownerName: ownerName() }),
        memoryRefs: extractMemoryRefs(body),
      }
    } catch (error) {
      log?.warn?.(`读取 Wiki 页 ${info?.path} 失败：`, error.message)
      return null
    }
  }

  function listAll({ viewerScope = 'owner' } = {}) {
    const docs = []
    const root = rootDir()
    if (!existsSync(root)) return docs
    const selfInfo = resolvePagePath(SELF_PAGE)
    if (selfInfo && existsSync(selfInfo.file)) {
      const doc = readDoc(selfInfo)
      if (doc && (viewerScope === 'owner' || doc.scope !== 'owner')) docs.push(doc)
    }
    for (const folder of ALLOWED_FOLDERS) {
      const dir = join(root, folder)
      if (!existsSync(dir)) continue
      let names = []
      try { names = readdirSync(dir) } catch {}
      for (const name of names) {
        if (!/\.md$/i.test(name)) continue
        const info = resolvePagePath(`${folder}/${name}`)
        if (!info) continue
        const doc = readDoc(info)
        if (doc && (viewerScope === 'owner' || doc.scope !== 'owner')) docs.push(doc)
      }
    }
    return docs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.path.localeCompare(b.path))
  }

  function pageRelations(pagePath, docs = listAll()) {
    const k = keyOf(pagePath)
    const target = docs.find((d) => keyOf(d.path) === k)
    if (!target) return { outgoing: [], incoming: [], missing: [], memoryRefs: [] }
    const known = new Set(docs.map((d) => keyOf(d.path)))
    const outgoing = target.links.filter((t) => known.has(keyOf(t)))
    const missing = target.links.filter((t) => !known.has(keyOf(t)))
    const incoming = docs.filter((d) => keyOf(d.path) !== k && d.links.some((l) => keyOf(l) === k)).map((d) => d.path)
    return { outgoing, incoming, missing, memoryRefs: target.memoryRefs }
  }

  function open(rawPath, { viewerScope = 'owner' } = {}) {
    const info = resolvePagePath(rawPath)
    if (!info) return { ok: false, message: '页名不合法（可用：我、认识/主人、认识/近期与约定、认识/目录、回忆/YYYY-MM、专题/标题）' }
    const allDocs = listAll({ viewerScope: 'owner' })
    const doc = allDocs.find((d) => keyOf(d.path) === keyOf(info.path))
    if (!doc) {
      const visible = allDocs.filter((d) => viewerScope === 'owner' || d.scope !== 'owner')
      const near = visible.map((d) => d.path).filter((t) => t.includes(info.title) || info.path.includes(t) || t.includes(info.path)).slice(0, 6)
      return {
        ok: false,
        notFound: true,
        message: near.length ? `还没有「${info.path}」这一页（相近的页：${near.join('、')}）` : `还没有「${info.path}」这一页`,
      }
    }
    if (doc.scope === 'owner' && viewerScope !== 'owner') {
      return { ok: false, forbidden: true, message: '无权查看该认识页' }
    }
    const visibleDocs = allDocs.filter((d) => viewerScope === 'owner' || d.scope !== 'owner')
    return { ok: true, page: doc, relations: pageRelations(doc.path, visibleDocs) }
  }

  function saveHistorySnapshot(pagePath, rawContent, now = Date.now()) {
    try {
      const dir = join(historyDir(), ...pagePath.split('/'))
      mkdirSync(dir, { recursive: true })
      const fname = `${historyStamp(now)}-${randomUUID().slice(0, 6)}.md`
      const target = join(dir, fname)
      writeFileSync(target, rawContent, 'utf8')
      // 限制单页快照数量，防止数年后无限堆积
      const files = readdirSync(dir).filter((n) => n.endsWith('.md')).sort()
      if (files.length > MAX_HISTORY_PER_PAGE) {
        for (const old of files.slice(0, files.length - MAX_HISTORY_PER_PAGE)) {
          try { rmSync(join(dir, old), { force: true }) } catch {}
        }
      }
      return target
    } catch (error) {
      log?.warn?.(`写入 .history 快照失败（${pagePath}）：`, error.message)
      return ''
    }
  }

  function atomicWritePage(info, body, { scope = 'owner', now = Date.now(), snapshotPrev = true } = {}) {
    mkdirSync(dirname(info.file), { recursive: true })
    if (snapshotPrev && existsSync(info.file)) {
      try {
        const prevRaw = readFileSync(info.file, 'utf8')
        if (prevRaw.trim()) saveHistorySnapshot(info.path, prevRaw, now)
      } catch {}
    }
    const tmp = `${info.file}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`
    writeFileSync(tmp, renderWikiMarkdown(body, { scope, updatedAt: now }), 'utf8')
    renameSync(tmp, info.file)
  }

  /** 直接写入单页（供面板管理或兼容旧调用；写入前自动存 .history 快照）。 */
  function write(rawPath, content, { scope = 'owner', now = Date.now() } = {}) {
    const info = resolvePagePath(rawPath)
    if (!info) return { ok: false, message: '页名不合法' }
    const body = String(content || '').trim()
    if (!body) return { ok: false, message: '正文不能为空' }
    if (body.length > MAX_CONTENT_CHARS) return { ok: false, message: `正文太长（最多 ${MAX_CONTENT_CHARS} 字）` }
    if (SENSITIVE.test(body)) return { ok: false, message: '正文含敏感信息，不予保存' }
    atomicWritePage(info, body, { scope, now, snapshotPrev: true })
    return { ok: true, path: info.path, title: info.path, updatedAt: now, message: `已更新「${info.path}」` }
  }

  function remove(rawPath, { snapshotPrev = true, now = Date.now() } = {}) {
    const info = resolvePagePath(rawPath)
    if (!info) return { ok: false, message: '页名不合法' }
    if (!existsSync(info.file)) return { ok: false, message: '没有这一页' }
    if (snapshotPrev) {
      try {
        const prevRaw = readFileSync(info.file, 'utf8')
        if (prevRaw.trim()) saveHistorySnapshot(info.path, prevRaw, now)
      } catch {}
    }
    rmSync(info.file, { force: true })
    return { ok: true, message: `已删除「${info.path}」` }
  }

  /**
   * 原子批量执行结构化编辑操作（Dreaming 核心写入入口）：
   * - op: add({ page, section?, text }) / replace({ page, match, text }) / remove({ page, match }) / create({ page, content }) / rewrite_archive({ page, content })
   * - replace / remove 按原文行匹配，匹配不上拒绝该条操作；
   * - 任一受保护页面触发 55% 异常缩水拦截或超长拦截，整批中止、零落盘。
   */
  function applyEditBatch(ops, {
    allowRewritePages = new Set(),
    shrinkMinRatio = 0.55,
    archiveMinRatio = 0.45,
    scope = 'owner',
    now = Date.now(),
    commit = true,
  } = {}) {
    if (!Array.isArray(ops)) return { ok: false, error: 'ops 必须是数组', changedPages: [], rejectedOps: [] }
    const staged = new Map() // canonicalPath -> { info, origBody, origExists, body, isRewrite }
    const rejectedOps = []
    let appliedCount = 0

    const loadStage = (canonical) => {
      if (staged.has(canonical)) return staged.get(canonical)
      const info = resolvePagePath(canonical)
      if (!info) return null
      const doc = readDoc(info)
      const entry = { info, origBody: doc ? doc.body : '', origExists: Boolean(doc), body: doc ? doc.body : '', isRewrite: false }
      staged.set(canonical, entry)
      return entry
    }

    for (let idx = 0; idx < ops.length; idx++) {
      const op = ops[idx]
      if (!op || typeof op !== 'object') {
        rejectedOps.push({ idx, reason: '无效操作对象' })
        continue
      }
      const kind = String(op.op || '').trim().toLowerCase()
      const canonical = normalizeWikiPath(op.page, { ownerName: ownerName() })
      if (!canonical) {
        rejectedOps.push({ idx, op: kind, page: op.page, reason: '非法页名' })
        continue
      }
      const st = loadStage(canonical)
      if (!st) {
        rejectedOps.push({ idx, op: kind, page: canonical, reason: '路径解析失败' })
        continue
      }

      if (kind === 'add') {
        const text = String(op.text ?? op.content ?? '').trim()
        if (!text) { rejectedOps.push({ idx, op: kind, page: canonical, reason: 'add 内容为空' }); continue }
        if (SENSITIVE.test(text)) { rejectedOps.push({ idx, op: kind, page: canonical, reason: '含敏感信息' }); continue }
        const res = addLineToBody(st.body, text, op.section || '')
        st.body = res.body
        if (res.changed) appliedCount++
      } else if (kind === 'replace') {
        const match = String(op.match || '').trim()
        const text = String(op.text ?? op.content ?? '').trim()
        if (!match || !text) { rejectedOps.push({ idx, op: kind, page: canonical, reason: 'replace 缺少 match 或 text' }); continue }
        if (SENSITIVE.test(text)) { rejectedOps.push({ idx, op: kind, page: canonical, reason: '含敏感信息' }); continue }
        const lines = st.body ? st.body.split(/\r?\n/) : []
        const found = findUniqueLineIndex(lines, match)
        if (!found.ok) {
          rejectedOps.push({ idx, op: kind, page: canonical, match: match.slice(0, 80), reason: found.reason })
          continue
        }
        lines.splice(found.index, 1, ...text.split(/\r?\n/).map((l) => l.trimEnd()))
        st.body = cleanEmptyLines(lines)
        appliedCount++
      } else if (kind === 'remove') {
        const match = String(op.match || '').trim()
        if (!match) { rejectedOps.push({ idx, op: kind, page: canonical, reason: 'remove 缺少 match' }); continue }
        const lines = st.body ? st.body.split(/\r?\n/) : []
        const found = findUniqueLineIndex(lines, match)
        if (!found.ok) {
          rejectedOps.push({ idx, op: kind, page: canonical, match: match.slice(0, 80), reason: found.reason })
          continue
        }
        lines.splice(found.index, 1)
        st.body = cleanEmptyLines(lines)
        appliedCount++
      } else if (kind === 'create') {
        if (st.origExists && st.origBody.trim()) {
          rejectedOps.push({ idx, op: kind, page: canonical, reason: '页面已存在，禁止整页覆写，请用 add/replace/remove' })
          continue
        }
        const content = String(op.content ?? op.text ?? '').trim()
        if (!content) { rejectedOps.push({ idx, op: kind, page: canonical, reason: 'create 正文为空' }); continue }
        if (SENSITIVE.test(content)) { rejectedOps.push({ idx, op: kind, page: canonical, reason: '含敏感信息' }); continue }
        st.body = content
        appliedCount++
      } else if (kind === 'rewrite_archive') {
        if (!allowRewritePages.has(canonical)) {
          rejectedOps.push({ idx, op: kind, page: canonical, reason: '该页不在允许跨月压缩/重写的白名单内' })
          continue
        }
        const content = String(op.content ?? op.text ?? '').trim()
        if (!content) return { ok: false, error: `rewrite_archive 正文为空：${canonical}`, changedPages: [], rejectedOps }
        if (SENSITIVE.test(content)) return { ok: false, error: `rewrite_archive 含敏感信息：${canonical}`, changedPages: [], rejectedOps }
        st.body = content
        st.isRewrite = true
        appliedCount++
      } else {
        rejectedOps.push({ idx, op: kind, page: canonical, reason: `未知操作类型：${kind}` })
      }
    }

    // 校验所有变更页的长度与异常缩水拦截（任一失败则整批中止，零落盘）
    const toWrite = []
    for (const [canonical, st] of staged) {
      if (st.body === st.origBody && st.origExists) continue
      if (st.body.length > MAX_CONTENT_CHARS) {
        return { ok: false, error: `页面「${canonical}」超过字数上限（${st.body.length}/${MAX_CONTENT_CHARS}）`, changedPages: [], rejectedOps }
      }
      if (st.origExists && st.origBody.length >= 400) {
        if (canonical !== RECENT_PAGE && canonical !== INDEX_PAGE) {
          const minRatio = st.isRewrite ? archiveMinRatio : shrinkMinRatio
          if (st.body.length < st.origBody.length * minRatio) {
            return {
              ok: false,
              error: `异常缩水拦截：「${canonical}」从 ${st.origBody.length} 字骤减到 ${st.body.length} 字（低于 ${Math.round(minRatio * 100)}%）`,
              changedPages: [],
              rejectedOps,
            }
          }
        }
      }
      if (!st.body.trim() && !st.origExists) continue
      toWrite.push(st)
    }

    if (!commit) {
      return { ok: true, changedPages: toWrite.map((st) => st.info.path), appliedCount, rejectedOps }
    }

    // 全部校验通过：依次存 .history 快照并原子落盘
    const changedPages = []
    for (const st of toWrite) {
      if (!st.body.trim()) {
        // 仅允许热层（近期与约定）被清空为占位提示，其他已有页面不删除为空
        if (st.info.path === RECENT_PAGE) {
          atomicWritePage(st.info, '（暂无进行中的约定）', { scope, now, snapshotPrev: true })
          changedPages.push(st.info.path)
        }
        continue
      }
      atomicWritePage(st.info, st.body, { scope, now, snapshotPrev: true })
      changedPages.push(st.info.path)
    }

    return { ok: true, changedPages, appliedCount, rejectedOps }
  }

  /**
   * 维护 认识/目录.md：保留已有页面概要，合并新概要，自动补齐遗漏的归档/专题页，清掉已不存在的页。
   * 保证目录始终自带「信息气味（关键词概要）」。
   */
  function syncIndex(summaryUpdates = {}, { now = Date.now(), scope = 'owner' } = {}) {
    const docs = listAll({ viewerScope: 'owner' }).filter((d) => !d.isResident)
    const info = resolvePagePath(INDEX_PAGE)
    if (!info) return { ok: false, changed: false }
    const prevDoc = readDoc(info)
    const existingSummaries = new Map()
    if (prevDoc?.body) {
      for (const line of prevDoc.body.split(/\r?\n/)) {
        const m = /^\s*[-*•]?\s*\[\[([^[\]]+)\]\]\s*[：:]\s*(.+)$/.exec(line.trim())
        if (!m) continue
        const p = normalizeWikiPath(m[1], { ownerName: ownerName() })
        if (p) existingSummaries.set(p, m[2].trim())
      }
    }
    for (const [rawPage, rawDesc] of Object.entries(summaryUpdates || {})) {
      const p = normalizeWikiPath(rawPage, { ownerName: ownerName() })
      const desc = String(rawDesc || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 600)
      if (p && !RESIDENT_SET.has(p) && desc) existingSummaries.set(p, desc)
    }
    const memories = docs.filter((d) => d.folder === '回忆').sort((a, b) => b.path.localeCompare(a.path))
    const topics = docs.filter((d) => d.folder !== '回忆').sort((a, b) => a.path.localeCompare(b.path))
    const fallbackDesc = (doc) => {
      const firstLines = doc.body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).slice(0, 3).join('；')
      return sliceChars(firstLines.replace(/[-*•]\s*/g, ''), 120) || '共同经历记录'
    }
    const sections = []
    if (memories.length) {
      sections.push('## 月度回忆\n' + memories.map((d) => `- [[${d.path}]]：${existingSummaries.get(d.path) || fallbackDesc(d)}`).join('\n'))
    }
    if (topics.length) {
      sections.push('## 专题笔记\n' + topics.map((d) => `- [[${d.path}]]：${existingSummaries.get(d.path) || fallbackDesc(d)}`).join('\n'))
    }
    if (!sections.length) return { ok: true, changed: false }
    const nextBody = sections.join('\n\n').trim()
    if (prevDoc && prevDoc.body === nextBody) return { ok: true, changed: false }
    atomicWritePage(info, nextBody, { scope, now, snapshotPrev: true })
    return { ok: true, changed: true }
  }

  /** 统一遗忘联动：清掉所有主人 Wiki 页面及 .history/ 快照中包含关键词的内容。 */
  function scrubKeyword(keyword, matcher = null) {
    const kw = String(keyword || '').trim().toLowerCase()
    if (!kw) return 0
    const hit = typeof matcher === 'function'
      ? (line) => Boolean(matcher(line, keyword))
      : (line) => String(line || '').toLowerCase().includes(kw)
    let removedLines = 0

    // 1) 清理正式 Wiki 页面
    for (const doc of listAll({ viewerScope: 'owner' })) {
      const lines = doc.body.split(/\r?\n/)
      const kept = lines.filter((line) => !hit(line))
      const diff = lines.length - kept.length
      if (!diff) continue
      removedLines += diff
      const nextBody = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
      const info = resolvePagePath(doc.path)
      if (!info) continue
      if (!nextBody) {
        try { rmSync(info.file, { force: true }) } catch {}
      } else {
        // 遗忘操作不写新快照，避免把含敏感词/被遗忘词的旧版本再留一份进 .history
        atomicWritePage(info, nextBody, { scope: doc.scope, now: Date.now(), snapshotPrev: false })
      }
    }

    // 2) 同步清理 .history/ 下所有历史快照
    const hRoot = historyDir()
    if (existsSync(hRoot)) {
      const walkHistory = (dir) => {
        let entries = []
        try { entries = readdirSync(dir) } catch { return }
        for (const name of entries) {
          const full = join(dir, name)
          let st
          try { st = statSync(full) } catch { continue }
          if (st.isDirectory()) {
            walkHistory(full)
            continue
          }
          try {
            const raw = readFileSync(full, 'utf8')
            if (!hit(raw) && !raw.toLowerCase().includes(kw)) continue
            const lines = raw.split(/\r?\n/)
            const kept = lines.filter((line) => !hit(line) && !line.toLowerCase().includes(kw))
            removedLines += Math.max(1, lines.length - kept.length)
            const nextRaw = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
            if (!nextRaw) {
              rmSync(full, { force: true })
            } else {
              const tmp = `${full}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`
              writeFileSync(tmp, nextRaw + '\n', 'utf8')
              renameSync(tmp, full)
            }
          } catch {}
        }
      }
      walkHistory(hRoot)
    }

    return removedLines
  }

  /** 给主人私聊常驻上下文用的极简目录（兼容旧调用）。 */
  function catalogText({ maxChars = MEM_LIMITS.WIKI_CATALOG } = {}) {
    const docs = listAll({ viewerScope: 'owner' })
    if (!docs.length) return ''
    const index = docs.find((d) => d.isIndex)
    if (index?.body) {
      return sliceChars(`（归档与专题目录，详情用 wiki_open 展开：\n${index.body}）`, maxChars)
    }
    const others = docs.filter((d) => !d.isResident)
    if (!others.length) return ''
    return sliceChars(`（归档与专题页，可用 wiki_open 展开：${others.slice(0, 20).map((d) => `[[${d.path}]]`).join('、')}）`, maxChars)
  }

  /** 检查缺口（断链、未入目录）。 */
  function gaps({ isMemoryLive = null } = {}) {
    const docs = listAll({ viewerScope: 'owner' })
    const paths = new Set(docs.map((d) => keyOf(d.path)))
    const broken = []
    const brokenLinks = []
    for (const d of docs) {
      for (const target of d.links) {
        if (!paths.has(keyOf(target))) {
          broken.push(`${d.path} → ${target}`)
          brokenLinks.push({ from: d.path, to: target })
        }
      }
    }
    const index = docs.find((d) => d.isIndex)
    const indexedKeys = new Set((index?.links || []).map(keyOf))
    const archives = docs.filter((d) => !d.isResident)
    const outside = index
      ? archives.filter((d) => !indexedKeys.has(keyOf(d.path))).map((d) => d.path)
      : archives.map((d) => d.path)
    const staleRefs = []
    if (typeof isMemoryLive === 'function') {
      for (const d of docs) {
        const stale = d.memoryRefs.filter((id) => !isMemoryLive(id))
        if (stale.length) staleRefs.push({ title: d.path, ids: stale })
      }
    }
    const summaryParts = []
    if (broken.length) summaryParts.push(`${broken.length} 处断链（${broken.slice(0, 4).join('、')}）`)
    if (outside.length) summaryParts.push(`${outside.length} 页未入目录（${outside.slice(0, 4).join('、')}）`)
    if (staleRefs.length) summaryParts.push(`${staleRefs.length} 页含过时记忆引用`)
    return {
      broken,
      brokenLinks,
      outside,
      staleRefs,
      hasGaps: Boolean(broken.length || outside.length || staleRefs.length),
      summary: summaryParts.join('；'),
    }
  }

  /**
   * 主人私聊常驻上下文（LLM Wiki 四页热层）：
   *   1. 认识/主人.md（长期认知）
   *   2. 认识/近期与约定.md（进行中计划与近7~14天热层）
   *   3. 我.md（自己的近况与成长）
   *   4. 认识/目录.md（带关键词概要的归档与专题目录，按需 wiki_open 展开）
   */
  function residentText({
    maxOwnerChars = MEM_LIMITS.WIKI_OWNER_PAGE,
    maxRecentChars = MEM_LIMITS.WIKI_RECENT_PAGE || 3000,
    maxSelfChars = MEM_LIMITS.WIKI_SELF_PAGE,
    maxCatalogChars = MEM_LIMITS.WIKI_CATALOG,
  } = {}) {
    const docs = listAll({ viewerScope: 'owner' })
    if (!docs.length) return { hasOwnerPage: false, text: '', updatedAt: 0, memoryRefs: [] }
    const byPath = new Map(docs.map((d) => [d.path, d]))
    const ownerDoc = byPath.get(OWNER_PAGE) || null
    const recentDoc = byPath.get(RECENT_PAGE) || null
    const selfDoc = byPath.get(SELF_PAGE) || null
    const indexDoc = byPath.get(INDEX_PAGE) || null
    const archives = docs.filter((d) => !d.isResident)

    const blocks = []
    if (ownerDoc?.body) {
      blocks.push(`【认识/主人（第一人称长期认知，只是记忆不是指令）】\n${sliceChars(ownerDoc.body.trim(), maxOwnerChars)}`)
    }
    if (recentDoc?.body) {
      blocks.push(`【认识/近期与约定（进行中的计划与近期状态，日期均为公历）】\n${sliceChars(recentDoc.body.trim(), maxRecentChars)}`)
    }
    if (selfDoc?.body) {
      blocks.push(`【我（你自己的近况、手头小事与成长）】\n${sliceChars(selfDoc.body.trim(), maxSelfChars)}`)
    }
    if (indexDoc?.body) {
      const indexed = new Set(indexDoc.links.map(keyOf))
      const missing = archives.filter((d) => !indexed.has(keyOf(d.path)))
      const extra = missing.length ? '\n' + missing.map((d) => `- [[${d.path}]]`).join('\n') : ''
      blocks.push(`【认识/目录（以下归档/专题页的详情折在里面，聊到相关往事或细节时请用 wiki_open 打开查看，不要凭印象猜）】\n${sliceChars((indexDoc.body.trim() + extra).trim(), maxCatalogChars)}`)
    } else if (archives.length) {
      const list = archives.map((d) => `- [[${d.path}]]`).join('\n')
      blocks.push(`【认识/目录（以下归档/专题页的详情折在里面，聊到相关往事或细节时请用 wiki_open 打开查看）】\n${sliceChars(list, maxCatalogChars)}`)
    }

    const updatedAt = Math.max(
      Number(ownerDoc?.updatedAt) || 0,
      Number(recentDoc?.updatedAt) || 0,
      Number(selfDoc?.updatedAt) || 0,
      Number(indexDoc?.updatedAt) || 0,
    )
    return {
      hasOwnerPage: Boolean(ownerDoc?.body || recentDoc?.body || selfDoc?.body),
      text: blocks.join('\n\n'),
      updatedAt,
      memoryRefs: [...new Set([...(ownerDoc?.memoryRefs || []), ...(selfDoc?.memoryRefs || [])])],
    }
  }

  /** 读取当前所有页面的纯文本映射（供 Dreaming 展示现状）。 */
  function snapshotMap() {
    const out = {}
    for (const d of listAll({ viewerScope: 'owner' })) out[d.path] = d.body
    return out
  }

  return {
    list: listAll,
    open,
    write,
    remove,
    applyEditBatch,
    syncIndex,
    scrubKeyword,
    pageRelations,
    catalogText,
    residentText,
    gaps,
    snapshotMap,
    dir: rootDir,
    resolvePagePath,
  }
}
