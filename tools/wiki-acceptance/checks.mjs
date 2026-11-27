// Dreaming 检查项。能用字符串判的就用字符串（稳定）；需要理解语义的交给评测模型（judgeJson，真实模型）。
// 每项：{ id, desc, hard, run(ctx) → { pass, detail } }；hard=false 的只出警告不判失败。
import { judgeJson } from './lib/model.mjs'
import { allText, grepFiles, hotText, page } from './lib/sandbox.mjs'
import { PLANTED } from './timeline.mjs'

const REL_WORD = /(明天|后天|大后天|今晚|今天|昨天|昨晚|前天|下周|下礼拜|这周|本周|下个月|这个月|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天])/
const ABS_DATE = /(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}[日号]?|\d{1,2}[-/.]\d{1,2})/

/** 近期与约定 里带相对时间、又没有具体日期的行。 */
export function relativeDateLines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('---') && REL_WORD.test(l) && !ABS_DATE.test(l))
}

const contains = (id, desc, pageName, re, hard = true) => ({
  id, desc, hard,
  run: ({ pages }) => {
    const text = pageName === '*' ? allText(pages) : pageName === 'hot' ? hotText(pages) : page(pages, pageName)
    return { pass: re.test(text), detail: re.test(text) ? '' : `「${pageName}」里没找到 ${re}` }
  },
})

const notContains = (id, desc, pageName, re, hard = true) => ({
  id, desc, hard,
  run: ({ pages }) => {
    const text = pageName === '*' ? allText(pages) : pageName === 'hot' ? hotText(pages) : page(pages, pageName)
    const m = text.match(re)
    return { pass: !m, detail: m ? `「${pageName}」里还出现：${m[0]}` : '' }
  },
})

const JUDGE_SYS = '你是严格的评测员，检查一个陪伴型 AI 角色（星璃）自己写的记忆笔记是否满足一条要求。只依据给出的笔记正文判断，不要脑补。只输出 JSON：{"pass": true 或 false, "reason": "一句话理由，引用笔记里的原文"}。'

const judged = (id, desc, pageNames, requirement, hard = true) => ({
  id, desc, hard,
  run: async ({ pages, day }) => {
    const body = pageNames.map((n) => `【${n}】\n${page(pages, n) || '（这一页不存在或为空）'}`).join('\n\n')
    const r = await judgeJson(JUDGE_SYS, `回放日期：${day}（这一晚的 Dreaming 刚跑完）\n要求：${requirement}\n\n${body}`)
    return { pass: Boolean(r.pass), detail: String(r.reason || '') }
  },
})

const catchUp = (expected) => ({
  id: 'cursor-catchup', desc: `游标补跑按顺序追平 ${expected.join('、')}`, hard: true,
  run: ({ result }) => {
    const days = Array.isArray(result?.days) ? result.days : []
    const pass = JSON.stringify(days) === JSON.stringify(expected)
    return { pass, detail: pass ? '' : `实际整理的日期：${JSON.stringify(days)}` }
  },
})

const sabotageHeld = (prevDay) => ({
  id: 'sabotage-guard', desc: `上游出错的一晚：页面不被改坏，游标停在 ${prevDay}`, hard: true,
  run: ({ hashBefore, hashAfter, state }) => {
    const problems = []
    if (hashBefore !== hashAfter) problems.push('页面内容被改动了')
    if (state?.lastDreamedDay !== prevDay) problems.push(`游标是 ${state?.lastDreamedDay}`)
    return { pass: !problems.length, detail: problems.join('；') }
  },
})

const forgetClean = () => ({
  id: 'forget-clean', desc: '「忘掉 林夏」后：Wiki（含 .history）与原话检索都查不到', hard: true,
  run: async ({ wikiDir, adapter }) => {
    const files = grepFiles(wikiDir, /林夏/)
    let searchHit = ''
    try {
      for (const kw of ['林夏', '前任']) {
        const out = await adapter.searchChatlog?.(kw)
        const s = typeof out === 'string' ? out : JSON.stringify(out || '')
        // 检查被遗忘那行原话里的其他内容（避免因「没找到『关键词』」回显搜索词而误报）
        if (/朋友圈/.test(s)) { searchHit = `用「${kw}」原话检索还能搜到被遗忘的原话`; break }
      }
    } catch (e) { searchHit = `原话检索报错：${e.message}` }
    const problems = [...(files.length ? [`文件里还有：${files.map((f) => f.split(/[\\/]/).slice(-2).join('/')).join('、')}`] : []), ...(searchHit ? [searchHit] : [])]
    return { pass: !problems.length, detail: problems.join('；') }
  },
})

/** 每晚都跑的检查。 */
export const EVERY_NIGHT = [
  {
    id: 'no-relative-dates', desc: '近期与约定 没有只写相对时间（明天/周六/下周…）不写日期的行', hard: true,
    run: ({ pages }) => {
      const bad = relativeDateLines(page(pages, '近期与约定'))
      return { pass: !bad.length, detail: bad.slice(0, 5).join(' ｜ ') }
    },
  },
]

/** 某一晚 Dreaming 跑完后的检查（键 = 被整理的那一天）。 */
export const AFTER_NIGHT = {
  '2026-12-01': [contains('plan-museum-recorded', '博物院约定进了 近期与约定', '近期与约定', /博物/)],
  '2026-12-03': [judged('plan-museum-rescheduled', '博物院改期后只留最新安排', ['近期与约定'],
    '博物院的安排：当前有效的是 2026-12-06（周日）上午十点；不能把 2026-12-05（周六）写成仍然有效的安排（写明「原定周六、已改期」可以）。')],
  '2026-12-07': [
    judged('plan-museum-done', '博物院去过之后不再是待办', ['近期与约定'], '2026-12-06 已经去过博物院。近期与约定 里不能再把去博物院列为未完成的待办或未来安排（页面里完全没提也算通过）。'),
    contains('museum-in-memories', '博物院这次经历归档进当月回忆', '回忆/2026-12', /博物/),
  ],
  '2026-12-09': [contains('plan-checkup-dated', '体检换算成具体日期 12-16', '近期与约定', /体检[\s\S]{0,40}(12-16|12月16)|(12-16|12月16)[\s\S]{0,40}体检/)],
  '2026-12-11': [contains('plan-fireworks-recorded', '跨年烟花约定带日期进 近期与约定', '近期与约定', /(烟花|跨年)[\s\S]{0,60}(12-31|12月31)|(12-31|12月31)[\s\S]{0,60}(烟花|跨年)/)],
  '2026-12-14': [catchUp(['2026-12-12', '2026-12-13', '2026-12-14']), forgetClean()],
  '2026-12-17': [
    judged('plan-checkup-done', '体检做完后不再是待办', ['近期与约定'], '体检已于 2026-12-16 做完。近期与约定 里不能再把体检列为未完成的待办（可以记「体检结果约一周后出」这类后续）。'),
    contains('durable-mango', '芒果过敏写进 主人.md', '主人', /芒果/),
  ],
  '2026-12-18': [judged('pref-coffee-updated', '咖啡习惯原地改写，不新旧并存', ['主人'],
    '主人因乳糖不耐受已从拿铁改喝美式。笔记里关于主人喝咖啡的当前习惯必须是美式；不能把「每天喝拿铁」写成仍然成立的习惯（作为「以前」的说明可以）。如果笔记完全没提咖啡，判不通过。')],
  '2026-12-21': [sabotageHeld('2026-12-20')],
  '2026-12-22': [catchUp(['2026-12-21', '2026-12-22']), contains('durable-birthday', '生日 3月14日 写进 主人.md', '主人', /3\s*月\s*14|03-14|3-14|三月十四/)],
  '2026-12-25': [sabotageHeld('2026-12-24')],
  '2026-12-26': [catchUp(['2026-12-25', '2026-12-26']), contains('scarf-recorded', '平安夜蓝色围巾有记录', '*', /围巾/)],
  '2026-12-30': [contains('plan-fireworks-kept', '远期约定没被降温误删（跨年烟花仍在热层）', '近期与约定', /烟花|跨年/)],
  '2027-01-01': [
    judged('plan-fireworks-done', '跨年烟花看完后不再是待办', ['近期与约定'], '跨年烟花已于 2026-12-31 晚上一起看完。近期与约定 里不能再把它列为未完成的待办。'),
    contains('fireworks-in-memories', '跨年烟花归档进 回忆/2026-12', '回忆/2026-12', /烟花|跨年/),
  ],
  '2027-01-02': [contains('plan-cousin-recorded', '表妹小禾来访进 近期与约定', '近期与约定', /小禾/)],
}

/** 全部跑完后的检查。 */
export const FINAL = [
  {
    id: 'trivia-cooled', desc: '琐事降温：酸菜鱼不在热层正文（主人/近期与约定/我）', hard: true,
    run: ({ pages }) => {
      const text = ['主人', '近期与约定', '我'].map((n) => page(pages, n)).join('\n')
      const m = text.match(/酸菜鱼/)
      return { pass: !m, detail: m ? `热层正文（主人/近期与约定/我）里还出现：${m[0]}` : '' }
    },
  },
  judged('hobby-guitar-updated', '吉他已放弃，不再写成当前爱好', ['主人', '我'], '主人 2026-12-28 已经放弃学吉他。笔记不能把「正在学吉他」写成当前状态（写「学过、后来放弃了」可以，完全没提也算通过）。'),
  contains('memories-dec-museum', '月度回忆跨月后仍保留：博物院', '回忆/2026-12', /博物/),
  contains('memories-dec-fireworks', '月度回忆跨月后仍保留：跨年烟花', '回忆/2026-12', /烟花|跨年/),
  contains('memories-dec-scarf', '月度回忆跨月后仍保留：蓝色围巾', '回忆/2026-12', /围巾/),
  contains('durable-mango-final', '芒果过敏仍在 主人.md', '主人', /芒果/),
  contains('durable-birthday-final', '生日仍在 主人.md', '主人', /3\s*月\s*14|03-14|3-14|三月十四/),
  forgetClean(),
  {
    id: 'planted-survival', desc: '埋点细节至少 8/10 还能在 Wiki（不含 .history）里找到', hard: true,
    run: ({ pages }) => {
      const text = allText(pages)
      const lost = PLANTED.filter((f) => !f.re.test(text))
      return { pass: PLANTED.length - lost.length >= 8, detail: `${PLANTED.length - lost.length}/${PLANTED.length}` + (lost.length ? `，丢了：${lost.map((f) => f.label).join('、')}` : '') }
    },
  },
  {
    id: 'history-kept', desc: '.history 里有修改前快照', hard: true,
    run: ({ history }) => ({ pass: history.length > 0, detail: `${history.length} 份快照` }),
  },
  {
    id: 'hot-size', desc: '常驻四页总字数不超过 8000（只警告，具体看曲线）', hard: false,
    run: ({ pages }) => { const n = [...hotText(pages)].length; return { pass: n <= 8000, detail: `${n} 字` } },
  },
]
