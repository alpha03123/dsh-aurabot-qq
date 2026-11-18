// 内置模块：白名单。
//  · qq_whitelist：听主人的话把用户 / 频道加进、移出白名单（allow.private / allow.groups），写进配置并保存。
// 权限在面板「权限」页：off 关 / owner 仅主人私聊（默认）/ all 所有人。
// （原来的好友 / 加群申请处理是 QQ 专属的，Discord fork 里删掉了。）

import { defineTool, str } from '../../tools/tools.js'
import { profileToolVisible, profilePermits } from '../../chat/access.js'

// Discord 的 ID 是 17~20 位 snowflake；桥映射出来的短数字也认
const ID_RE = /^\d{5,20}$/

/** 取纯数字 ID；不像用户 / 频道 ID 的返回空串。 */
export function cleanId(v) {
  const s = String(v ?? '').replace(/\D/g, '')
  return ID_RE.test(s) ? s : ''
}

/** 白名单增删的纯逻辑：返回 { ok, message, next? }。next = 改完后的这张表（没变化时不给）。 */
export function planWhitelist(cfg, { action, kind, id }) {
  const act = String(action || '').trim().toLowerCase()
  if (!['add', 'remove'].includes(act)) return { ok: false, message: 'action 只能是 add 或 remove' }
  const k = String(kind || '').trim().toLowerCase()
  if (!['private', 'group'].includes(k)) return { ok: false, message: 'kind 只能是 private（私聊的人）或 group（频道）' }
  const n = cleanId(id)
  if (!n) return { ok: false, message: 'ID 不对：要纯数字的用户 ID / 频道 ID' }
  const label = k === 'private' ? '用户' : '频道'
  const listName = k === 'private' ? '私聊白名单' : '频道白名单'
  if (k === 'private' && n === String(cfg.ownerQQ || '')) {
    return act === 'remove'
      ? { ok: false, message: '主人不能被移出私聊白名单' }
      : { ok: true, message: '主人本来就能私聊，不用加白名单' }
  }
  if (k === 'private' && act === 'add' && n === String(cfg.botQQ || '')) return { ok: false, message: '这是我自己，不用加' }
  const list = (k === 'private' ? cfg.allow?.private : cfg.allow?.groups) || []
  const has = list.map(String).includes(n)
  if (act === 'add') {
    if (has) return { ok: true, message: `${label} ${n} 已经在${listName}里了` }
    return { ok: true, changed: true, message: `${label} ${n} 加进${listName}了`, next: [...list.map(String), n] }
  }
  if (!has) return { ok: true, message: `${label} ${n} 本来就不在${listName}里` }
  return { ok: true, changed: true, message: `${label} ${n} 从${listName}移出了`, next: list.map(String).filter((x) => x !== n) }
}

export default {
  id: 'contacts',
  name: '白名单',
  version: '2.0.0',
  description: '改私聊 / 频道白名单；权限在「权限」页',
  setup(api) {
    const { hub } = api.core
    const guarded = (key, chat, sessionId, run) => async (args) => {
      const cfg = api.config()
      const p = profilePermits(cfg, key, chat, hub.turnSendersAllOwner(sessionId))
      if (!p.ok) return p
      return run(args, cfg)
    }

    api.tool(({ chat, sessionId }) => {
      const cfg = api.config()
      const tools = []
      if (profileToolVisible(cfg, 'whitelist', chat)) tools.push(defineTool({
        name: 'qq_whitelist',
        description: '改白名单：action 填 add（加进）或 remove（移出），kind 填 private（某个人可以私聊你）或 group（某个频道你会理），id 填用户 ID 或频道 ID。主人不能被移出。',
        properties: { action: str('add 加进 / remove 移出'), kind: str('private 私聊的人 / group 频道'), id: str('用户 ID 或频道 ID（数字）') },
        required: ['action', 'kind', 'id'],
        execute: guarded('whitelist', chat, sessionId, async (args, c) => {
          const plan = planWhitelist(c, args)
          if (!plan.ok || !plan.changed) return plan
          if (c.dryRun) return { ok: true, message: `试运行：本来要${plan.message}` }
          const key = String(args.kind).trim().toLowerCase() === 'private' ? 'private' : 'groups'
          // 用保存那一刻最新的配置再算一遍，免得盖掉面板刚改的
          let result = plan
          api.setConfig((cur) => {
            result = planWhitelist(cur, args)
            if (!result.ok || !result.changed) return cur
            return { ...cur, allow: { ...cur.allow, [key]: result.next } }
          })
          return { ok: result.ok, message: result.message }
        }),
      }))
      return tools
    })
    return {}
  },
}
