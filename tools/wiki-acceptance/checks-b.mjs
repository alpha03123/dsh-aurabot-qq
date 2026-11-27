// Dreaming 检查项（Suite B）。能用字符串判的就用字符串（稳定）；需要理解语义的交给评测模型（judgeJson，真实模型）。
// 每项：{ id, desc, hard, run(ctx) → { pass, detail } }；hard=false 的只出警告不判失败。
import { judgeJson } from './lib/model.mjs'
import { allText, grepFiles, hotText, page } from './lib/sandbox.mjs'
import { PLANTED } from './timeline-b.mjs'

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
  id: 'forget-clean', desc: '「忘掉 沈川」后：Wiki（含 .history）与原话检索都查不到', hard: true,
  run: async ({ wikiDir, adapter }) => {
    const files = grepFiles(wikiDir, /沈川/)
    let searchHit = ''
    try {
      for (const kw of ['沈川', '老同学']) {
        const out = await adapter.searchChatlog?.(kw)
        const s = typeof out === 'string' ? out : JSON.stringify(out || '')
        // 检查被遗忘那行原话里的其他内容（避免因「没找到『关键词』」回显搜索词而误报）
        if (/闹掰|晦气/.test(s)) { searchHit = `用「${kw}」原话检索还能搜到被遗忘的原话`; break }
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
  '2027-03-10': [contains('plan-sakura-recorded', '南山植物园樱花野餐约定进了 近期与约定', '近期与约定', /南山|植物园|樱花/)],
  '2027-03-12': [judged('plan-sakura-rescheduled', '樱花野餐改期后只留最新安排', ['近期与约定'],
    '南山植物园看樱花野餐的安排：当前有效的是 2027-03-14（周日）下午两点；不能把 2027-03-13（周六）写成仍然有效的安排（写明「原定周六、因雨改期」可以）。')],
  '2027-03-15': [
    judged('plan-sakura-done', '南山植物园去过之后不再是待办', ['近期与约定'], '2027-03-14 已经去过南山植物园看樱花野餐。近期与约定 里不能再把去南山植物园/看樱花列为未完成的待办或未来安排（页面里完全没提也算通过）。'),
    contains('sakura-in-memories', '南山植物园这次经历归档进当月回忆', '回忆/2027-03', /南山|植物园|樱花/),
  ],
  '2027-03-17': [contains('plan-dentist-dated', '洗牙补牙换算成具体日期 03-25', '近期与约定', /(洗牙|牙科|补牙)[\s\S]{0,40}(0?3-25|3月25)|(0?3-25|3月25)[\s\S]{0,40}(洗牙|牙科|补牙)/)],
  '2027-03-19': [contains('plan-play-recorded', '话剧《夜莺》约定带日期进 近期与约定', '近期与约定', /(夜莺|话剧|大剧院)[\s\S]{0,60}(0?4-0?8|4月8)|(0?4-0?8|4月8)[\s\S]{0,60}(夜莺|话剧|大剧院)/)],
  '2027-03-23': [catchUp(['2027-03-21', '2027-03-22', '2027-03-23']), forgetClean()],
  '2027-03-26': [
    judged('plan-dentist-done', '洗牙补牙做完后不再是待办', ['近期与约定'], '洗牙补牙已于 2027-03-25 做完。近期与约定 里不能再把去洗牙/看牙列为未完成的待办（可以记「少喝碳酸饮料」这类后续提醒）。'),
    contains('durable-peanut', '花生过敏写进 主人.md', '主人', /花生/),
  ],
  '2027-03-27': [judged('pref-exercise-updated', '晚间运动习惯原地改写，不新旧并存', ['主人'],
    '主人因膝盖隐痛听从康复师建议，已停掉夜跑、改为晚上去室内游泳。笔记里关于主人当前的晚间运动习惯必须是游泳；不能把「每天夜跑」写成仍然成立的当前习惯（作为「以前」的说明可以）。如果笔记完全没提运动或游泳，判不通过。')],
  '2027-03-30': [sabotageHeld('2027-03-29')],
  '2027-03-31': [catchUp(['2027-03-30', '2027-03-31']), contains('durable-hometown', '老家扬州写进 主人.md', '主人', /扬州/)],
  '2027-04-03': [sabotageHeld('2027-04-02')],
  '2027-04-04': [catchUp(['2027-04-03', '2027-04-04']), contains('musicbox-recorded', '木质八音盒礼物有记录', '*', /八音盒/)],
  '2027-04-06': [contains('plan-play-kept', '远期约定没被降温误删（话剧《夜莺》仍在热层）', '近期与约定', /夜莺|话剧|大剧院/)],
  '2027-04-09': [
    judged('plan-play-done', '话剧《夜莺》看完后不再是待办', ['近期与约定'], '话剧《夜莺》已于 2027-04-08 晚上一起看完。近期与约定 里不能再把它列为未完成的待办。'),
    contains('play-in-memories', '话剧《夜莺》归档进 回忆/2027-04', '回忆/2027-04', /夜莺|话剧|大剧院/),
  ],
  '2027-04-12': [contains('plan-roommate-recorded', '大学室友周明来访进 近期与约定', '近期与约定', /周明/)],
}

/** 全部跑完后的检查。 */
export const FINAL = [
  {
    id: 'trivia-cooled', desc: '琐事降温：丰巢柜卡壳不在热层正文（主人/近期与约定/我）', hard: true,
    run: ({ pages }) => {
      const text = ['主人', '近期与约定', '我'].map((n) => page(pages, n)).join('\n')
      const m = text.match(/丰巢柜|快递柜/)
      return { pass: !m, detail: m ? `热层正文（主人/近期与约定/我）里还出现：${m[0]}` : '' }
    },
  },
  judged('hobby-watercolor-updated', '水彩画已放弃，不再写成当前爱好', ['主人', '我'], '主人 2027-04-04 已经放弃学画水彩。笔记不能把「正在学水彩画」写成当前状态（写「试过/学过、后来放弃了」可以，完全没提也算通过）。'),
  contains('memories-mar-sakura', '月度回忆跨月后仍保留：南山植物园樱花野餐', '回忆/2027-03', /南山|植物园|樱花/),
  contains('memories-apr-play', '当月回忆保留：话剧《夜莺》', '回忆/2027-04', /夜莺|话剧|大剧院/),
  contains('memories-apr-musicbox', '当月回忆保留：木质八音盒', '回忆/2027-04', /八音盒/),
  contains('durable-peanut-final', '花生过敏仍在 主人.md', '主人', /花生/),
  contains('durable-hometown-final', '老家扬州仍在 主人.md', '主人', /扬州/),
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
