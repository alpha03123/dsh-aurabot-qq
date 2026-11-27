// 真实模型客户端。和线上走同一个 provider：DSH profiles/web/cordis.patch.yml 里的 local-sub2
// （OpenAI Responses API，baseURL http://127.0.0.1:8080/v1，key 读环境变量 LOCAL_SUB2_API_KEY）。
// 不打印、不落盘任何 key。
import { performance } from 'node:perf_hooks'

const env = process.env

export const MODEL_CFG = {
  baseURL: (env.REPLAY_BASE_URL || 'http://127.0.0.1:8080/v1').replace(/\/+$/, ''),
  apiKeyEnv: env.REPLAY_API_KEY_ENV || 'LOCAL_SUB2_API_KEY',
  provider: env.REPLAY_PROVIDER || 'local-sub2',
  judgeModel: env.REPLAY_JUDGE_MODEL || 'gpt-6-luna',
  judgeEffort: env.REPLAY_JUDGE_EFFORT || 'medium',
  // DSH 的 openai-responses 适配层对推理模型一般不传 temperature；要传就设 REPLAY_SEND_TEMPERATURE=1
  sendTemperature: env.REPLAY_SEND_TEMPERATURE === '1',
  timeoutMs: Number(env.REPLAY_TIMEOUT_MS) || 240_000,
}

export const stats = { calls: 0, errors: 0, ms: 0, inputTokens: 0, outputTokens: 0, byLabel: {} }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function apiKey() {
  const k = env[MODEL_CFG.apiKeyEnv]
  if (!k) throw new Error(`缺环境变量 ${MODEL_CFG.apiKeyEnv}（和 DSH 的 local-sub2 用同一个 key）`)
  return k
}

/** 检查一次端点和 key 是否可用（开跑前调用，失败就别浪费时间）。 */
export async function preflight(model) {
  const json = await responses({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: '只回复：OK' }] }], max_output_tokens: 64, reasoning: { effort: 'low' } }, 'preflight')
  return outputText(json)
}

export async function responses(body, label = 'ask') {
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error(`模型调用超时 ${MODEL_CFG.timeoutMs}ms`)), MODEL_CFG.timeoutMs)
    const t0 = performance.now()
    try {
      const res = await fetch(`${MODEL_CFG.baseURL}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify({ ...body, stream: false }),
        signal: ac.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
        e.status = res.status
        throw e
      }
      const json = JSON.parse(text)
      const ms = performance.now() - t0
      stats.calls++
      stats.ms += ms
      stats.inputTokens += Number(json.usage?.input_tokens) || 0
      stats.outputTokens += Number(json.usage?.output_tokens) || 0
      const b = (stats.byLabel[label] ||= { calls: 0, ms: 0 })
      b.calls++
      b.ms += ms
      return json
    } catch (e) {
      lastErr = e
      if (e.status && e.status < 500 && e.status !== 429) break
      await sleep(3000 * (attempt + 1))
    } finally {
      clearTimeout(timer)
    }
  }
  stats.errors++
  throw lastErr
}

export function outputText(json) {
  if (typeof json?.output_text === 'string' && json.output_text) return json.output_text
  const parts = []
  for (const item of json?.output || []) {
    if (item.type !== 'message') continue
    for (const c of item.content || []) if ((c.type === 'output_text' || c.type === 'text') && c.text) parts.push(c.text)
  }
  return parts.join('')
}

/**
 * 假宿主 dsh：只提供 llm.stream，事件格式与 DSH 一致（text-delta / usage / finish），
 * 这样实现里的 askModel(dsh, …) 原样走线上代码路径，只是落到同一个真实端点上。
 * sabotage：模拟上游出错 —— 'empty' 返回空，'truncate' 只给前 40%。
 */
export function createFakeDsh() {
  let sabotage = null
  const llm = {
    async *stream(params) {
      const input = (params.messages || []).map((m) => {
        const assistant = m.role === 'assistant'
        const content = (m.content || [])
          .filter((c) => c && c.type === 'text')
          .map((c) => ({ type: assistant ? 'output_text' : 'input_text', text: String(c.text || '') }))
        return { role: assistant ? 'assistant' : 'user', content }
      })
      const body = {
        model: params.model,
        ...(params.system ? { instructions: params.system } : {}),
        input,
        ...(params.maxTokens ? { max_output_tokens: params.maxTokens } : {}),
        ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort } } : {}),
        ...(MODEL_CFG.sendTemperature && params.temperature != null ? { temperature: params.temperature } : {}),
      }
      const json = await responses(body, sabotage ? `ask:${sabotage}` : 'ask')
      let text = outputText(json)
      if (sabotage === 'empty') text = ''
      else if (sabotage === 'truncate') text = text.slice(0, Math.floor(text.length * 0.4))
      if (text) yield { type: 'text-delta', text }
      if (json.usage) yield { type: 'usage', usage: json.usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return {
    dsh: { llm, get: (name) => (name === 'llm' ? llm : undefined) },
    setSabotage: (mode) => { sabotage = mode || null },
  }
}

/** 语言层：带工具的一轮对话（Responses API function calling），工具在本地执行。 */
export async function chatWithTools({ model, effort, system, userText, tools, maxRounds = 5 }) {
  const input = [{ role: 'user', content: [{ type: 'input_text', text: userText }] }]
  const toolDefs = tools.map((t) => ({ type: 'function', name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } }))
  const calls = []
  for (let round = 0; ; round++) {
    const json = await responses({
      model,
      instructions: system,
      input,
      ...(toolDefs.length ? { tools: toolDefs } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
      max_output_tokens: 6000,
    }, 'probe')
    const fcs = (json.output || []).filter((o) => o.type === 'function_call')
    if (!fcs.length || round >= maxRounds) return { text: outputText(json), calls }
    for (const fc of fcs) {
      input.push({ type: 'function_call', call_id: fc.call_id, name: fc.name, arguments: fc.arguments || '{}' })
      let out
      try {
        const tool = tools.find((t) => t.name === fc.name)
        out = tool ? String(await tool.execute(JSON.parse(fc.arguments || '{}'))) : `没有这个工具：${fc.name}`
      } catch (e) {
        out = `工具出错：${e.message}`
      }
      calls.push({ name: fc.name, arguments: fc.arguments || '{}', output: out.slice(0, 1500) })
      input.push({ type: 'function_call_output', call_id: fc.call_id, output: out })
    }
  }
}

/** 评测员：用另一个模型（默认 gpt-6-luna）判定，只输出 JSON。 */
export async function judgeJson(system, text) {
  const json = await responses({
    model: MODEL_CFG.judgeModel,
    instructions: system,
    input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
    reasoning: { effort: MODEL_CFG.judgeEffort },
    max_output_tokens: 4000,
  }, 'judge')
  const raw = outputText(json)
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error(`评测员没给 JSON：${raw.slice(0, 200)}`)
  return JSON.parse(m[0])
}
