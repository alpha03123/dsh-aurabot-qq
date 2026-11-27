// 隔离数据目录：只从线上目录「读」config.json / personas（real 模式再读 chatlog 与 activity），所有写入都在 out 目录里。
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'

export function prepareSandbox({ sourceDir, outDir, withRealChat = false }) {
  const data = resolve(outDir, 'data')
  if (resolve(sourceDir) === data || data.startsWith(resolve(sourceDir) + sep)) throw new Error('输出目录不能放在线上数据目录里面')
  rmSync(data, { recursive: true, force: true })
  mkdirSync(data, { recursive: true })
  const cfg = join(sourceDir, 'config.json')
  if (!existsSync(cfg)) throw new Error(`找不到线上配置：${cfg}`)
  copyFileSync(cfg, join(data, 'config.json'))
  if (existsSync(join(sourceDir, 'personas'))) cpSync(join(sourceDir, 'personas'), join(data, 'personas'), { recursive: true })
  if (withRealChat) {
    if (existsSync(join(sourceDir, 'chatlog'))) cpSync(join(sourceDir, 'chatlog'), join(data, 'chatlog'), { recursive: true })
    const act = join(sourceDir, 'modules-data', 'autonomy', 'activity.jsonl')
    if (existsSync(act)) {
      mkdirSync(join(data, 'modules-data', 'autonomy'), { recursive: true })
      copyFileSync(act, join(data, 'modules-data', 'autonomy', 'activity.jsonl'))
    }
  }
  return data
}

export function appendJsonl(file, rows) {
  if (!rows.length) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

/** 读 wiki：pages 以相对路径（不带 .md，分隔符统一 /）为键；.history 与 .tmp 不算页面。 */
export function readWiki(wikiDir) {
  const pages = {}
  const history = []
  if (!wikiDir || !existsSync(wikiDir)) return { pages, history }
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = relative(wikiDir, full).split(sep).join('/')
      if (statSync(full).isDirectory()) {
        if (rel === '.history' || rel.startsWith('.history/')) { walkHistory(full); continue }
        walk(full)
      } else if (/\.md$/i.test(name)) {
        pages[rel.replace(/\.md$/i, '')] = readFileSync(full, 'utf8')
      }
    }
  }
  const walkHistory = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walkHistory(full)
      else history.push(full)
    }
  }
  walk(wikiDir)
  return { pages, history }
}

/** 按页名末段找页面（如 '主人' 能匹配 '认识/主人'）。 */
export function page(pages, name) {
  if (pages[name] != null) return pages[name]
  const key = Object.keys(pages).find((k) => k.split('/').pop() === name)
  return key ? pages[key] : ''
}

export const HOT = ['主人', '近期与约定', '我', '目录']
export const hotText = (pages) => HOT.map((n) => page(pages, n)).join('\n')
export const allText = (pages) => Object.values(pages).join('\n')

export function hashPages(pages) {
  const h = createHash('sha1')
  for (const k of Object.keys(pages).sort()) h.update(k + '\0' + pages[k] + '\0')
  return h.digest('hex')
}

/** 按行比较（不计顺序），给人看 diff 用。 */
export function diffPages(before, after) {
  const out = []
  for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = (before[k] || '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)
    const b = (after[k] || '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)
    const sa = new Set(a)
    const sb = new Set(b)
    const added = b.filter((l) => !sa.has(l))
    const removed = a.filter((l) => !sb.has(l))
    if (added.length || removed.length) out.push({ page: k, added, removed, isNew: before[k] == null, deleted: after[k] == null })
  }
  return out
}

export function snapshotPages(pages, dest) {
  for (const [k, v] of Object.entries(pages)) {
    const f = join(dest, ...k.split('/')) + '.md'
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, v, 'utf8')
  }
}

/** 在目录下（含 .history）所有文本文件里找关键词，返回命中的文件。 */
export function grepFiles(dir, re) {
  const hits = []
  if (!dir || !existsSync(dir)) return hits
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) walk(full)
      else {
        try { if (re.test(readFileSync(full, 'utf8'))) hits.push(full) } catch {}
      }
    }
  }
  walk(dir)
  return hits
}
