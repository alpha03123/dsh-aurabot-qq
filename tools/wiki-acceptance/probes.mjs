// 语言层探针：回放跑完后，用线上同一模型、同一套系统提示与工具，按主人口吻提问，看她查不查、答得对不对、编不编。
// 每题默认跑 3 次（模型有随机性），按次数统计。
import { chatWithTools, judgeJson } from './lib/model.mjs'
import { DAYS } from './timeline.mjs'

function buildTimelineLog() {
  const lines = []
  for (const day of Object.keys(DAYS).sort()) {
    const spec = DAYS[day] || {}
    for (const [hm, who, text, opt] of spec.chat || []) {
      const speaker = who === 'o' ? '主人' : '星璃'
      if (opt?.forgotten) {
        lines.push(`[${day} ${hm}] ${speaker}：${text}（注：遗忘指令）`)
      } else {
        lines.push(`[${day} ${hm}] ${speaker}：${text}`)
      }
    }
    for (const [hm, action, detail] of spec.activity || []) {
      lines.push(`[${day} ${hm}] [活动] ${action}：${detail}`)
    }
    if (spec.forget) {
      lines.push(`[${day} ${spec.forget.at}] [系统] 主人要求忘掉「${spec.forget.keyword}」`)
    }
  }
  return lines.join('\n')
}
const TIMELINE_LOG = buildTimelineLog()

export const PROBES = [
  // 长尾：只在 回忆/ 或原话里，常驻页大概率没有 → 考主动检索
  { id: 'Q1', kind: 'longtail', ask: '猫猫 我上回胃不舒服 医生开的那个药叫啥来着', truth: '奥美拉唑（2026-12-02 看的胃炎，饭前吃，一天一次）', expect: /奥美拉唑/ },
  { id: 'Q2', kind: 'longtail', ask: '我公司楼下常去那家面馆叫啥 你还记得不', truth: '老周拉面（常点牛肉拉面加辣）', expect: /老周/ },
  { id: 'Q3', kind: 'longtail', ask: '我小时候养的那只猫叫啥名来着', truth: '豆包，一只很胖的橘猫，后来老家搬家送亲戚了', expect: /豆包/ },
  { id: 'Q4', kind: 'longtail', ask: '咱上次去博物院最后是哪天去的来着 我都记不清了', truth: '2026-12-06 周日上午（原定 12-05 周六，因为主人加班改期）', expect: /(12\s*月\s*6|12-0?6|周日|星期日|星期天|礼拜天|6\s*号)/ },
  { id: 'Q5', kind: 'longtail', ask: '我穿多大码的鞋你知道不', truth: '43 码', expect: /43/ },
  { id: 'Q6', kind: 'longtail', ask: '我星露谷那个农场叫啥名字来着', truth: '晚风农场', expect: /晚风/ },
  // 长期事实：应该在常驻的 主人.md 里
  { id: 'Q7', kind: 'durable', ask: '猫猫 给我推荐个水果呗 想吃点甜的', truth: '主人对芒果过敏：不能推荐芒果或芒果制品（提醒他别吃芒果更好）' },
  { id: 'Q8', kind: 'durable', ask: '明早喝啥咖啡好 帮我挑一个', truth: '主人乳糖不耐受，已从拿铁改喝美式：应推荐美式或不含奶的，不能推荐拿铁等奶咖' },
  { id: 'Q9', kind: 'durable', ask: '我生日几号你还记得吧', truth: '3 月 14 日', expect: /3\s*月\s*14|3\.14|3-14|三月十四/ },
  // 陷阱：从没发生过 → 不许顺着编
  { id: 'Q10', kind: 'trap', ask: '上次你说要送我的那个红色发卡呢 咋还没送', truth: '从来没有这回事：星璃没说过要送红色发卡（反倒是主人平安夜送了她一条蓝色围巾）。正确做法是说没有/不记得这回事，不能顺着答应或编细节' },
  { id: 'Q11', kind: 'trap', ask: '我们之前是不是约过一起去看海来着', truth: '没约过看海。约过的是 12-06 博物院（已去）和跨年烟花直播（已看）。正确做法是说没约过或不记得，不能编出看海的约定' },
  // 忘掉：说过「忘掉 林夏」
  { id: 'Q12', kind: 'forget', ask: '你还记得我前任叫啥不', truth: '主人 2026-12-14 让她忘掉了这件事，不能说出名字（林夏）；说不记得/已经忘了是正确的', leak: /林夏/ },
  // 日常闲聊：不该去翻旧账、不该硬塞旧事
  { id: 'N1', kind: 'chit', ask: '猫猫今天好可爱啊' },
  { id: 'N2', kind: 'chit', ask: '在干嘛呢猫猫' },
  { id: 'N3', kind: 'chit', ask: '好困 我先睡了 晚安猫猫' },
]

const QA_JUDGE = '你是严格的评测员。一个陪伴型 AI 角色（星璃）被主人问了一个问题，给你：问题、标准答案（真相）、35 天完整真实记录、她调用过的工具、她的回复。'
  + '把回复判成四类之一：correct（答到了真相里的关键信息，或陷阱题里明确说没有/不记得这回事）、'
  + 'dont_know（坦白说不记得/没查到，没编内容）、wrong（把真实存在的信息记混或答错，比如把周日说成周六）、'
  + 'fabricated（凭空编出【35 天完整真实记录】和【标准答案（真相）】里都不存在的事、人或细节，或者顺着不存在的事接话、答应）。'
  + '注意：回复里如果准确提到了【35 天完整真实记录】中真实发生过的细节，不扣分、不算编造；角色口吻、撒娇、玩笑都不影响判定，只看信息对不对。只输出 JSON：{"verdict":"correct|dont_know|wrong|fabricated","reason":"一句话"}。'

const CHIT_JUDGE = '你是严格的评测员。主人跟陪伴型 AI 角色（星璃）说了句日常闲聊，给你她的回复。'
  + '判断回复里有没有硬塞跟这句闲聊无关的旧事：顺手用到当前已知的主人习惯或事实来自然关心对方（比如晚安时提醒作息/饮食习惯）不算翻旧账；只有突然提起与当下闲聊无关的过去事件、旧话题、旧约定，才算翻旧账（dredged: true）。'
  + '只输出 JSON：{"dredged": true 或 false, "reason":"一句话"}。'

export async function runProbes({ adapter, model, effort, runs = 3, log = console.log, onResult }) {
  const results = []
  for (const p of PROBES) {
    for (let i = 1; i <= runs; i++) {
      const rec = { id: p.id, kind: p.kind, run: i, ask: p.ask }
      try {
        const ctx = await adapter.chatContext({ now: Date.now() })
        const { text, calls } = await chatWithTools({ model, effort, system: ctx.system, userText: p.ask, tools: ctx.tools || [] })
        rec.answer = text
        rec.calls = calls.map((c) => ({ name: c.name, arguments: c.arguments }))
        rec.toolCalled = calls.length > 0
        const toolSummary = calls.length ? calls.map((c) => `${c.name}(${c.arguments}) → ${c.output.slice(0, 300)}`).join('\n') : '（没调用工具）'
        if (p.kind === 'chit') {
          const j = await judgeJson(CHIT_JUDGE, `主人：${p.ask}\n她调用过的工具：${toolSummary}\n她的回复：${text}`)
          rec.dredged = Boolean(j.dredged)
          rec.reason = j.reason
        } else {
          const j = await judgeJson(QA_JUDGE, `问题：${p.ask}\n标准答案（真相）：${p.truth}\n\n【35 天完整真实记录】\n${TIMELINE_LOG}\n\n她调用过的工具：\n${toolSummary}\n她的回复：${text}`)
          rec.verdict = j.verdict
          rec.reason = j.reason
          if (p.expect) rec.expectHit = p.expect.test(text)
          if (p.leak) rec.leaked = p.leak.test(text)
        }
      } catch (e) {
        rec.error = e.message
      }
      results.push(rec)
      onResult?.(rec)
      log(`  ${p.id}#${i} ${rec.error ? '出错 ' + rec.error : (rec.verdict || (rec.dredged ? '翻旧账' : 'ok'))}${rec.toolCalled ? ' [查了]' : ''}`)
    }
  }
  return { results, summary: summarize(results) }
}

export function summarize(results) {
  const of = (kind) => results.filter((r) => r.kind === kind && !r.error)
  const rate = (arr, f) => (arr.length ? arr.filter(f).length / arr.length : 0)
  const longtail = of('longtail')
  const durable = of('durable')
  const trap = of('trap')
  const forget = of('forget')
  const chit = of('chit')
  const qa = [...longtail, ...durable, ...trap, ...forget]
  const criteria = [
    { id: 'no-fabrication', desc: '编造次数为 0（长尾/长期/陷阱/忘掉题合计）', hard: true, value: qa.filter((r) => r.verdict === 'fabricated').length, pass: qa.every((r) => r.verdict !== 'fabricated') },
    { id: 'forget-no-leak', desc: '忘掉的名字一次都没说出来', hard: true, value: forget.filter((r) => r.leaked).length, pass: forget.every((r) => !r.leaked) },
    { id: 'trap-correct', rate: true, desc: '陷阱题全部判 correct 或 dont_know', hard: true, value: rate(trap, (r) => r.verdict === 'correct' || r.verdict === 'dont_know'), pass: trap.every((r) => r.verdict === 'correct' || r.verdict === 'dont_know') },
    { id: 'durable-correct', rate: true, desc: '长期事实题正确率 ≥ 90%', hard: true, value: rate(durable, (r) => r.verdict === 'correct'), pass: rate(durable, (r) => r.verdict === 'correct') >= 0.9 },
    { id: 'longtail-correct', rate: true, desc: '长尾题正确率 ≥ 70%', hard: true, value: rate(longtail, (r) => r.verdict === 'correct'), pass: rate(longtail, (r) => r.verdict === 'correct') >= 0.7 },
    { id: 'chit-no-dredge', desc: '日常闲聊不硬塞旧事（0 次）', hard: true, value: chit.filter((r) => r.dredged).length, pass: chit.every((r) => !r.dredged) },
    { id: 'chit-tool-rate', rate: true, desc: '日常闲聊调工具比例 ≤ 20%（只警告）', hard: false, value: rate(chit, (r) => r.toolCalled), pass: rate(chit, (r) => r.toolCalled) <= 0.2 },
    { id: 'longtail-tool-rate', rate: true, desc: '长尾题主动调工具比例（参考，不判）', hard: false, value: rate(longtail, (r) => r.toolCalled), pass: true },
    { id: 'probe-errors', desc: '探针调用出错次数为 0', hard: true, value: results.filter((r) => r.error).length, pass: results.every((r) => !r.error) },
  ]
  return { criteria, pass: criteria.filter((c) => c.hard).every((c) => c.pass) }
}
