// 回放验收的适配层：把 run.mjs 的调用接到新版 LLM Wiki 线上实现上。
// 仅做接线，所有逻辑（Wiki 存储/编辑、L0 Dreaming、统一遗忘、规则文案、工具定义、常驻上下文组装）
// 全部直接调用线上同一份源码，不另写验收专用逻辑。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function fmtNow(ts) {
  const d = new Date(Number(ts) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}（${WEEKDAYS[d.getDay()]}）`
}

export async function createAdapter({ dsh, getConfig, dataDir, log, repoDir }) {
  const imp = (rel) => import(pathToFileURL(join(repoDir, rel)).href)
  const { createMemoryStore } = await imp('src/features/memory.js')
  const { memoryRuleText, buildMemoryTools } = await imp('src/modules/memory/index.js')
  const { currentPersonaText, rulesText } = await imp('src/persona/personas.js')
  const { readJson } = await imp('src/core/store.js')

  // 验收在隔离沙盒中测的是正式切换后的 LLM Wiki 模式（wikiMode='active'）
  const activeConfig = () => {
    const c = getConfig() || {}
    return {
      ...c,
      memory: {
        ...(c.memory || {}),
        enabled: true,
        wiki: true,
        wikiMode: 'active',
      },
    }
  }

  const memory = createMemoryStore({
    dsh,
    getConfig: activeConfig,
    hub: null,
    log,
  })

  const ownerChatOf = () => {
    const cfg = activeConfig()
    const ownerId = String(cfg.ownerId || '').trim()
    return {
      kind: 'private',
      userId: ownerId,
      chatId: `private:${ownerId}`,
      nickname: cfg.ownerName || '主人',
    }
  }

  return {
    async nightly({ day, now }) {
      return memory.wiki.nightly({ day, now })
    },

    state() {
      const s = memory.wiki.dreamState()
      return { lastDreamedDay: s?.lastDreamedDay || '' }
    },

    async forget(keyword, { now } = {}) {
      const ownerId = String(activeConfig().ownerId || '').trim()
      return memory.forgetKeyword(keyword, { userId: ownerId, now: now ?? Date.now() })
    },

    wikiDir() {
      return memory.wiki.dir()
    },

    activityFile() {
      return join(dataDir, 'modules-data', 'autonomy', 'activity.jsonl')
    },

    async chatContext({ now } = {}) {
      const cfg = activeConfig()
      const chat = ownerChatOf()
      const persona = currentPersonaText(cfg.persona?.current)
      const memRule = memoryRuleText('private', cfg)
      const rules = rulesText('private', cfg, {
        off: new Set(['stickers', 'imagegen', 'bili', 'song', 'qq-tools']),
        extra: memRule ? [memRule] : [],
      })
      const resident = memory.contextFor(chat, '')

      // 若有睡前交接（session-handoffs.json），按 hub.js 同款格式附在上下文里
      let handoffBlock = ''
      const hf = join(dataDir, 'session-handoffs.json')
      if (existsSync(hf)) {
        const all = readJson(hf, () => ({}))
        const entry = all && typeof all === 'object' ? all[chat.chatId] : null
        if (entry?.text) {
          handoffBlock = `【上次聊天的延续，只是你自己的记忆背景，不必刻意复述或提起“总结”】\n${entry.text}`
        }
      }

      const system = [
        persona,
        rules,
        `【当前时间】${fmtNow(now ?? Date.now())}`,
        resident,
        handoffBlock,
      ].filter(Boolean).join('\n\n')

      const rawTools = buildMemoryTools({ memory, chat, cfg })
      const tools = rawTools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        async execute(args) {
          const val = await t.execute(args || {})
          const blocks = t.output?.render ? t.output.render(args || {}, val) : null
          if (Array.isArray(blocks)) return blocks.map((b) => String(b?.text || '')).join('\n')
          return typeof val === 'string' ? val : String(val?.message || JSON.stringify(val))
        },
      }))

      return { system, tools }
    },

    async searchChatlog(query) {
      const chat = ownerChatOf()
      const res = memory.searchOriginalLog(chat, { query: String(query || ''), limit: 30, context: 3 })
      return res?.lines?.length ? String(res.message || '') : ''
    },
  }
}
