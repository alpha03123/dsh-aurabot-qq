// 语音转文字：阿里云百炼 Paraformer 录音文件识别（没字幕的视频靠它知道里面说了什么）。
//
// 流程和 vsummary 的 aliyun_bailian_transcriber 一样，只是不用 Python SDK：
// ffmpeg 直接从 B 站音频流转出 32k 单声道 Opus → 申请 DashScope 临时上传凭证 → 表单传到 OSS
// → 提交异步转写任务（oss:// 地址要带 X-DashScope-OssResourceResolve）→ 轮询 → 下载带时间戳的句子。
// 任何一步失败都抛错，由调用方退回「没有字幕」。

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UA } from './api.js'

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
})

export function dashscopeBase(url) {
  const s = String(url || '').trim().replace(/\/+$/, '') || 'https://dashscope.aliyuncs.com'
  if (s.endsWith('/api/v1')) return s
  if (s.endsWith('/api')) return s + '/v1'
  return s + '/api/v1'
}

/** 转写结果里的句子：[{ start, end, text }]（秒）。没有人声时返回 []。 */
export function parseParaformer(payload) {
  const out = []
  const transcripts = Array.isArray(payload?.transcripts) ? payload.transcripts : [payload]
  for (const t of transcripts) {
    for (const s of Array.isArray(t?.sentences) ? t.sentences : []) {
      const text = String(s?.text || '').trim()
      if (text) out.push({ start: (Number(s.begin_time) || 0) / 1000, end: (Number(s.end_time) || 0) / 1000, text })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** ffmpeg 从流地址（或本地文件）转出单声道 32k Opus；maxSec > 0 时只转前 maxSec 秒。 */
export function extractOpus(ffmpeg, input, out, { maxSec = 0, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const remote = /^https?:/i.test(input)
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      ...(remote ? ['-headers', `Referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\n`, '-protocol_whitelist', 'http,https,tcp,tls,crypto', '-rw_timeout', '30000000'] : []),
      '-i', input, ...(maxSec > 0 ? ['-t', String(maxSec)] : []),
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', out]
    let p
    try { p = spawn(ffmpeg, args, { windowsHide: true }) } catch (error) { return reject(error) }
    let err = ''
    const timer = setTimeout(() => { try { p.kill() } catch {} reject(new Error('转音频超时')) }, timeoutMs)
    p.stderr.on('data', (d) => { if (err.length < 2000) err += d })
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error('ffmpeg 转音频失败：' + err.trim().slice(0, 200)))
    })
  })
}

export function createParaformer({ getKey, getBase, getModel, fetchImpl = fetch, log }) {
  async function call(url, { method = 'GET', body, headers = {}, timeoutMs = 30000, signal } = {}) {
    const key = await getKey()
    if (!key) throw new Error('没填阿里云百炼的 API Key')
    const timeout = AbortSignal.timeout(timeoutMs)
    const r = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`百炼返回 HTTP ${r.status}${j.code ? ' ' + j.code : ''}${j.message ? '：' + j.message : ''}`)
    return j
  }

  /** 临时上传：拿凭证 → 表单 POST 到 OSS → oss://key（48 小时内有效）。 */
  async function upload(file, { signal } = {}) {
    const model = getModel()
    const base = dashscopeBase(getBase())
    const j = await call(`${base}/uploads?action=getPolicy&model=${encodeURIComponent(model)}`, { signal })
    const u = j.data || j.output || {}
    if (!u.upload_host || !u.upload_dir) throw new Error('百炼没给上传凭证')
    const name = `bili-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.opus`
    const key = `${u.upload_dir}/${name}`
    const fd = new FormData()
    fd.set('OSSAccessKeyId', u.oss_access_key_id)
    fd.set('Signature', u.signature)
    fd.set('policy', u.policy)
    fd.set('key', key)
    fd.set('x-oss-object-acl', u.x_oss_object_acl)
    fd.set('x-oss-forbid-overwrite', u.x_oss_forbid_overwrite)
    fd.set('success_action_status', '200')
    fd.set('x-oss-content-type', 'audio/ogg')
    fd.set('file', new Blob([readFileSync(file)], { type: 'audio/ogg' }), name)
    const timeout = AbortSignal.timeout(120000)
    const r = await fetchImpl(u.upload_host, { method: 'POST', body: fd, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    if (r.status !== 200) throw new Error(`传音频到百炼临时存储失败：HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`)
    return 'oss://' + key
  }

  /** 转写一个本地音频文件，返回句子。 */
  async function transcribeFile(file, { language = 'zh', signal, timeoutMs = 300000 } = {}) {
    const base = dashscopeBase(getBase())
    const url = await upload(file, { signal })
    const model = getModel()
    const task = await call(`${base}/services/audio/asr/transcription`, {
      method: 'POST',
      headers: { 'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable' },
      body: { model, input: { file_urls: [url] }, parameters: model.includes('paraformer-v2') && language ? { language_hints: [language] } : {} },
      signal,
    })
    const id = task.output?.task_id
    if (!id) throw new Error('百炼没给任务号')
    const deadline = Date.now() + timeoutMs
    let out
    for (let wait = 1500; ; wait = Math.min(wait * 1.5, 6000)) {
      await sleep(wait, signal)
      out = (await call(`${base}/tasks/${id}`, { signal })).output || {}
      const st = String(out.task_status || '').toUpperCase()
      if (st !== 'PENDING' && st !== 'RUNNING') break
      if (Date.now() > deadline) throw new Error('百炼转写超时')
    }
    const first = (out.results || [])[0] || {}
    const code = first.code || out.code
    if (code === 'SUCCESS_WITH_NO_VALID_FRAGMENT') return []
    if (String(out.task_status).toUpperCase() !== 'SUCCEEDED' || first.subtask_status === 'FAILED') {
      throw new Error(`百炼转写没成功：${out.task_status}${code ? ' ' + code : ''}${first.message || out.message ? '：' + (first.message || out.message) : ''}`)
    }
    if (!first.transcription_url) return parseParaformer(out)
    const r = await fetchImpl(first.transcription_url, { signal: AbortSignal.timeout(60000) })
    if (!r.ok) throw new Error('下载转写结果失败：HTTP ' + r.status)
    return parseParaformer(await r.json())
  }

  /** 从 B 站音频流转写：先转成小 Opus 再传（10 分钟约 2.4MB）。 */
  async function transcribeStream({ ffmpeg, audioUrl, maxSec = 0, signal }) {
    const dir = mkdtempSync(join(tmpdir(), 'aurabot-asr-'))
    try {
      const file = await extractOpus(ffmpeg, audioUrl, join(dir, 'a.opus'), { maxSec })
      const started = Date.now()
      const segs = await transcribeFile(file, { signal })
      log?.debug?.(`百炼转写：${(statSync(file).size / 1e6).toFixed(1)}MB，${segs.length} 句，${Date.now() - started}ms`)
      return segs
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  return { upload, transcribeFile, transcribeStream }
}
