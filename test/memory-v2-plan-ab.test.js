import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createMemoryStore, retention, isLocalVectorUrl } from '../src/features/memory.js'
import { createHub } from '../src/chat/hub.js'
import moodModule from '../src/modules/mood/index.js'

const OWNER = '10000001'
const FRIEND = '30000001'
const DAY = 86400_000
const log = { info() {}, warn() {}, debug() {} }

function makeTemp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-memv2-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  return dir
}

test('方案 A：mood 不再写入 api.context，改为挂在 prompt 钩子每轮随消息走', (t) => {
  makeTemp(t)
  const cfg = normalize({ ownerId: OWNER, mood: { enabled: true } })
  const contexts = []
  const promptHooks = []
  const api = {
    config: () => cfg,
    dsh: {},
    log,
    context: (fn) => contexts.push(fn),
    on: (name, fn) => { if (name === 'prompt') promptHooks.push(fn) },
  }
  const mood = moodModule.setup(api)
  assert.equal(contexts.length, 0, 'mood 不再注册 api.context')
  assert.equal(promptHooks.length, 1, 'mood 注册在 prompt 钩子')
  mood.nudge(20, '主人夸了她')
  const out = promptHooks[0]([{ type: 'text', text: '你好' }], { chat: { kind: 'private', userId: OWNER } })
  assert.equal(out.length, 2)
  assert.match(out[0].text, /心情/)
  const sysOut = promptHooks[0]([{ type: 'text', text: '系统任务' }], { chat: { kind: 'system' } })
  assert.equal(sysOut.length, 1, '系统会话不注入心情')
})

test('激活度：随时间变淡、readMemories 主动翻看让它回升且之后淡得更慢；常驻不含看过的视频；严格隔离隐私', (t) => {
  makeTemp(t)
  const cfg = normalize({ ownerId: OWNER, memory: { enabled: true, dailyConsolidate: false } })
  const hub = { chatLogDays: () => [], chatLogOf: () => [], speakersOf: () => [FRIEND] }
  const mem = createMemoryStore({ dsh: {}, getConfig: () => cfg, hub, log })
  const now = Date.now()

  // 纯函数验证：刚记下的最活跃；同样 10 天没用，被主动翻看过的淡得更慢
  assert.equal(retention({ at: now, importance: 0.5, clicks: 0 }, now), 1)
  const old10dNoClick = retention({ at: now - 10 * DAY, importance: 0.5, clicks: 0 }, now)
  const old10dClicked = retention({ at: now - 10 * DAY, importance: 0.5, clicks: 4 }, now)
  assert.ok(old10dNoClick < old10dClicked, `没翻看过的激活度 ${old10dNoClick} 应低于常翻看的 ${old10dClicked}`)

  // 写入主人私事 + 多个 seen 视频 + 群友自己的事
  const promise = mem.add({ text: '约好周末一起去欧文西点买奶油泡芙', about: OWNER, aboutName: '主人', importance: 0.8, source: 'tool', chatId: `private:${OWNER}` })
  const friendFact = mem.add({ text: '阿花最近在学弹吉他', about: FRIEND, aboutName: '阿花', importance: 0.6, source: 'tool', chatId: 'group:888' })
  for (let i = 0; i < 6; i++) {
    mem.addEvent({ kind: 'seen', text: `欧文西点泡芙探店视频第${i}集`, meta: { title: `欧文西点泡芙探店${i}`, platform: 'bili' } })
  }

  // seen 绝不进主人私聊常驻，也不进默认 memory_tree
  const ownerChat = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
  const ownerCtx = mem.contextFor(ownerChat, 's-o')
  assert.match(ownerCtx, /欧文西点买奶油泡芙/)
  assert.doesNotMatch(ownerCtx, /探店/)

  const tree = mem.memoryTree(ownerChat)
  assert.match(tree.message, /欧文西点买奶油泡芙/)
  assert.doesNotMatch(tree.message, /探店/, '默认目录树排除 seen')
  const treeWithSeen = mem.memoryTree(ownerChat, { includeSeen: true })
  assert.match(treeWithSeen.message, /探店/, '显式 includeSeen 才列出看过的视频')

  // recallHint 里 seen 最多占 1 条，绝不把真正的约定挤掉
  const hint = mem.recallHint(ownerChat, '欧文西点泡芙', '', 's-o')
  assert.match(hint, /约好周末一起去欧文西点买奶油泡芙/)
  const seenMatches = (hint.match(/看过《欧文西点泡芙探店/g) || []).length
  assert.ok(seenMatches <= 1, `自动召回里 seen 最多 1 条，实际 ${seenMatches}`)

  // 隐私隔离：群友即使猜中主人记忆 ID，也读不到主人私事
  const groupChat = { kind: 'group', groupId: '888', chatId: 'group:888' }
  const leakAttempt = mem.readMemories(groupChat, promise.id, { speakers: [FRIEND] })
  assert.equal(leakAttempt.items.length, 0)
  assert.doesNotMatch(leakAttempt.message, /欧文西点/)

  // 群友可读自己在群里的记忆，且 readMemories 会强化 clicks + 1
  const friendRead = mem.readMemories(groupChat, friendFact.id, { speakers: [FRIEND] })
  assert.deepEqual(friendRead.items, [friendFact.id])
  assert.match(friendRead.message, /阿花最近在学弹吉他/)
  const stored = mem.list('').find((x) => x.id === friendFact.id)
  assert.equal(stored.clicks, 1)
  assert.ok(retention(stored, Date.now()) > 0.99, '刚翻看过的激活度回到最高')
})

test('方案 B：sessionRollover 生成中文情感交接并归档会话，新会话首轮自动衔接（重启不丢）', async (t) => {
  makeTemp(t)
  const cfg = normalize({ ownerId: OWNER, ownerName: '主人', memory: { enabled: true, dailyConsolidate: false } })
  const dsh = {
    get: (name) => {
      if (name === 'model') return null
      return null
    },
    llm: {
      complete: async () => ({
        content: [{ type: 'text', text: '昨晚和主人聊得很开心，聊到欧文西点的泡芙，还约好周末一起去买。' }],
      }),
    },
  }
  const resetCalls = []
  let savedHandoff = null
  const today = new Date().toISOString().slice(0, 10)
  const chatId = `private:${OWNER}`
  const rows = [
    { t: Date.now() - 3600_000, chatId, who: '主人', uid: OWNER, text: '今天风好大啊' },
    { t: Date.now() - 3500_000, chatId, who: 'bot', text: '是呀，我去欧文西点买泡芙差点吹成大风车' },
    { t: Date.now() - 3400_000, chatId, who: '主人', uid: OWNER, text: '周末一起再去买' },
    { t: Date.now() - 3300_000, chatId, who: 'bot', text: '一言为定！' },
  ]
  const hub = createHub({ dsh: { agents: new Map(), get: () => null }, getConfig: () => cfg, log, onebot: {} })
  t.after(() => hub.dispose())
  const wrappedHub = {
    ...hub,
    chatLogDays: () => [today],
    chatLogOf: (d) => (d === today ? rows : []),
    setSessionHandoff: (id, text, meta) => { savedHandoff = { id, text, meta }; return hub.setSessionHandoff(id, text, meta) },
    resetChat: (id) => { resetCalls.push(id); return true },
  }
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub: wrappedHub, log })
  const res = await mem.sessionRollover(chatId, { day: today, lastLines: 4 })
  assert.equal(res.ok, true)
  assert.deepEqual(resetCalls, [chatId])
  assert.ok(savedHandoff && savedHandoff.id === chatId)
  assert.match(savedHandoff.text, /【上次最后几句】/)
  assert.match(savedHandoff.text, /一言为定/)

  // 确认持久化到磁盘，新 hub 实例重启后仍能取出一次
  const hub2 = createHub({ dsh: { agents: new Map(), get: () => null }, getConfig: () => cfg, log, onebot: {} })
  t.after(() => hub2.dispose())
  const taken = hub2.takeSessionHandoff(chatId)
  assert.ok(taken && taken.text.includes('一言为定'))
  assert.equal(hub2.takeSessionHandoff(chatId), null, '取出后即消费，不重复注入')
})

test('本地 CPU 向量地址识别：localhost / 127.0.0.1 / ::1 视为本地免费服务', () => {
  assert.equal(isLocalVectorUrl('http://127.0.0.1:11435/v1'), true)
  assert.equal(isLocalVectorUrl('http://localhost:11434/v1'), true)
  assert.equal(isLocalVectorUrl('http://[::1]:11435/v1'), true)
  assert.equal(isLocalVectorUrl('https://api.openai.com/v1'), false)
  assert.equal(isLocalVectorUrl(''), false)
})
