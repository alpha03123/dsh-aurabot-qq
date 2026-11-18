// 换头像（B 站等）时的图片来源校验。原来放在 QQ 改资料模块里，那个模块在 Discord fork 里删了，挪到这里。

/** 头像来源只收 http(s) 网址；「刚才那张图」和「画作 #1」在工具里单独取字节，本地路径一律不收。 */
export function avatarSource(input) {
  const s = String(input || '').trim()
  if (/^https?:\/\//i.test(s)) return { ok: true, file: s }
  return { ok: false, message: '头像只能用网址图片，或者「刚才那张图」/「画作 #1」' }
}
