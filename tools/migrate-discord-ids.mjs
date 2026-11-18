// 一次性迁移：Aurabot 数据里的「桥映射短号」换成真实的 Discord ID，配置切到内嵌协议桥。
//
// 背景：v11 时代 onebots 把 Discord snowflake 映射成随机短数字（主人 93807604349 之类），Aurabot 的配置、
// 会话表、记忆库里存的都是这些短号。换成 OneBot v12 后收到的是真实 ID，老数据要跟着换，不然认不出主人。
//
// 用法（Windows 上、这个 bot 的 DSH 停着时跑）：
//   node migrate-discord-ids.mjs --map <旧桥 onebots.db> --data <aurabot 数据目录> [--token-file <文件>] [--token-key DISCORD_TOKEN] [--proxy http://127.0.0.1:7897] [--dry]
// 会先把要改的文件备份到 <数据目录>/backups/pre-discord-ids-<时间>/。
//
// 规则：JSON / JSONL / memory.sqlite 里，键和字符串值中「前后不挨着数字的 8~12 位数字」如果在映射表里，就换成真实 ID；
// 存成数字的直接改成字符串（18~19 位的数字放进 JSON 会丢精度）。日志（logs/）不动。

import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'

const args = process.argv.slice(2)
const arg = (k, d = '') => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const DRY = args.includes('--dry')
const MAP_DB = arg('--map')
const DATA = arg('--data')
if (!MAP_DB || !DATA) { console.error('要 --map 和 --data'); process.exit(2) }

// 映射表：短号 → snowflake
const map = new Map()
{
  const db = new DatabaseSync(MAP_DB, { readOnly: true })
  for (const r of db.prepare('select string, number from id_map_discord').all()) {
    if (/^\d{15,22}$/.test(String(r.string))) map.set(String(r.number), String(r.string))
  }
  db.close()
}
console.log(`映射表 ${map.size} 条`)

const TOKEN_RE = /(?<!\d)(\d{8,12})(?!\d)/g
let changes = 0
const swapStr = (s) => String(s).replace(TOKEN_RE, (m) => { if (map.has(m)) { changes++; return map.get(m) } return m })
function walk(v) {
  if (Array.isArray(v)) return v.map(walk)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) out[swapStr(k)] = walk(val)
    return out
  }
  if (typeof v === 'number' && Number.isInteger(v) && map.has(String(v))) { changes++; return map.get(String(v)) }
  if (typeof v === 'string') return swapStr(v)
  return v
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const BACKUP = join(DATA, 'backups', `pre-discord-ids-${stamp}`)
function backup(file) {
  if (DRY) return
  const to = join(BACKUP, relative(DATA, file))
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(file, to)
}

// 要处理的文件：数据目录下的 json / jsonl（跳过日志、备份、浏览器资料、模块代码）
const SKIP = /[\\/](logs|backups|modules|node_modules|bridge|stickers|art|shots|outing-photos|shared)([\\/]|$)|[\\/](browser|chrome|edge|profile|Default|cdp)[^\\/]*[\\/]/i
function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) { if (!SKIP.test(p + '/')) yield* files(p) }
    else if (/\.(json|jsonl)$/i.test(name) && st.size < 50 * 1024 * 1024) yield p
  }
}

const report = []
for (const f of files(DATA)) {
  const before = changes
  const raw = readFileSync(f, 'utf8')
  let out
  try {
    if (f.endsWith('.jsonl')) out = raw.split('\n').map((l) => (l.trim() ? JSON.stringify(walk(JSON.parse(l))) : l)).join('\n')
    else out = JSON.stringify(walk(JSON.parse(raw)), null, raw.includes('\n  ') ? 2 : 0)
  } catch (error) { continue } // 不是合法 JSON 的不碰
  if (changes > before) {
    report.push(`${relative(DATA, f)}: ${changes - before} 处`)
    backup(f)
    if (!DRY) writeFileSync(f, out, 'utf8')
  }
}

// 记忆库：每张表都是 (key TEXT, json TEXT)
const memDb = join(DATA, 'memory.sqlite')
if (existsSync(memDb)) {
  const before = changes
  if (!DRY) { backup(memDb); for (const ext of ['-wal', '-shm']) if (existsSync(memDb + ext)) backup(memDb + ext) }
  const db = new DatabaseSync(memDb, { readOnly: DRY })
  const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name)
  for (const t of tables) {
    const cols = db.prepare(`pragma table_info("${t}")`).all().map((c) => c.name)
    if (cols.length !== 2 || cols[1] !== 'json') continue
    const k = cols[0]
    for (const row of db.prepare(`select "${k}" as k, json from "${t}"`).all()) {
      const c0 = changes
      const nk = swapStr(row.k)
      let nj = row.json
      try { nj = JSON.stringify(walk(JSON.parse(row.json))) } catch {}
      if (changes > c0 && !DRY) {
        if (nk !== row.k) db.prepare(`delete from "${t}" where "${k}" = ?`).run(row.k)
        db.prepare(`insert or replace into "${t}" ("${k}", json) values (?, ?)`).run(nk, nj)
      }
    }
  }
  if (!DRY) db.exec('pragma wal_checkpoint(TRUNCATE)')
  db.close()
  if (changes > before) report.push(`memory.sqlite: ${changes - before} 处`)
}

// 配置：切到内嵌协议桥
const cfgFile = join(DATA, 'config.json')
if (existsSync(cfgFile)) {
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
  const tokenFile = arg('--token-file')
  let token = ''
  if (tokenFile) {
    const key = arg('--token-key', 'DISCORD_TOKEN')
    const m = readFileSync(tokenFile, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'))
    token = m ? m[1].replace(/^['"]|['"]$/g, '').trim() : ''
    if (!token) { console.error(`${tokenFile} 里没找到 ${key}`); process.exit(3) }
  }
  cfg.gateway = 'discord'
  cfg.discord = { ...(cfg.discord || {}), ...(token ? { token } : {}), ...(arg('--proxy') ? { proxyUrl: arg('--proxy') } : {}), autoStart: true }
  delete cfg.snowluma // 老的 v11 桥地址：留着会被当成「接已有 OneBot 服务」
  // 机器人自己的 ID 以 token 为准
  if (token) {
    const id = Buffer.from(token.split('.')[0], 'base64').toString('utf8').trim()
    if (/^\d{15,22}$/.test(id)) { cfg.selfId = id; delete cfg.botQQ }
  }
  report.push(`config.json: gateway=discord${token ? '，token 已填' : ''}${arg('--proxy') ? '，代理 ' + arg('--proxy') : ''}，selfId=${cfg.selfId || cfg.botQQ || '(空)'}，ownerId=${cfg.ownerId || cfg.ownerQQ || '(空)'}`)
  if (!DRY) writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8')
}

console.log((DRY ? '【试跑，没写盘】\n' : `备份在 ${BACKUP}\n`) + report.map((r) => '  ' + r).join('\n'))
