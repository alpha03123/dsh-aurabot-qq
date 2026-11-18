// QQ 系统表情（小黄脸）：<face:名字> 换成消息段、认不出的去掉；网关目录只要数字编号、同名优先普通表情；收到的按名字给她看；提示词按开关教她。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textToSegments, stripFaceTags, buildFaceIndex, createFaces, COMMON_FACES, splitSpeakable, speakableText } from '../src/chat/faces.js'
import { parseMessageEvent } from '../src/chat/inbound.js'
import { rulesText } from '../src/persona/personas.js'
import { normalize } from '../src/core/config.js'

const idOf = (n) => COMMON_FACES[n]

test('语音文本拆分：表情不念出来，但要留着补发（<face:名字> 原文保留）', () => {
  assert.deepEqual(splitSpeakable('<face:呲牙>晚安😁'), { spoken: '晚安', extras: '<face:呲牙>😁' })
  assert.deepEqual(splitSpeakable('晚安啦<face:捂脸></face>'), { spoken: '晚安啦', extras: '<face:捂脸>' })
  assert.deepEqual(splitSpeakable('晚安 👨‍👩‍👧 做个好梦'), { spoken: '晚安 做个好梦', extras: '👨‍👩‍👧' })
  assert.deepEqual(splitSpeakable('晚安🇨🇳'), { spoken: '晚安', extras: '🇨🇳' }, '国旗是区域指示符，不在 Extended_Pictographic 里，不能留在要念的字里')
  assert.deepEqual(splitSpeakable('第1️⃣名'), { spoken: '第名', extras: '1️⃣' }, '键帽连前面的数字一起拆走')
  assert.deepEqual(splitSpeakable('苏格兰🏴󠁧󠁢󠁳󠁣󠁴󠁿好'), { spoken: '苏格兰好', extras: '🏴󠁧󠁢󠁳󠁣󠁴󠁿' }, '标签字符序列也要拆干净')
  assert.deepEqual(splitSpeakable('你好 👋🏽'), { spoken: '你好', extras: '👋🏽' }, '肤色修饰符不能留在要念的字里')
  assert.deepEqual(splitSpeakable('😭<face:大哭>'), { spoken: '', extras: '😭<face:大哭>' })
  assert.deepEqual(splitSpeakable('<sticker:委屈><poke>晚安'), { spoken: '晚安', extras: '' }, '表情包/戳一戳没有单独补发的说法')
  assert.deepEqual(splitSpeakable('好<face:这是一个特别特别长的表情名字>呀'), { spoken: '好<face:这是一个特别特别长的表情名字>呀', extras: '' }, '超长名字不算 face 标签，和以前一样留在要念的字里')
  assert.deepEqual(splitSpeakable('普通的话'), { spoken: '普通的话', extras: '' })
  assert.equal(speakableText('<face:呲牙>晚安😁'), '晚安', '老接口行为不变')
})
