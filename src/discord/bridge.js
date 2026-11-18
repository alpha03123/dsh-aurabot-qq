// 内嵌协议桥的管家：把 bridge/start.mjs（onebots + Discord 适配器，OneBot v12）当子进程拉起、看着、关掉。
//
// · 一个 bot（一个 DSH）一个桥进程，用自己的 token；端口每次启动现找一个空闲的，只听 127.0.0.1
// · 插件和桥之间的访问令牌第一次启动时生成并存进配置（discord.accessToken）
// · 桥打印 AURABOT_BRIDGE_READY 后才算起来了，连接地址从那一行里拿
// · 桥意外退出就按退避时间重启；插件卸载时关 stdin，桥自己退出（不留孤儿进程）

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const RESTART_MIN = 5_000
const RESTART_MAX = 120_000
const READY_TIMEOUT = 90_000

/** 找一个本机空闲端口 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** token 第一段是 base64 的机器人 ID */
export function botIdOfToken(token) {
  try {
    const id = Buffer.from(String(token || '').split('.')[0], 'base64').toString('utf8').trim()
    return /^\d{15,22}$/.test(id) ? id : ''
  } catch (error) {
    return ''
  }
}

/**
 * @param {object} o
 * @param {() => object} o.getConfig
 * @param {(patch: object) => void} o.saveDiscord  把 discord.* 的改动存进配置
 * @param {string} o.rootDir   插件根目录（bridge/ 在它下面）
 * @param {string} o.dataDir   插件数据目录（桥的 ID 映射表放在 bridge/ 子目录）
 * @param {{info:Function, warn:Function, debug:Function}} o.log
 * @param {(s: string) => void} [o.onReady]
 */
export function createDiscordBridge({ getConfig, saveDiscord, rootDir, dataDir, log, onReady, spawnImpl = spawn }) {
  const dir = join(rootDir, 'bridge')
  const script = join(dir, 'start.mjs')
  let proc = null
  let ready = null // { botUserId, httpUrl, wsUrl }
  let starting = null
  let stopping = false
  let disposed = false
  let restartTimer = null
  let backoff = RESTART_MIN
  let lastError = ''
  let startedAt = 0
  let held = false // 面板上手动点了「停止」：看门狗别再自动拉起，等手动启动

  const cfg = () => getConfig().discord || {}

  function detect() {
    const installed = existsSync(script) && existsSync(join(dir, 'node_modules', '@onebots', 'protocol-onebot-v12'))
    return { installed, dir, hasToken: Boolean(cfg().token), botId: botIdOfToken(cfg().token) }
  }

  function accessToken() {
    let t = cfg().accessToken
    if (!t) {
      t = randomBytes(24).toString('hex')
      saveDiscord({ accessToken: t })
    }
    return t
  }

  function scheduleRestart() {
    clearTimeout(restartTimer)
    if (disposed || stopping || !cfg().autoStart || !getConfig().enabled) return
    restartTimer = setTimeout(() => { start().catch(() => {}) }, backoff)
    restartTimer.unref?.()
    backoff = Math.min(RESTART_MAX, backoff * 2)
  }

  async function start() {
    if (disposed) return { ok: false, message: '插件已卸载' }
    if (proc && ready) return { ok: true, message: '协议桥已经在跑了' }
    if (starting) return starting
    held = false
    const inst = detect()
    if (!inst.installed) return { ok: false, message: `协议桥还没装好：在 ${dir} 里运行一次 npm install` }
    if (!inst.hasToken) return { ok: false, message: '还没填 Discord 机器人 token' }
    if (!inst.botId) return { ok: false, message: 'Discord token 格式不对' }
    stopping = false
    starting = (async () => {
      const port = await freePort()
      const bridgeData = join(dataDir, 'bridge')
      mkdirSync(bridgeData, { recursive: true })
      const env = {
        ...process.env,
        DISCORD_TOKEN: cfg().token,
        BRIDGE_PORT: String(port),
        BRIDGE_ACCESS_TOKEN: accessToken(),
        BRIDGE_DATA_DIR: bridgeData,
        DISCORD_PROXY_URL: cfg().proxyUrl || '',
        FFMPEG_PATH: getConfig().bili?.ffmpegPath || process.env.FFMPEG_PATH || '',
      }
      ready = null
      lastError = ''
      const child = spawnImpl(process.execPath, [script], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      proc = child
      startedAt = Date.now()
      let buf = ''
      const onLine = (line) => {
        const m = line.match(/AURABOT_BRIDGE_READY (\{.*\})/)
        if (m) {
          try {
            ready = JSON.parse(m[1])
            backoff = RESTART_MIN
            log.info(`协议桥起来了（机器人 ${ready.botUserId}，端口 ${port}）`)
            onReady?.(ready)
          } catch (error) {}
          return
        }
        if (/ERROR|AURABOT_BRIDGE_ERROR/.test(line)) { lastError = line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 300); log.warn('协议桥：', lastError) }
        else if (/WARN|\[voice\]/.test(line)) log.debug('协议桥：', line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 300))
      }
      const feed = (d) => {
        buf += String(d)
        let i
        while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1) }
      }
      child.stdout.on('data', feed)
      child.stderr.on('data', feed)
      child.stdin.on('error', () => {})
      child.on('error', (error) => { lastError = error.message; log.warn('协议桥起不来：', error.message) })
      child.on('exit', (code, signal) => {
        if (proc === child) { proc = null; ready = null }
        if (!stopping && !disposed) {
          log.warn(`协议桥退出了（${signal || code}），${Math.round(backoff / 1000)} 秒后重启`)
          scheduleRestart()
        }
      })
      // 等它打印 READY
      const t0 = Date.now()
      while (!ready && proc === child && Date.now() - t0 < READY_TIMEOUT) await new Promise((r) => setTimeout(r, 300))
      if (ready) return { ok: true, message: '协议桥起来了' }
      if (proc === child) {
        lastError = lastError || '等了很久没起来'
        try { child.kill() } catch (error) {}
      }
      return { ok: false, message: '协议桥没起来：' + (lastError || '进程退出了') }
    })().finally(() => { starting = null })
    return starting
  }

  async function stop({ hold = false } = {}) {
    if (hold) held = true
    stopping = true
    clearTimeout(restartTimer)
    const child = proc
    if (!child) return { ok: true, message: '协议桥没在跑' }
    try { child.stdin.end() } catch (error) {}
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { child.kill() } catch (error) {} resolve() }, 3000)
      child.once('exit', () => { clearTimeout(t); resolve() })
    })
    proc = null
    ready = null
    return { ok: true, message: '协议桥停了' }
  }

  return {
    detect,
    start,
    stop,
    async restart() { await stop(); return start() },
    running: () => Boolean(proc && ready),
    held: () => held,
    /** 给网关客户端的连接地址；桥没起来时地址为空（客户端会等着重连） */
    endpoint() {
      const t = cfg().accessToken || ''
      return ready
        ? { protocol: 'v12', httpUrl: ready.httpUrl, wsUrl: ready.wsUrl, httpToken: t, wsToken: t }
        : { protocol: 'v12', httpUrl: '', wsUrl: '', httpToken: '', wsToken: '' }
    },
    /** 连上的号对不对：没填机器人 ID 就用桥报上来的（顺手存进配置），填了就核对 */
    status() {
      return { ...detect(), running: Boolean(proc && ready), held, botUserId: ready?.botUserId || '', startedAt, lastError, pid: proc?.pid || 0 }
    },
    dispose() {
      disposed = true
      clearTimeout(restartTimer)
      if (proc) { try { proc.stdin.end() } catch (error) {} const p = proc; setTimeout(() => { try { p.kill() } catch (error) {} }, 3000).unref?.() }
    },
  }
}
