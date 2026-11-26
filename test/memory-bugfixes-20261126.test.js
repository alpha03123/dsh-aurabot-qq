import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createMemoryStore } from '../src/features/memory.js'

const log = { info () {}, warn () {}, debug () {}, error () {} }
const OWNER = '10001'
const OWNER_CHAT = `private:${OWNER}`

function makeTempDir (tag) {
  const dir = mkdtempSync(join(tmpdir(), `aurabot-fix-${tag}-`))
  mkdirSync(dir, { recursive: true })
  return dir
}

test('mergeGroups strips # from returned IDs and prevents cross-day merging of episodic self/event items', async (t) => {
  const dir = makeTempDir('merge')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  process.env.AURABOT_DATA_DIR = dir

  const cfg = normalize({
    enabled: true,
    ownerId: OWNER,
    ownerName: '主人',
    model: { provider: 'fake', model: 'fake-1' },
    memory: { enabled: true, mergeGroups: true, injectStyle: false },
  })
  const hub = { chatLogOf: () => [], chatLogDays: () => [], deleteChatLog: () => {}, groupNames: new Map(), speakersOf: () => [] }
  let seenPrompts = []
  let styleCalls = 0
  const dsh = {
    llm: {
      async *stream (params) {
        const system = String(params?.system || '')
        const content = params?.messages?.[0]?.content
        const text = Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : ''
        if (system.includes('说话习惯')) {
          styleCalls++
          yield { type: 'text-delta', text: '["不该调用"]' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (system.includes('同一个人名下')) {
          seenPrompts.push(text)
          const ids = [...text.matchAll(/#([0-9a-f]{8})/g)].map((m) => `#${m[1]}`) // return with leading '#'
          const merges = ids.length >= 2 ? [{ ids: ids.slice(0, 2), text: '合并后的测试条目' }] : []
          yield { type: 'text-delta', text: JSON.stringify({ merges }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', text: '[]' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
      listProviders: () => ['fake'],
    },
    get (n) { return n === 'llm' ? dsh.llm : null },
  }

  const store = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  const day1 = new Date('2026-11-25T09:00:00+08:00').getTime()
  const day2 = new Date('2026-11-26T09:00:00+08:00').getTime()

  // 1) Cross-day episodic (kind: 'event') items: should NOT be merged across different days
  store.addEvent({ text: '吃了鲜肉小笼包当早饭', tags: ['生活'], importance: 0.4, saidAt: day1 })
  store.addEvent({ text: '吃了三明治配热牛奶当早饭', tags: ['生活'], importance: 0.4, saidAt: day2 })
  store.addEvent({ text: '下午去公园散步', tags: ['生活'], importance: 0.4, saidAt: day2 })
  store.addEvent({ text: '晚上折了个星星书签', tags: ['生活'], importance: 0.4, saidAt: day2 })

  // 2) Same-day facts about owner: model returns IDs WITH '#' prefix -> MUST strip '#' and merge
  store.add({ text: '主人很喜欢喝冰美式', about: OWNER, aboutName: '主人', source: 'auto', chatId: OWNER_CHAT, importance: 0.4, saidAt: day2 })
  store.add({ text: '主人平时偏爱喝冰美式咖啡', about: OWNER, aboutName: '主人', source: 'auto', chatId: OWNER_CHAT, importance: 0.4, saidAt: day2 })
  store.add({ text: '主人周末喜欢逛博物馆', about: OWNER, aboutName: '主人', source: 'auto', chatId: OWNER_CHAT, importance: 0.4, saidAt: day2 })
  store.add({ text: '主人最近在整理桌面线材', about: OWNER, aboutName: '主人', source: 'auto', chatId: OWNER_CHAT, importance: 0.4, saidAt: day2 })

  await store.consolidate({ includeToday: true })

  // Prompt must include date stamps
  assert.ok(seenPrompts.some((p) => p.includes('[2026-11-25]') && p.includes('[2026-11-26]')), 'mergeGroups prompt must include date stamps')
  // Cross-day breakfasts must both remain intact
  const events = store.recentEvents(20)
  assert.equal(events.length, 4, 'cross-day episodic events must NOT be merged')
  // Facts with '#' prefix returned by model MUST be merged cleanly
  const ownerFacts = store.list('').filter((m) => String(m.about) === OWNER && !m.invalidAt)
  assert.equal(ownerFacts.length, 3, 'same-group facts returned with # prefix must merge (4 -> 3)')
  assert.ok(ownerFacts.some((m) => m.text === '合并后的测试条目'))
  // injectStyle=false must skip learnSelfStyle
  assert.equal(styleCalls, 0, 'learnSelfStyle should not call model when injectStyle is false')
})

test('extractFacts op=outdated rolls back target cleanly when replacement add fails', async (t) => {
  const dir = makeTempDir('rollback')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  process.env.AURABOT_DATA_DIR = dir

  const cfg = normalize({
    enabled: true,
    ownerId: OWNER,
    ownerName: '主人',
    model: { provider: 'fake', model: 'fake-1' },
    memory: { enabled: true, injectStyle: false },
  })
  const today = new Date().toISOString().slice(0, 10)
  let oldId = ''
  const hub = {
    chatLogDays: () => [today],
    chatLogOf: (d) => d === today ? [
      { t: Date.now() - 2000, chatId: OWNER_CHAT, who: '主人', uid: OWNER, text: '我换密码了' },
      { t: Date.now() - 1000, chatId: OWNER_CHAT, who: 'bot', uid: 'bot', text: '好哦' },
    ] : [],
    deleteChatLog: () => {},
    groupNames: new Map(),
    speakersOf: () => [],
  }
  let extractCalls = 0
  const dsh = {
    llm: {
      async *stream (params) {
        const system = String(params?.system || '')
        if (system.includes('整理长期记忆')) {
          extractCalls++
          // Attempt op=outdated replacing oldId with text colliding with a protected source='panel' memory so add() returns { ok: false }!
          yield { type: 'text-delta', text: JSON.stringify({ facts: [{ op: 'outdated', id: oldId, about: '主人', about_id: OWNER, speaker: OWNER, status: 'fact', text: '主人改用硬件密钥解锁电脑', importance: 0.7 }] }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', text: '{"facts":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
      listProviders: () => ['fake'],
    },
    get (n) { return n === 'llm' ? dsh.llm : null },
  }

  const store = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  const added = store.add({ text: '主人平时用指纹解锁电脑', about: OWNER, aboutName: '主人', source: 'auto', chatId: OWNER_CHAT, importance: 0.7 })
  store.add({ text: '主人改用硬件密钥解锁电脑', about: OWNER, aboutName: '主人', source: 'panel', chatId: OWNER_CHAT, importance: 0.8 })
  oldId = added.id

  await store.consolidate({ includeToday: true })
  assert.ok(extractCalls >= 1, 'extractFacts must have actually executed')
  const stillLive = store.list('').find((m) => m.id === oldId)
  assert.ok(stillLive, 'original memory MUST remain valid when outdated replacement fails add()')
  assert.equal(stillLive.invalidAt, undefined)
})

test('sessionRollover resets empty sessions, does not skip newer messages in 10m window, and passes extraContext', async (t) => {
  const dir = makeTempDir('rollover')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  process.env.AURABOT_DATA_DIR = dir

  const cfg = normalize({
    enabled: true,
    ownerId: OWNER,
    ownerName: '主人',
    model: { provider: 'fake', model: 'fake-1' },
    memory: { enabled: true, injectStyle: false, wiki: true },
  })
  const today = new Date().toISOString().slice(0, 10)
  let rows = []
  let resetCalls = 0
  let handoffPrompt = ''
  let wikiPrompt = ''
  let extractCalls = 0
  let savedHandoff = ''
  const hub = {
    chatLogDays: () => [today],
    chatLogOf: (d) => d === today ? rows : [],
    deleteChatLog: () => {},
    groupNames: new Map(),
    speakersOf: () => [],
    resetChat: () => { resetCalls++; return true },
    setSessionHandoff: (_id, text) => { savedHandoff = text },
  }
  const dsh = {
    llm: {
      async *stream (params) {
        const system = String(params?.system || '')
        const content = params?.messages?.[0]?.content
        const text = Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : ''
        if (system.includes('整理长期记忆')) {
          extractCalls++
          yield { type: 'text-delta', text: JSON.stringify({ facts: [{ op: 'add', about: '主人', about_id: OWNER, speaker: OWNER, status: 'fact', text: '主人刚约好周六上午九点出发', importance: 0.7 }] }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (system.includes('小备忘')) {
          handoffPrompt = text
          yield { type: 'text-delta', text: '周六上午九点一起去玩，天文展已结束。' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (system.includes('第一人称整理自己写给自己的认识页')) {
          wikiPrompt = text
          yield { type: 'text-delta', text: '主人约了周六上午九点出门。' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', text: '{"audits":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
      listProviders: () => ['fake'],
    },
    get (n) { return n === 'llm' ? dsh.llm : null },
  }

  const store = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })

  // Case 1: empty chatlog -> still calls resetChat!
  const emptyRes = await store.sessionRollover(OWNER_CHAT, { day: today })
  assert.equal(emptyRes.ok, true)
  assert.equal(emptyRes.skipped, true)
  assert.equal(emptyRes.archived, true)
  assert.equal(resetCalls, 1, 'empty chatlog rollover must still reset stale session')

  // Case 2: consolidate ran < 1 min ago, THEN new messages arrive -> sessionRollover must NOT skip extracting them
  await store.consolidate({ includeToday: true })
  await new Promise((r) => setTimeout(r, 20))
  const msgAt = Date.now() - 5
  rows = [
    { t: msgAt, chatId: OWNER_CHAT, who: '主人', uid: OWNER, text: '那我们周六上午九点出发吧' },
    { t: msgAt + 1, chatId: OWNER_CHAT, who: 'bot', uid: 'bot', text: '好嘞记下啦！' },
  ]
  const res = await store.sessionRollover(OWNER_CHAT, {
    day: today,
    dream: true,
    lastLines: 0,
    extraContext: '已敲定的约定：11/28 09:00 周六出门；近期查到的事实线索：天文特展已于10月25日结束',
  })
  assert.equal(res.ok, true)
  assert.ok(extractCalls >= 1, 'must extract new messages arrived after recent consolidate')
  assert.ok(handoffPrompt.includes('天文特展已于10月25日结束'), 'extraContext passed into handoff')
  assert.ok(wikiPrompt.includes('11/28 09:00'), 'extraContext passed into wiki refresh')
  assert.equal(savedHandoff.includes('【上次最后几句】'), false, 'lastLines=0 omits verbatim tail')
})
