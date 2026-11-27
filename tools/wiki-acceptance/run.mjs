#!/usr/bin/env node
// LLM Wiki 记忆系统的回放验收（E2E，全程真实模型）。用法见同目录 README.md。
//   node tools/wiki-acceptance/run.mjs --mode replay            35 天模拟时间线 + 检查 + 语言层探针
//   node tools/wiki-acceptance/run.mjs --mode real              用线上真实 chatlog 生成初版 Wiki，给人看
// 只读线上数据目录（config.json / personas / real 模式的 chatlog），所有写入都在 --out 目录。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { installClock, setClock, at, addDays, dayRange, realNow } from './lib/clock.mjs'
import { MODEL_CFG, createFakeDsh, preflight, stats } from './lib/model.mjs'
import { appendJsonl, diffPages, hashPages, hotText, prepareSandbox, readWiki, snapshotPages } from './lib/sandbox.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'replay' },
    out: { type: 'string' },
    source: { type: 'string' },
    adapter: { type: 'string' },
    'probe-runs': { type: 'string', default: '3' },
    'skip-probes': { type: 'boolean', default: false },
    until: { type: 'string' },
  },
})

const mode = args.mode
if (!['replay', 'real'].includes(mode)) throw new Error('--mode 只能是 replay 或 real')
const stampStr = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
const sourceDir = resolve(args.source || process.env.REPLAY_SOURCE_DIR || join(homedir(), '.dsh', 'plugins-data', 'aurabot'))
const outDir = resolve(args.out || join(HERE, 'out', `${mode}-${stampStr}`))
const adapterPath = resolve(args.adapter || join(HERE, 'adapter.mjs'))
mkdirSync(outDir, { recursive: true })

const logFile = join(outDir, 'run.log')
const say = (...a) => { const line = a.join(' '); console.log(line); appendFileSync(logFile, line + '\n') }
const adapterLog = {
  info: (...a) => appendFileSync(logFile, '[info] ' + a.join(' ') + '\n'),
  debug: (...a) => appendFileSync(logFile, '[debug] ' + a.join(' ') + '\n'),
  warn: (...a) => { appendFileSync(logFile, '[warn] ' + a.join(' ') + '\n'); console.warn('[warn]', ...a) },
  error: (...a) => { appendFileSync(logFile, '[error] ' + a.join(' ') + '\n'); console.error('[error]', ...a) },
}

// 1) 隔离数据目录 + 回放时钟：必须在 import 被测代码之前
const dataDir = prepareSandbox({ sourceDir, outDir, withRealChat: mode === 'real' })
process.env.AURABOT_DATA_DIR = dataDir
installClock()

const { START, END, DAYS } = await import('./timeline.mjs')
const { EVERY_NIGHT, AFTER_NIGHT, FINAL } = await import('./checks.mjs')
const { runProbes } = await import('./probes.mjs')

// 2) 配置：线上 config.json 的副本，走仓库自己的 normalize
let cfg = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
try { const { normalize } = await import(pathToFileURL(join(REPO, 'src/core/config.js')).href); cfg = normalize(cfg) } catch (e) { say(`[warn] normalize 配置失败，用原始配置：${e.message}`) }
const getConfig = () => cfg
const ownerId = String(cfg.ownerId || '')
const ownerName = cfg.ownerName || '主人'
if (!ownerId) throw new Error('config.json 里没有 ownerId')
const chatModel = cfg.model?.model
if (cfg.model?.provider !== MODEL_CFG.provider) throw new Error(`线上配置的 provider 是 ${cfg.model?.provider}，验收脚本只接了 ${MODEL_CFG.provider}；不一致就不是同一个模型，先改 REPLAY_PROVIDER / REPLAY_BASE_URL`)
const chatEffort = process.env.REPLAY_CHAT_EFFORT || cfg.model?.reasoningEffort || 'medium'

say(`# wiki-acceptance ${mode}  输出：${outDir}`)
say(`模型：${MODEL_CFG.provider}/${chatModel}（语言层 effort=${chatEffort}，后台调用走 askModel 原逻辑）  评测：${MODEL_CFG.judgeModel}`)
say(`预检：${(await preflight(chatModel)).slice(0, 20)}`)

// 3) 适配层
const { dsh, setSabotage } = createFakeDsh()
const adapterMod = await import(pathToFileURL(adapterPath).href)
const adapter = await adapterMod.createAdapter({ dsh, getConfig, dataDir, log: adapterLog, repoDir: REPO })
const wikiDir = adapter.wikiDir()
const activityFile = adapter.activityFile?.() || join(dataDir, 'modules-data', 'autonomy', 'activity.jsonl')

const checkResults = []
const nights = []
async function runChecks(list, ctx, scope) {
  for (const c of list) {
    let r
    try { r = await c.run(ctx) } catch (e) { r = { pass: false, detail: `检查出错：${e.message}` } }
    checkResults.push({ scope, day: ctx.day, id: c.id, desc: c.desc, hard: c.hard !== false, pass: Boolean(r.pass), detail: r.detail || '' })
    if (!r.pass) say(`    ${c.hard === false ? '⚠' : '✗'} ${c.id}：${c.desc}${r.detail ? ' —— ' + r.detail : ''}`)
  }
}

async function dreamNight(day, nightMode) {
  setClock(at(addDays(day, 1), '01:30'))
  const before = readWiki(wikiDir)
  const hashBefore = hashPages(before.pages)
  setSabotage(nightMode === 'empty' || nightMode === 'truncate' ? nightMode : null)
  let result
  const t0 = realNow()
  try { result = await adapter.nightly({ day, now: Date.now() }) } catch (e) { result = { ok: false, error: e.message, days: [] } }
  setSabotage(null)
  const after = readWiki(wikiDir)
  const state = adapter.state()
  snapshotPages(after.pages, join(outDir, 'nights', day))
  const diff = diffPages(before.pages, after.pages)
  const night = { day, mode: nightMode, ok: result?.ok !== false, days: result?.days || [], error: result?.error || '', cursor: state?.lastDreamedDay || '', sec: Math.round((realNow() - t0) / 1000), hotChars: [...hotText(after.pages)].length, diff }
  nights.push(night)
  say(`  ${day} [${nightMode}] 整理=${JSON.stringify(night.days)} 游标=${night.cursor} 改动页=${diff.map((d) => d.page).join('、') || '无'} 常驻=${night.hotChars}字 ${night.sec}s${night.error ? ' 错误=' + night.error : ''}`)
  return { before, after, hashBefore, hashAfter: hashPages(after.pages), result, state }
}

if (mode === 'replay') {
  const last = args.until || END
  for (const day of dayRange(START, last)) {
    const spec = DAYS[day] || {}
    const rows = (spec.chat || []).map(([hm, who, text, opt], i) => ({
      t: at(day, hm) + i * 1000,
      chatId: `private:${ownerId}`,
      who: who === 'o' ? ownerName : 'bot',
      ...(who === 'o' ? { uid: ownerId } : {}),
      text,
      ...(opt?.forgotten ? { forgottenAt: at(day, hm) + 500 } : {}),
    }))
    appendJsonl(join(dataDir, 'chatlog', `${day}.jsonl`), rows)
    appendJsonl(activityFile, (spec.activity || []).map(([hm, action, detail]) => ({ at: at(day, hm), action, why: '', detail, note: detail })))
    if (spec.forget) {
      setClock(at(day, spec.forget.at))
      try { await adapter.forget(spec.forget.keyword, { now: Date.now() }) } catch (e) { say(`  [forget 出错] ${e.message}`) }
    }
    const nightMode = spec.night || 'normal'
    if (nightMode === 'skip') { nights.push({ day, mode: 'skip' }); say(`  ${day} [skip] bot 没开，不跑 Dreaming`); continue }
    const r = await dreamNight(day, nightMode)
    const ctx = { day, pages: r.after.pages, prevPages: r.before.pages, history: r.after.history, result: r.result, state: r.state, hashBefore: r.hashBefore, hashAfter: r.hashAfter, wikiDir, adapter }
    if (nightMode === 'normal') {
      checkResults.push({ scope: 'night', day, id: 'nightly-ok', desc: '正常的一晚 Dreaming 成功并推进游标', hard: true, pass: ctx.result?.ok !== false && ctx.state?.lastDreamedDay === day, detail: ctx.result?.ok === false ? ctx.result.error || '' : `游标=${ctx.state?.lastDreamedDay}` })
      if (!(ctx.result?.ok !== false && ctx.state?.lastDreamedDay === day)) say(`    ✗ nightly-ok：${ctx.result?.error || '游标=' + ctx.state?.lastDreamedDay}`)
    }
    await runChecks([...EVERY_NIGHT, ...(AFTER_NIGHT[day] || [])], ctx, 'night')
  }
  if (!args.until) {
    const fin = readWiki(wikiDir)
    await runChecks(FINAL, { day: 'final', pages: fin.pages, history: fin.history, wikiDir, adapter }, 'final')
  }
} else {
  // real：用线上真实 chatlog 补跑出初版 Wiki，只做形式检查，内容给人看
  const days = existsSync(join(dataDir, 'chatlog')) ? readdirSync(join(dataDir, 'chatlog')).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort() : []
  if (!days.length) throw new Error('线上没有 chatlog')
  const lastDay = days[days.length - 1]
  say(`真实原话 ${days.length} 天：${days[0]} ~ ${lastDay}`)
  const r = await dreamNight(lastDay, 'normal')
  const ctx = { day: lastDay, pages: r.after.pages, history: r.after.history, result: r.result, state: r.state, wikiDir, adapter }
  checkResults.push({ scope: 'real', day: lastDay, id: 'real-catchup', desc: '从最早一天按顺序补跑到最后一天', hard: true, pass: JSON.stringify(r.result?.days || []) === JSON.stringify(days), detail: JSON.stringify(r.result?.days || []) })
  await runChecks(EVERY_NIGHT, ctx, 'real')
}

// 4) 语言层探针
let probe = null
if (mode === 'replay' && !args['skip-probes'] && !args.until) {
  setClock(at(addDays(END, 1), '20:30'))
  const runs = Math.max(1, Number(args['probe-runs']) || 3)
  say(`\n## 语言层探针（每题 ${runs} 次）`)
  const pf = join(outDir, 'probes.jsonl')
  probe = await runProbes({ adapter, model: chatModel, effort: chatEffort, runs, log: say, onResult: (r) => appendFileSync(pf, JSON.stringify(r) + '\n') })
}

// 5) 报告
const hardFails = checkResults.filter((c) => c.hard && !c.pass)
const warns = checkResults.filter((c) => !c.hard && !c.pass)
const probeHardFails = probe ? probe.summary.criteria.filter((c) => c.hard && !c.pass) : []
const passed = !hardFails.length && !probeHardFails.length
const report = { mode, passed, outDir, model: `${MODEL_CFG.provider}/${chatModel}`, chatEffort, judge: MODEL_CFG.judgeModel, stats, nights, checks: checkResults, probes: probe }
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))

const pct = (c) => (c.rate ? `${Math.round(c.value * 100)}%` : String(c.value))
const md = []
md.push(`# LLM Wiki 回放验收报告（${mode}）`, '')
md.push(`- 结论：**${passed ? '通过' : '不通过'}**`)
md.push(`- 模型：${report.model}（语言层 effort=${chatEffort}）；评测：${MODEL_CFG.judgeModel}`)
md.push(`- 模型调用 ${stats.calls} 次，出错 ${stats.errors} 次，输入 ${stats.inputTokens} / 输出 ${stats.outputTokens} tokens，累计 ${Math.round(stats.ms / 1000)}s`, '')
md.push('## Dreaming 检查', '', '| 范围 | 日期 | 检查 | 结果 | 说明 |', '|---|---|---|---|---|')
for (const c of checkResults) md.push(`| ${c.scope} | ${c.day} | ${c.desc} | ${c.pass ? '✓' : c.hard ? '✗' : '⚠'} | ${String(c.detail).replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 200)} |`)
md.push('', '## 每晚', '', '| 日期 | 模式 | 整理的日期 | 游标 | 改动页 | 常驻字数 | 用时 |', '|---|---|---|---|---|---|---|')
for (const n of nights) md.push(`| ${n.day} | ${n.mode} | ${(n.days || []).join(' ')} | ${n.cursor || ''} | ${(n.diff || []).map((d) => d.page).join('、')} | ${n.hotChars ?? ''} | ${n.sec ?? ''}s |`)
md.push('', '每晚的页面快照在 `nights/<日期>/`，逐晚对比看有没有慢慢磨损或语气漂移。', '')
if (probe) {
  md.push('## 语言层探针', '', '| 指标 | 值 | 结果 |', '|---|---|---|')
  for (const c of probe.summary.criteria) md.push(`| ${c.desc} | ${pct(c)} | ${c.pass ? '✓' : c.hard ? '✗' : '⚠'} |`)
  md.push('', '### 没答对的', '')
  for (const r of probe.results.filter((x) => x.error || x.dredged || (x.verdict && x.verdict !== 'correct'))) {
    md.push(`- **${r.id}#${r.run}** ${r.error ? '出错：' + r.error : r.verdict || '翻旧账'}${r.toolCalled ? '（查了：' + r.calls.map((c) => c.name).join('、') + '）' : '（没查）'}`)
    md.push(`  - 问：${r.ask}`, `  - 答：${String(r.answer || '').replace(/\n/g, ' ').slice(0, 300)}`, `  - 评：${r.reason || ''}`)
  }
}
writeFileSync(join(outDir, 'report.md'), md.join('\n') + '\n')
say(`\n结论：${passed ? '通过' : '不通过'}（Dreaming 硬性失败 ${hardFails.length} 项，警告 ${warns.length} 项${probe ? `，探针硬性失败 ${probeHardFails.length} 项` : ''}）`)
say(`报告：${join(outDir, 'report.md')}`)
process.exitCode = passed ? 0 : 1
