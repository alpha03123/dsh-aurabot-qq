// 好友申请与白名单：权限三档、试运行、请求参数、失败要当失败、主人不能被移出。用假 api / 假 OneBot 测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { default: contacts, planWhitelist, cleanId } = await import('../src/modules/contacts/index.js')
const { normalize } = await import('../src/core/config.js')

const OWNER = '10001'
const BOT = '20002'
const ownerPm = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
const otherPm = { kind: 'private', userId: '30003', chatId: 'private:30003' }
const group = { kind: 'group', userId: OWNER, groupId: '555', chatId: 'group:555' }

function setup({ cfg = {}, allOwner = true, callImpl } = {}) {
  let config = normalize({ ownerId: OWNER, selfId: BOT, dryRun: false, ...cfg })
  const calls = []
  const sent = []
  const listeners = {}
  let builder
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-contacts-'))
  const api = {
    core: {
      hub: { turnSendersAllOwner: () => allOwner },
      onebot: {
        call: async (action, params) => {
          calls.push({ action, params })
          if (callImpl) return callImpl(action, params)
          return null
        },
      },
    },
    log: { warn() {}, info() {} },
    config: () => config,
    setConfig: (fn) => { config = normalize(fn(config)) },
    dataDir: (...p) => join(dir, ...p),
    on: (name, fn) => { listeners[name] = fn },
    tool: (b) => { builder = b },
    sendText: async (chatId, text) => { sent.push({ chatId, text }) },
  }
  contacts.setup(api)
  const tools = (chat) => Object.fromEntries(builder({ chat, sessionId: 's1' }).map((t) => [t.name, t]))
  return { calls, sent, tools, event: (ev) => listeners.onebot(ev), cfg: () => config, set: (patch) => { config = normalize({ ...config, ...patch }) } }
}
const friendEv = (over = {}) => ({ post_type: 'request', request_type: 'friend', user_id: 40004, comment: '你好', flag: 'u_abc', ...over })

test('白名单：加 / 移出 私聊和群、去重、写进配置', async () => {
  const t = setup({ cfg: { allow: { private: ['111111'], groups: [] } } })
  const w = t.tools(ownerPm).edit_whitelist
  let r = await w.execute({ action: 'add', kind: 'private', id: '40004' })
  assert.equal(r.ok, true)
  assert.deepEqual(t.cfg().allow.private, ['111111', '40004'])
  r = await w.execute({ action: 'add', kind: 'private', id: '40004' })
  assert.match(r.message, /已经在/)
  assert.deepEqual(t.cfg().allow.private, ['111111', '40004'])
  r = await w.execute({ action: 'add', kind: 'group', id: '777888' })
  assert.deepEqual(t.cfg().allow.groups, ['777888'])
  r = await w.execute({ action: 'remove', kind: 'group', id: '777888' })
  assert.equal(r.ok, true)
  assert.deepEqual(t.cfg().allow.groups, [])
  r = await w.execute({ action: 'remove', kind: 'private', id: '111111' })
  assert.deepEqual(t.cfg().allow.private, ['40004'])
  r = await w.execute({ action: 'remove', kind: 'group', id: '777888' })
  assert.match(r.message, /不在/)
  assert.equal(t.calls.length, 0, '改白名单不碰 QQ 接口')
})

test('白名单：不能把主人移出私聊白名单（哪怕名单里有他）；也不能乱填', async () => {
  const t = setup({ cfg: { allow: { private: [OWNER, '111111'], groups: [] } } })
  const w = t.tools(ownerPm).edit_whitelist
  let r = await w.execute({ action: 'remove', kind: 'private', id: OWNER })
  assert.equal(r.ok, false)
  assert.match(r.message, /主人/)
  assert.deepEqual(t.cfg().allow.private, [OWNER, '111111'])
  r = await w.execute({ action: 'add', kind: 'private', id: BOT })
  assert.equal(r.ok, false)
  // 群号和主人 QQ 号撞了也不受影响（两张表互不相干）
  r = await w.execute({ action: 'remove', kind: 'group', id: OWNER })
  assert.equal(r.ok, true)
  for (const bad of [{ action: 'del', kind: 'private', id: '40004' }, { action: 'add', kind: 'team', id: '40004' }, { action: 'add', kind: 'private', id: '12' }, { action: 'add', kind: 'private', id: '' }, { action: 'add', kind: 'private', id: 'abc' }]) {
    assert.equal((await w.execute(bad)).ok, false, JSON.stringify(bad))
  }
  assert.deepEqual(t.cfg().allow.private, [OWNER, '111111'])
})

test('白名单试运行：只回话，配置不变', async () => {
  const t = setup({ cfg: { dryRun: true, allow: { private: ['111111'], groups: ['555666'] } } })
  const w = t.tools(ownerPm).edit_whitelist
  let r = await w.execute({ action: 'add', kind: 'private', id: '40004' })
  assert.match(r.message, /试运行/)
  r = await w.execute({ action: 'remove', kind: 'group', id: '555666' })
  assert.match(r.message, /试运行/)
  assert.deepEqual(t.cfg().allow, { private: ['111111'], groups: ['555666'] })
  // 试运行时主人保护照样生效
  r = await w.execute({ action: 'remove', kind: 'private', id: OWNER })
  assert.equal(r.ok, false)
})

test('白名单：保存时用最新配置，不盖掉别处刚改的', async () => {
  const t = setup({ cfg: { allow: { private: [], groups: [] } } })
  const w = t.tools(ownerPm).edit_whitelist
  t.set({ allow: { private: ['222222'], groups: [] } })
  await w.execute({ action: 'add', kind: 'private', id: '40004' })
  assert.deepEqual(t.cfg().allow.private, ['222222', '40004'])
})

test('白名单：所有人档，群友也能改（权限由面板决定）', async () => {
  const t = setup({ cfg: { profilePerms: { whitelist: 'all' } }, allOwner: false })
  const r = await t.tools(group).edit_whitelist.execute({ action: 'add', kind: 'group', id: '777888' })
  assert.equal(r.ok, true)
  assert.deepEqual(t.cfg().allow.groups, ['777888'])
})

test('纯函数：cleanId / planWhitelist', () => {
  assert.equal(cleanId(' 40004 '), '40004')
  assert.equal(cleanId('12'), '')
  assert.equal(cleanId('1322145178253000724'), '1322145178253000724', 'Discord snowflake 也认')
  assert.equal(cleanId('123456789012345678901'), '')
  assert.equal(planWhitelist({ ownerId: '1', allow: { private: [], groups: [] } }, { action: 'add', kind: 'group', id: '12345' }).next[0], '12345')
})
