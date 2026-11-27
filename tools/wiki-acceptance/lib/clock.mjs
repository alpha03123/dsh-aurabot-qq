// 假时钟：把全局 Date 换成「回放时间 + 真实流逝」，实现里的 Date.now() / new Date() 都会拿到回放日期。
// 必须在 import 被测代码之前 installClock()。
const RealDate = globalThis.Date
let base = RealDate.now()
let anchor = RealDate.now()
const nowMs = () => base + (RealDate.now() - anchor)

class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(nowMs())
    else super(...args)
  }
  static now() { return nowMs() }
}
FakeDate.parse = RealDate.parse
FakeDate.UTC = RealDate.UTC

export function installClock() { globalThis.Date = FakeDate }
export function setClock(ts) { base = Number(ts); anchor = RealDate.now() }
export const realNow = () => RealDate.now()

/** 本地时间的时间戳：at('2026-12-01', '19:05') */
export function at(day, hm = '12:00') {
  return new RealDate(`${day}T${hm.length === 5 ? hm : hm.padStart(5, '0')}:00`).getTime()
}

export function addDays(day, n) {
  const d = new RealDate(`${day}T12:00:00`)
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function dayRange(from, to) {
  const out = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}
