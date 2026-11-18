// OneBot v12 ↔ Aurabot 内部格式的翻译层（纯函数）。
//
// Aurabot 里面各处还是按 v11 的动作名和事件形状写的（send_group_msg、message_type、at{qq}……），
// 网关客户端在 v12 模式下用这里的函数两头翻译：
//   · toV12Call(action, params) → { action, params, map }：v11 动作 → v12 动作，map 把 v12 回包翻回 v11 形状
//   · fromV12Event(ev) → v11 形状的事件
// v12 的 ID 一律是字符串（Discord 的真实 snowflake），这里不转数字。
// onebots 的 v12 消息段里 ID 有时是 { string, number, source } 对象，统一用 idStr 取字符串。

export const idStr = (v) => {
  if (v && typeof v === 'object') return String(v.string ?? v.source ?? v.number ?? '')
  return v === undefined || v === null ? '' : String(v)
}

/** Aurabot 发出的消息段 → v12 */
export function segmentsToV12(message) {
  if (typeof message === 'string') return [{ type: 'text', data: { text: message } }]
  return (Array.isArray(message) ? message : []).map((seg) => {
    const d = (seg && seg.data) || {}
    switch (seg?.type) {
      case 'at': {
        const who = idStr(d.qq ?? d.user_id)
        // onebots 的 v12 → 通用段只认 mention；@全体 直接给适配器认得的 at{qq:'all'}
        return who === 'all' ? { type: 'at', data: { qq: 'all' } } : { type: 'mention', data: { user_id: who } }
      }
      case 'reply':
        return { type: 'reply', data: { message_id: idStr(d.id ?? d.message_id) } }
      default:
        return seg
    }
  })
}

/** v12 收到的消息段 → Aurabot 内部（v11 形状） */
export function segmentsFromV12(message) {
  return (Array.isArray(message) ? message : []).map((seg) => {
    const d = (seg && seg.data) || {}
    switch (seg?.type) {
      case 'mention':
        return { type: 'at', data: { qq: idStr(d.user_id), ...(d.name ? { name: d.name } : {}) } }
      case 'mention_all':
        return { type: 'at', data: { qq: 'all' } }
      case 'at':
        return { type: 'at', data: { qq: idStr(d.qq ?? d.user_id), ...(d.name ? { name: d.name } : {}) } }
      case 'reply':
        return { type: 'reply', data: { id: idStr(d.message_id ?? d.id), ...(d.user_id !== undefined ? { user_id: idStr(d.user_id) } : {}) } }
      case 'channel':
        return { type: 'text', data: { text: `#${d.name || idStr(d.channel_id ?? d.id)}` } }
      case 'voice':
        return { type: 'record', data: d }
      default:
        return seg
    }
  })
}

/** onebots 的消息记录（get_message / get_message_history 的一条）→ v11 消息 */
export function messageInfoToV11(info) {
  if (!info || typeof info !== 'object') return info
  const sender = info.sender || {}
  const uid = idStr(sender.sender_id ?? sender.user_id ?? info.user_id)
  const name = sender.sender_name || sender.nickname || sender.card || ''
  return {
    message_id: idStr(info.message_id),
    time: info.time,
    user_id: uid,
    sender: { user_id: uid, nickname: name || uid, card: name },
    message: segmentsFromV12(info.message || []),
    raw_message: info.raw_message || info.alt_message || '',
  }
}

const sceneOf = (p) => (p.group_id !== undefined && p.group_id !== null && p.group_id !== ''
  ? { scene_type: 'group', scene_id: idStr(p.group_id) }
  : { scene_type: 'private', scene_id: idStr(p.user_id) })

const member = (m) => ({ user_id: idStr(m?.user_id), nickname: m?.user_displayname || m?.user_name || idStr(m?.user_id), card: m?.user_displayname || m?.user_name || '', role: 'member' })
const fileSeg = (p) => ({ type: 'file', data: { file: p.file, name: p.name, filename: p.name } })

/**
 * v11 动作 → v12 动作。返回 { action, params, map }；map(data) 把 v12 回包翻回 v11 调用方期望的形状。
 * 没列出来的动作原样转发（ID 参数转成字符串），Discord 平台扩展动作（add_reaction、call_discord_api……）也走这条。
 */
export function toV12Call(action, params = {}) {
  const p = params || {}
  const same = (d) => d
  switch (action) {
    case 'send_group_msg':
      return { action: 'send_message', params: { detail_type: 'group', group_id: idStr(p.group_id), message: segmentsToV12(p.message) }, map: (d) => ({ message_id: idStr(d?.message_id) }) }
    case 'send_private_msg':
      return { action: 'send_message', params: { detail_type: 'private', user_id: idStr(p.user_id), message: segmentsToV12(p.message) }, map: (d) => ({ message_id: idStr(d?.message_id) }) }
    case 'send_msg': {
      const group = p.message_type === 'group' || (p.message_type !== 'private' && p.group_id)
      return toV12Call(group ? 'send_group_msg' : 'send_private_msg', p)
    }
    case 'upload_group_file':
      return { action: 'send_message', params: { detail_type: 'group', group_id: idStr(p.group_id), message: [fileSeg(p)] }, map: (d) => ({ message_id: idStr(d?.message_id) }) }
    case 'upload_private_file':
      return { action: 'send_message', params: { detail_type: 'private', user_id: idStr(p.user_id), message: [fileSeg(p)] }, map: (d) => ({ message_id: idStr(d?.message_id) }) }
    case 'get_login_info':
      return { action: 'get_self_info', params: {}, map: (d) => ({ user_id: idStr(d?.user_id), nickname: d?.user_displayname || d?.user_name || '' }) }
    case 'get_stranger_info':
      return { action: 'get_user_info', params: { user_id: idStr(p.user_id) }, map: (d) => ({ user_id: idStr(d?.user_id), nickname: d?.user_displayname || d?.user_name || '' }) }
    case 'get_group_info':
      return { action: 'get_group_info', params: { group_id: idStr(p.group_id) }, map: (d) => ({ group_id: idStr(d?.group_id), group_name: d?.group_name || '' }) }
    case 'get_group_list':
      return { action: 'get_group_list', params: {}, map: (d) => (Array.isArray(d) ? d : []).map((g) => ({ group_id: idStr(g.group_id), group_name: g.group_name || '' })) }
    case 'get_group_member_info':
      return { action: 'get_group_member_info', params: { group_id: idStr(p.group_id), user_id: idStr(p.user_id) }, map: member }
    case 'get_group_member_list':
      return { action: 'get_group_member_list', params: { group_id: idStr(p.group_id) }, map: (d) => (Array.isArray(d) ? d : []).map(member) }
    case 'get_friend_list':
      return { action: 'get_friend_list', params: {}, map: (d) => (Array.isArray(d) ? d : []).map((f) => ({ user_id: idStr(f.user_id), nickname: f.user_displayname || f.user_name || '' })) }
    case 'get_msg':
      return { action: 'get_message', params: { message_id: idStr(p.message_id), ...sceneOf(p) }, map: messageInfoToV11 }
    case 'get_group_msg_history':
      return { action: 'get_message_history', params: { scene_type: 'group', scene_id: idStr(p.group_id), limit: Number(p.count) || 20 }, map: (d) => ({ messages: (Array.isArray(d) ? d : d?.messages || []).map(messageInfoToV11).sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0)) }) }
    case 'get_friend_msg_history':
      return { action: 'get_message_history', params: { scene_type: 'private', scene_id: idStr(p.user_id), limit: Number(p.count) || 20 }, map: (d) => ({ messages: (Array.isArray(d) ? d : d?.messages || []).map(messageInfoToV11).sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0)) }) }
    case 'delete_msg':
      return { action: 'delete_message', params: { message_id: idStr(p.message_id) }, map: same }
    case 'set_input_status':
      return { action: 'set_input_status', params: { ...(p.group_id ? { group_id: idStr(p.group_id) } : {}), ...(p.user_id ? { user_id: idStr(p.user_id) } : {}) }, map: same }
    default: {
      const out = { ...p }
      for (const k of ['group_id', 'user_id', 'message_id', 'channel_id', 'guild_id']) if (out[k] !== undefined && out[k] !== null) out[k] = idStr(out[k])
      return { action, params: out, map: same }
    }
  }
}

/** v12 事件 → Aurabot 内部（v11 形状）；不认识的返回 null */
export function fromV12Event(ev) {
  if (!ev || typeof ev !== 'object' || !ev.type) return null
  const selfId = idStr(ev.self?.user_id)
  if (ev.type === 'message') {
    const priv = ev.detail_type === 'private'
    const uid = idStr(ev.user_id)
    const name = ev.user_displayname || ev.user_name || ''
    return {
      post_type: 'message',
      message_type: priv ? 'private' : 'group',
      sub_type: priv ? 'friend' : 'normal',
      time: ev.time,
      self_id: selfId,
      message_id: idStr(ev.message_id),
      user_id: uid,
      ...(priv ? {} : { group_id: idStr(ev.group_id ?? ev.channel_id) }),
      ...(ev.guild_id ? { guild_id: idStr(ev.guild_id) } : {}),
      message: segmentsFromV12(ev.message || []),
      raw_message: ev.alt_message || '',
      sender: { user_id: uid, nickname: name || uid, card: ev.user_displayname || '' },
    }
  }
  if (ev.type === 'meta') return { post_type: 'meta_event', meta_event_type: ev.detail_type, sub_type: ev.sub_type || '', time: ev.time, self_id: selfId }
  if (ev.type === 'notice') {
    const out = { ...ev, post_type: 'notice', notice_type: ev.detail_type, self_id: selfId }
    for (const k of ['user_id', 'group_id', 'operator_id', 'message_id', 'channel_id', 'guild_id']) if (ev[k] !== undefined) out[k] = idStr(ev[k])
    delete out.type
    delete out.detail_type
    return out
  }
  return null
}
