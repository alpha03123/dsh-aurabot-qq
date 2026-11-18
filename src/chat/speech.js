// 语音条的文字处理：念的时候去掉表情 / 格式标签 / emoji，表情单独补一条文字。
// 原来和 QQ 小黄脸放在 faces.js 里；Discord fork 删了小黄脸，这几个通用函数挪到这里。
// <face:名字> 标签照样会被去掉——模型偶尔还会照老习惯写出来。

const FACE_TAG = /<face:\s*([^>]{1,12}?)\s*>(?:\s*<\/face>)?/g

export const stripFaceTags = (text) => String(text ?? '').replace(FACE_TAG, '').replace(/[ \t]{2,}/g, ' ').trim()

/** 语音文本收尾：去掉 <voice> 标签、连续空格、首尾空白。 */
const tidySpeech = (s) => String(s).replace(/<\/?voice>/g, '').replace(/[ \t]{2,}/g, ' ').trim()

/**
 * 语音条要念的文字：去掉 QQ 小黄脸标签、表情包/戳一戳等格式标签、以及 emoji 图形符号，
 * 不然 TTS 会把「呲牙」这类表情名字甚至 emoji 直接念出来（用户反馈：发语音时表情被读出来）。
 * 去掉后没字可念时返回空串，由调用方决定改发文字。
 */
export function speakableText (text) {
  return splitSpeakable(text).spoken
}

/**
 * 把一条语音拆成「要念的」和「只剩表情/符号的」两半：表情不念出来，但单独补一条文字发出去
 * （用户反馈：发语音时表情直接消失，希望表情和语音分开发）。
 * 表情包 / 戳一戳 / 小黄脸标签没有「单独发一条」的说法，只从语音里去掉。
 * 例：'晚安😁' → { spoken: '晚安', extras: '😁' }
 */
export function splitSpeakable (text) {
  const raw = String(text ?? '')
  // emoji 的那一段：图形符号之外还要算上区域指示符（🇨🇳 这类国旗不在 Extended_Pictographic 里，单列会漏掉、被 TTS 念出来）、
  // 键帽（1️⃣ 要连前面的数字一起拆走）、连接符 / 变体选择符、肤色修饰符（👋🏽）、标签字符（🏴󠁧󠁢󠁳󠁣󠁴󠁿 的尾巴）。
  const re = /<face:[^>]{1,12}?>(?:\s*<\/face>)?|<sticker:[^>]*>(?:\s*<\/sticker>)?|<poke\s*\/?>|[#*0-9]\uFE0F?\u20E3|[\p{Extended_Pictographic}\p{Regional_Indicator}\u200D\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/gu
  let spoken = ''
  let extras = ''
  let last = 0
  let m
  while ((m = re.exec(raw)) !== null) {
    spoken += raw.slice(last, m.index)
    if (!m[0].startsWith('<')) extras += m[0] // 不是标签：emoji / 国旗 / 键帽，要补发
    last = m.index + m[0].length
  }
  spoken += raw.slice(last)
  return { spoken: tidySpeech(spoken), extras: tidySpeech(extras) }
}
