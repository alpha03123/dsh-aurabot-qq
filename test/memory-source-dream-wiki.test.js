import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalize } from '../src/core/config.js'
import { applyPendingRestore } from '../src/core/backup.js'
import {
  createMemoryStore,
  matchSourceLine,
  normalizeSourceRef,
  parseDreamAudits,
  checkAuditFix,
} from '../src/features/memory.js'
import { createMemoryWiki, sanitizeWikiTitle, extractPageLinks, extractMemoryRefs, parseWikiMarkdown } from '../src/features/memory-wiki.js'
import memoryModule from '../src/modules/memory/index.js'

const localDayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const silentLog = { info() {}, warn() {}, debug() {}, error() {} }

function withTempDataDir(t) {
  const prev = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-mem-unified-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (prev === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function makeFakeDsh(responder) {
  const calls = []
  const dsh = {
    get: () => null,
    llm: {
      async *stream({ system, messages }) {
        const text = messages?.[0]?.content?.[0]?.text || ''
        const req = { system: String(system || ''), text }
        calls.push(req)
        const out = await responder(req, calls.length)
        yield { type: 'text-delta', text: String(out || '') }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
      listProviders: () => ['p'],
    },
  }
  return { dsh, calls }
}

function makeHub(logsByDay = {}) {
  const logs = new Map(Object.entries(logsByDay))
  const handoffs = new Map()
  return {
    chatLogDays: () => [...logs.keys()].sort(),
    chatLogOf: (day) => logs.get(day) || [],
    deleteChatLog: (day) => logs.delete(day),
    forgetChatLog: (qq, query) => {
      let n = 0
      for (const rows of logs.values()) {
        for (const r of rows) {
          if (r.chatId === `private:${qq}` && String(r.text || '').includes(query)) {
            r.forgottenAt = Date.now()
            n++
          }
        }
      }
      return n
    },
    setSessionHandoff: (chatId, text) => handoffs.set(chatId, text),
    getHandoff: (chatId) => handoffs.get(chatId) || '',
    resetChat: () => true,
    speakersOf: () => [],
    sessions: () => ({}),
    turnSenders: () => [],
    turnSendersAllOwner: () => true,
  }
}

test('sourceRef 归一化与原话锚定（matchSourceLine）', () => {
  assert.equal(normalizeSourceRef(null), undefined)
  assert.equal(normalizeSourceRef({}), undefined)
  const clean = normalizeSourceRef({ chatId: 'private:10001', day: '2026-11-20', t: 1763600000000, lineIndex: 3, quote: '  周六去西湖  ' })
  assert.deepEqual(clean, { chatId: 'private:10001', day: '2026-11-20', t: 1763600000000, lineIndex: 3, quote: '周六去西湖' })

  const t1 = new Date('2026-11-20T10:00:00').getTime()
  const t2 = new Date('2026-11-20T10:05:00').getTime()
  const entries = [
    { chatId: 'private:10001', uid: '10001', who: '主人', text: '今天天气不错', t: t1, _day: '2026-11-20', _logIndex: 0 },
    { chatId: 'private:10001', uid: '10001', who: '主人', text: '周六下午三点去西湖划船吧', t: t2, _day: '2026-11-20', _logIndex: 1 },
  ]
  const ref = matchSourceLine(entries, { text: '主人约周六下午三点去西湖划船', speaker: '10001', saidAt: t2, chatId: 'private:10001' })
  assert.equal(ref.day, '2026-11-20')
  assert.equal(ref.lineIndex, 1)
  assert.equal(ref.quote, '周六下午三点去西湖划船吧')
})

test('单一永久 L0 原话：readMemories(withContext:true) + searchOriginalLog 上下文窗口与硬隐私隔离', (t) => {
  withTempDataDir(t)
  const cfg = normalize({ ownerId: '10001', ownerName: '主人', memory: { enabled: true } })
  assert.equal(cfg.memory.keepChatlogDays, -1, '默认永久保留 L0 原话正本')
  const day = '2026-11-20'
  const baseT = new Date('2026-11-20T14:00:00').getTime()
  const hub = makeHub({
    [day]: [
      { chatId: 'private:10001', uid: '10001', who: '主人', text: '周末想放松一下', t: baseT },
      { chatId: 'private:10001', uid: '', who: 'bot', text: '想去哪玩呀', t: baseT + 30_000 },
      { chatId: 'private:10001', uid: '10001', who: '主人', text: '去西湖边喝桂花拿铁', t: baseT + 60_000 },
      { chatId: 'private:10001', uid: '', who: 'bot', text: '好呀我也想喝', t: baseT + 90_000 },
      { chatId: 'group:999', uid: '10001', who: '主人', text: '主人在群里说的私密吐槽', t: baseT + 100_000 },
      { chatId: 'group:999', uid: '20002', who: '小红', text: '今天去吃甜品', t: baseT + 105_000 },
      { chatId: 'group:999', uid: '20002', who: '小红', text: '我最爱吃抹茶冰淇淋', t: baseT + 110_000 },
      { chatId: 'group:999', uid: '', who: 'bot', text: '抹茶确实好吃', t: baseT + 115_000 },
    ],
  })
  const mem = createMemoryStore({ dsh: null, getConfig: () => cfg, hub, log: silentLog })

  const rOwner = mem.add({
    text: '主人周末想去西湖边喝桂花拿铁',
    about: '10001',
    aboutName: '主人',
    source: 'auto',
    chatId: 'private:10001',
    saidAt: baseT + 60_000,
    sourceRef: { chatId: 'private:10001', day, t: baseT + 60_000, lineIndex: 2, quote: '去西湖边喝桂花拿铁' },
  })
  const rGroup = mem.add({
    text: '小红最爱吃抹茶冰淇淋',
    about: '20002',
    aboutName: '小红',
    source: 'auto',
    chatId: 'group:999',
    saidAt: baseT + 110_000,
    sourceRef: { chatId: 'group:999', day, t: baseT + 110_000, lineIndex: 6, quote: '我最爱吃抹茶冰淇淋' },
  })

  // 1. 主人私聊按记忆指针展开原话上下文
  const ownerChat = { kind: 'private', userId: '10001', chatId: 'private:10001' }
  const expanded = mem.readMemories(ownerChat, rOwner.id, { withContext: true, before: 2, after: 2 })
  assert.equal(expanded.ok, true)
  assert.match(expanded.message, /周末想放松一下/)
  assert.match(expanded.message, /→ .*去西湖边喝桂花拿铁/)
  assert.match(expanded.message, /好呀我也想喝/)

  // 2. searchOriginalLog（search_chatlog 工具底层）按关键词返回前后上下文窗口
  const searched = mem.searchOriginalLog(ownerChat, { query: '桂花拿铁', context: 1 })
  assert.match(searched.message, /想去哪玩呀/)
  assert.match(searched.message, /→ .*去西湖边喝桂花拿铁/)
  assert.match(searched.message, /好呀我也想喝/)

  // 3. 隐私隔离：群聊猜中主人 ID 读不到；查群原话也不暴露同群主人发言
  const groupChat = { kind: 'group', groupId: '999', chatId: 'group:999' }
  const blocked = mem.readMemories(groupChat, rOwner.id, { speakers: ['20002'], withContext: true })
  assert.deepEqual(blocked.items, [])
  const groupExpanded = mem.readMemories(groupChat, rGroup.id, { speakers: ['20002'], withContext: true, before: 3, after: 3 })
  assert.match(groupExpanded.message, /抹茶冰淇淋/)
  assert.ok(!groupExpanded.message.includes('主人在群里说的私密吐槽'), '群聊展开原话不能带出主人发言')
  const groupSearch = mem.searchOriginalLog(groupChat, { query: '抹茶', context: 3 })
  assert.match(groupSearch.message, /今天去吃甜品/)
  assert.ok(!groupSearch.message.includes('主人在群里说的私密吐槽'), '群聊 search_chatlog 也绝不带出主人发言')

  // 4. 统一忘记：一次同时标记主库与 chatlog，忘记后搜不到原话
  const f = mem.handleCommand(ownerChat, '忘掉桂花拿铁')
  assert.equal(f.ok, true)
  const afterForget = mem.searchOriginalLog(ownerChat, { query: '桂花拿铁', context: 1 })
  assert.ok(!afterForget.message.includes('去西湖边喝桂花拿铁'))
})

test('Dreaming 离线原话核对（auditMemories）：支持 keep / fix / drop 与防幻觉校验', async (t) => {
  withTempDataDir(t)
  const day = '2026-11-20'
  const baseT = new Date('2026-11-20T20:00:00').getTime()
  const cfg = normalize({ ownerId: '10001', ownerName: '主人', model: { provider: 'p', model: 'm' }, memory: { enabled: true, dreamAudit: true } })
  const hub = makeHub({
    [day]: [
      { chatId: 'private:10001', uid: '10001', who: '主人', text: '哈哈我开玩笑的，才不是要去南极买企鹅呢', t: baseT },
      { chatId: 'private:10001', uid: '10001', who: '主人', text: '其实我买了两张周日下午 3 点的电影票', t: baseT + 60_000 },
      { chatId: 'private:10001', uid: '10001', who: '主人', text: '我平时喝美式不加糖', t: baseT + 120_000 },
    ],
  })

  assert.equal(checkAuditFix('主人买了 99 张电影票', ['其实我买了两张周日下午 3 点的电影票']).ok, false)
  assert.equal(checkAuditFix('主人买了两张周日下午 3 点的电影票', ['其实我买了两张周日下午 3 点的电影票']).ok, true)

  let auditResponse = ''
  const { dsh, calls } = makeFakeDsh(async () => auditResponse)
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log: silentLog })

  const mDrop = mem.add({
    text: '主人要去南极买企鹅',
    about: '10001',
    source: 'auto',
    chatId: 'private:10001',
    saidAt: baseT,
    sourceRef: { chatId: 'private:10001', day, t: baseT, lineIndex: 0, quote: '才不是要去南极买企鹅呢' },
  })
  const mFix = mem.add({
    text: '主人买了周六上午的电影票',
    about: '10001',
    source: 'auto',
    chatId: 'private:10001',
    saidAt: baseT + 60_000,
    sourceRef: { chatId: 'private:10001', day, t: baseT + 60_000, lineIndex: 1, quote: '其实我买了两张周日下午 3 点的电影票' },
  })
  const mKeep = mem.add({
    text: '主人喝美式不加糖',
    about: '10001',
    source: 'auto',
    chatId: 'private:10001',
    saidAt: baseT + 120_000,
    sourceRef: { chatId: 'private:10001', day, t: baseT + 120_000, lineIndex: 2, quote: '我平时喝美式不加糖' },
  })

  auditResponse = JSON.stringify({
    audits: [
      { id: mDrop.id, action: 'drop', reason: '只是开玩笑' },
      { id: mFix.id, action: 'fix', text: '主人买了两张周日下午 3 点的电影票', reason: '时间更正' },
      { id: mKeep.id, action: 'keep', reason: '与原话一致' },
    ],
  })
  assert.equal(parseDreamAudits(auditResponse).length, 3)

  const res1 = await mem.auditMemories({ force: true })
  assert.equal(res1.checked, 3)
  assert.equal(res1.fixed, 1)
  assert.equal(res1.dropped, 1)

  const all = mem.list('')
  assert.ok(all.find((x) => x.id === mDrop.id).invalidAt > 0)
  assert.equal(all.find((x) => x.id === mFix.id).text, '主人买了两张周日下午 3 点的电影票')
  assert.ok(all.find((x) => x.id === mKeep.id).auditedAt > 0)

  const beforeCalls = calls.length
  const res2 = await mem.auditMemories({ force: true })
  assert.equal(res2.checked, 0)
  assert.equal(calls.length, beforeCalls)
})

test('第一人称认识页（memory-wiki）与睡后完整 Dreaming 闭环（sessionRollover dream:true）', async (t) => {
  const dir = withTempDataDir(t)
  assert.equal(sanitizeWikiTitle('../evil'), '')
  assert.equal(sanitizeWikiTitle('主人.md'), '主人')
  assert.deepEqual(extractPageLinks('关于 [[主人]] 和 [[西湖之行]]'), ['主人', '西湖之行'])
  assert.deepEqual(extractMemoryRefs('记得这件事 #a1b2c3d4'), ['a1b2c3d4'])

  const wiki = createMemoryWiki({ directory: () => join(dir, 'memory-wiki'), log: silentLog })
  assert.equal(wiki.write('../bad', 'x').ok, false)
  assert.equal(wiki.write('主人', '密码是 123456').ok, false)
  assert.equal(wiki.write('我', '我喜欢在安静的晚上想想 [[主人]]。').ok, true)

  const day = localDayKey()
  const baseT = Date.now() - 600_000
  const cfg = normalize({
    ownerId: '10001',
    ownerName: '主人',
    model: { provider: 'p', model: 'm' },
    memory: { enabled: true, dailyConsolidate: true, wiki: true, dreamAudit: true },
  })
  const hub = makeHub({
    [day]: [
      { chatId: 'private:10001', uid: '10001', who: '主人', text: '我最近在学手冲咖啡，买了个 V60 滤杯', t: baseT },
      { chatId: 'private:10001', uid: '', who: 'bot', text: '好厉害呀，明天冲给我看', t: baseT + 30_000 },
    ],
  })
  let auditCalls = 0
  let wikiRefreshCalls = 0
  const { dsh } = makeFakeDsh(async ({ system }) => {
    if (system.includes('整理长期记忆')) {
      return JSON.stringify({
        facts: [{ op: 'add', text: '主人最近在学手冲咖啡，买了 V60 滤杯', about: '主人', speaker: '10001', about_id: '10001', status: 'fact', importance: 0.7, tier: 2, said: '21:00' }],
      })
    }
    if (system.includes('离线记忆核对助手')) { auditCalls++; return '{"audits":[]}' }
    if (system.includes('写给自己的认识页')) { wikiRefreshCalls++; return '# 主人\n\n他最近迷上了手冲咖啡，买了 V60 滤杯。' }
    if (system.includes('留给自己明天醒来接着聊')) return '今晚聊了手冲咖啡和 V60 滤杯。'
    return '{"self":[]}'
  })

  const toolRegistrations = []
  const mem = memoryModule.setup({
    core: { hub, http: { query: () => ({}), body: async () => ({}) } },
    dsh,
    config: () => cfg,
    log: silentLog,
    context() {},
    rule() {},
    on() {},
    every() {},
    tool(fn) { toolRegistrations.push(fn) },
    route() {},
  })

  // 验证统一工具链：主库已有 search_chatlog，且 wiki 工具只对主人私聊开放
  const ownerTools = toolRegistrations.flatMap((fn) => fn({ chat: { kind: 'private', userId: '10001', chatId: 'private:10001' }, level: 'full', sessionId: 's1' }))
  const groupTools = toolRegistrations.flatMap((fn) => fn({ chat: { kind: 'group', groupId: '999', chatId: 'group:999' }, level: 'social', sessionId: 's2' }))
  assert.ok(ownerTools.some((x) => x.name === 'search_chatlog'))
  assert.ok(ownerTools.some((x) => x.name === 'wiki_open'))
  assert.ok(ownerTools.some((x) => x.name === 'wiki_write'))
  assert.ok(!groupTools.some((x) => x.name === 'wiki_open'))

  // 睡后 sessionRollover({ dream: true }) 跑完完整闭环：提炼带 sourceRef + 原话核对（只跑一次！）+ 认识页更新 + 交接
  const r = await mem.sessionRollover('private:10001', { day, dream: true })
  assert.equal(r.ok, true)
  assert.equal(auditCalls, 1, 'sessionRollover(dream:true) 中原话核对只执行一次，不重复调用')
  assert.equal(wikiRefreshCalls, 1)
  const items = mem.list('手冲咖啡')
  assert.equal(items.length, 1)
  assert.equal(items[0].sourceRef?.day, day)
  assert.equal(items[0].sourceRef?.lineIndex, 0)
  assert.equal(hub.chatLogDays().length, 1, '默认永久保留 L0 原话不被删除')
  assert.match(hub.getHandoff('private:10001'), /手冲咖啡/)
  const ownerCtx = mem.contextFor({ kind: 'private', userId: '10001', chatId: 'private:10001' }, '')
  assert.match(ownerCtx, /认识页/)
  const groupCtx = mem.contextFor({ kind: 'group', groupId: '999', chatId: 'group:999' }, '')
  assert.ok(!groupCtx.includes('认识页'))

  // 无新记忆也无本页缺口时，再次 refreshWiki 自动跳过不再重写
  const rSkip = await mem.wiki.refresh()
  assert.equal(rSkip.skipped, true)
  assert.equal(wikiRefreshCalls, 1)
})

test('审查加固：相关性门槛、空 ownerId 防越权、统一忘记联动 wiki、wiki 边界与 backup 轮换', async (t) => {
  const dir = withTempDataDir(t)

  // 1. matchSourceLine 不再把毫不相干的寒暄错锚定成 sourceRef
  const unrelated = matchSourceLine(
    [{ chatId: 'private:10001', uid: '10001', who: '主人', text: '晚安', t: Date.now(), _day: '2026-11-20', _logIndex: 0 }],
    { text: '主人喜欢去北海道滑雪', speaker: '10001', saidAt: Date.now(), chatId: 'private:10001' },
  )
  assert.equal(unrelated, undefined)

  // 2. wiki 标题安全（Windows 保留名、尾随点、控制字符）、frontmatter 容错、大小写不敏感删除、目录链接缺口
  assert.equal(sanitizeWikiTitle('CON'), '')
  assert.equal(sanitizeWikiTitle('nul.md'), '')
  assert.equal(sanitizeWikiTitle('com1'), '')
  assert.equal(sanitizeWikiTitle('hello.'), '')
  assert.equal(sanitizeWikiTitle('bad\x07title'), '')
  assert.deepEqual(extractMemoryRefs('正文 #a1b2c3d4 与代码块 `#deadbeef` 与 ```\n#12345678\n```'), ['a1b2c3d4'])
  const hrDoc = parseWikiMarkdown('---\n这不是 yaml 开头\n---\n正文内容')
  assert.deepEqual(hrDoc.meta, {})
  assert.match(hrDoc.body, /这不是 yaml 开头/)

  const wiki = createMemoryWiki({ directory: () => join(dir, 'memory-wiki'), log: silentLog })
  assert.equal(wiki.write('Alice', '关于 Alice 的笔记').ok, true)
  assert.equal(wiki.write('目录', '这里只提到了 Alice 但没写双链').ok, true)
  assert.deepEqual(wiki.gaps().outside, ['Alice'], '目录未用 [[Alice]] 链接时应识别为未入目录')
  assert.equal(wiki.remove('alice').ok, true, 'remove 应支持大小写不敏感删除')
  assert.equal(wiki.open('Alice').ok, false)

  // 3. 空 ownerId 时不能触发主人私聊越权（既拿不到 wiki 工具，也跨聊天读不到原话）
  const emptyOwnerCfg = normalize({ ownerId: '', memory: { enabled: true } })
  const day = '2026-11-20'
  const baseT = new Date('2026-11-20T12:00:00').getTime()
  const hub = makeHub({
    [day]: [{ chatId: 'private:10001', uid: '10001', who: 'A', text: '绝密原话', t: baseT }],
  })
  const memEmpty = createMemoryStore({ dsh: null, getConfig: () => emptyOwnerCfg, hub, log: silentLog })
  const badWin = memEmpty.readOriginalWindow({ kind: 'private', userId: '', chatId: 'private:' }, { chatId: 'private:10001', day, lineIndex: 0 })
  assert.equal(badWin.ok, false, 'ownerId 为空时不能伪装成主人私聊跨聊天读原话')

  // 4. 统一忘记联动清掉 memory-wiki 中匹配的行；restore 清理 supersededText / auditedAt
  const ownerCfg = normalize({ ownerId: '10001', ownerName: '主人', memory: { enabled: true } })
  const mem = createMemoryStore({ dsh: null, getConfig: () => ownerCfg, hub, log: silentLog })
  assert.equal(mem.wiki.write('主人', '喜欢喝美式\n对芒果严重过敏\n喜欢猫').ok, true)
  const fr = mem.handleCommand({ kind: 'private', userId: '10001', chatId: 'private:10001' }, '忘掉芒果过敏')
  assert.equal(fr.ok, true)
  assert.equal(fr.wikiScrubbed, 1)
  const afterWiki = mem.wiki.open('主人')
  assert.equal(afterWiki.ok, true)
  assert.ok(!afterWiki.page.body.includes('芒果'))
  assert.match(afterWiki.page.body, /喜欢猫/)

  // 5. backup.applyPendingRestore 恢复旧记忆时轮换清走较新的孤儿 memory-wiki 文件
  const stage = join(dir, '.restore')
  mkdirSync(join(stage, 'memory-wiki', '认识'), { recursive: true })
  writeFileSync(join(stage, 'memories.json'), JSON.stringify({ rev: 1, items: [] }))
  writeFileSync(join(stage, 'memory-wiki', '认识', '旧页.md'), '旧内容')
  writeFileSync(join(dir, '.restore-pending.json'), JSON.stringify({ dataDir: dir }))
  assert.equal(existsSync(join(dir, 'memory-wiki', '认识', '主人.md')), true)
  applyPendingRestore(123456)
  assert.equal(existsSync(join(dir, 'memory-wiki', '认识', '主人.md')), false, '较新的孤儿认识页应被移入 pre-restore 备份')
  assert.equal(existsSync(join(dir, 'memory-wiki', '认识', '旧页.md')), true)
  assert.equal(existsSync(join(dir, 'backups', 'pre-restore-123456', 'memory-wiki', '认识', '主人.md')), true)
})
