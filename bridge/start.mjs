// Aurabot 内嵌的 Discord ↔ OneBot v12 协议桥。
//
// 由 Aurabot（src/bridge/manager.js）以子进程拉起，一个 bot 一个进程，配置全走环境变量：
//   DISCORD_TOKEN          机器人 token（必填）
//   BRIDGE_PORT            监听端口（只听 127.0.0.1）
//   BRIDGE_ACCESS_TOKEN    OneBot 访问令牌（HTTP / WS 都要带）
//   BRIDGE_DATA_DIR        onebots 数据目录（ID 映射表、审计日志）
//   DISCORD_PROXY_URL      连 Discord 走的代理，可空
//   FFMPEG_PATH            转语音消息用的 ffmpeg，可空（找 PATH）
// 启动好后打印一行：AURABOT_BRIDGE_READY {"botUserId","httpUrl","wsUrl"}
//
// 在 onebots + Discord 适配器之上补的东西：
//   · 发图 / 发语音时补文件名（不然 Discord 上显示成 attachment.bin）
//   · 单独一段语音按 Discord 语音消息发（ogg/opus + 时长 + 波形，flags=8192），失败退回附件
//   · 私聊的历史记录、取单条消息：先换成私信频道 ID
//   · 频道信息、成员信息、成员列表：直接查 Discord API（适配器没实现）
//   · set_input_status → 「正在输入」
//   · v12 事件补上发送者的名字（协议层默认丢了）

import { mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BaseApp, listenHttpServer, resolveListenPort } from "@onebots/core";
import { DiscordAdapter } from "@onebots/adapter-discord";
import { OneBotV12Protocol } from "@onebots/protocol-onebot-v12";
import { OneBotV12ActionService } from "@onebots/protocol-onebot-v12/lib/actions.js";

const env = (k, d = "") => String(process.env[k] ?? d).trim();
const TOKEN = env("DISCORD_TOKEN");
if (!TOKEN) {
  console.error("AURABOT_BRIDGE_ERROR 没有 DISCORD_TOKEN");
  process.exit(2);
}
const PORT = Number(env("BRIDGE_PORT", "3102")) || 3102;
const ACCESS_TOKEN = env("BRIDGE_ACCESS_TOKEN");
const DATA_DIR = env("BRIDGE_DATA_DIR") || path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const PROXY_URL = env("DISCORD_PROXY_URL");
mkdirSync(DATA_DIR, { recursive: true });

/** 机器人 ID 就写在 token 的第一段里（base64） */
function botIdOf(t) {
  const id = Buffer.from(t.split(".")[0], "base64").toString("utf8").trim();
  if (!/^\d{15,22}$/.test(id)) throw new Error("token 格式不对，认不出机器人 ID");
  return id;
}
const BOT_ID = botIdOf(TOKEN);

// ── 媒体文件名 ───────────────────────────────────────────────
function sniff(buf, segType) {
  const ascii = (a, b) => buf.subarray(a, b).toString("ascii");
  if (buf.length >= 8 && buf[0] === 0x89 && ascii(1, 4) === "PNG") return { ext: "png", mime: "image/png" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length >= 6 && ascii(0, 3) === "GIF") return { ext: "gif", mime: "image/gif" };
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { ext: "wav", mime: "audio/wav" };
  if (buf.length >= 4 && ascii(0, 4) === "OggS") return { ext: "ogg", mime: "audio/ogg" };
  if ((buf.length >= 3 && ascii(0, 3) === "ID3") || (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { ext: "mp3", mime: "audio/mpeg" };
  if (buf.length >= 12 && ascii(4, 8) === "ftyp") return { ext: "mp4", mime: "video/mp4" };
  if (segType === "record" || segType === "audio" || segType === "voice") return { ext: "mp3", mime: "audio/mpeg" };
  if (segType === "image") return { ext: "png", mime: "image/png" };
  if (segType === "video") return { ext: "mp4", mime: "video/mp4" };
  return { ext: "bin", mime: "application/octet-stream" };
}
const DATA_URL_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "video/mp4": "mp4" };

function withFilenames(message) {
  if (!Array.isArray(message)) return message;
  return message.map((seg) => {
    if (!seg || typeof seg !== "object" || !seg.data) return seg;
    if (!["image", "record", "audio", "voice", "video", "file"].includes(seg.type)) return seg;
    if (seg.data.filename || seg.data.name) return seg;
    const raw = seg.data.url ?? seg.data.file ?? seg.data.src;
    if (typeof raw !== "string") return seg;
    const prefix = ["record", "audio", "voice"].includes(seg.type) ? "voice" : seg.type;
    if (raw.startsWith("base64://")) {
      const head = Buffer.from(raw.slice(9, 9 + 64).replace(/\s/g, ""), "base64");
      const { ext, mime } = sniff(head, seg.type);
      return { ...seg, data: { ...seg.data, filename: `${prefix}.${ext}`, content_type: seg.data.content_type || mime } };
    }
    const m = raw.match(/^data:([^;]+);base64,/);
    if (m && DATA_URL_EXT[m[1]]) return { ...seg, data: { ...seg.data, filename: `${prefix}.${DATA_URL_EXT[m[1]]}` } };
    return seg;
  });
}

/** 引用回复：原消息不存在时别让 Discord 整条拒收 */
const softReplies = (message) => (Array.isArray(message) ? message.map((seg) => (seg && seg.type === "reply" && seg.data ? { ...seg, data: { ...seg.data, fail_if_not_exists: false } } : seg)) : message);

// ── 私信频道 ─────────────────────────────────────────────────
const dmChannels = new Map();
async function dmChannelOf(adapter, uin, userId) {
  if (dmChannels.has(userId)) return dmChannels.get(userId);
  const dm = await adapter.requireBot(uin).getREST().request("/users/@me/channels", { method: "POST", body: { recipient_id: userId } });
  if (dm?.id) dmChannels.set(userId, dm.id);
  return dm?.id || "";
}
/** scene → Discord 频道 ID：私聊先换成私信频道 */
async function channelOf(adapter, uin, sceneType, sceneId) {
  const id = adapter.coerceId(sceneId).string;
  return sceneType === "private" ? dmChannelOf(adapter, uin, id) : id;
}

// ── Discord 语音消息 ─────────────────────────────────────────
const FFMPEG = [env("FFMPEG_PATH"), "E:\\filediver-cli\\ffmpeg.exe"].find((p) => p && existsSync(p)) || "ffmpeg";
function ffmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], { windowsHide: true });
    const out = [];
    let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 200)}`))));
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}
async function audioBytes(data) {
  const raw = String(data.file ?? data.url ?? data.src ?? "");
  if (raw.startsWith("base64://")) return Buffer.from(raw.slice(9), "base64");
  const m = raw.match(/^data:[^;]+;base64,(.*)$/s);
  if (m) return Buffer.from(m[1], "base64");
  if (/^https?:\/\//i.test(raw)) return Buffer.from(await (await fetch(raw, { signal: AbortSignal.timeout(20000) })).arrayBuffer());
  return readFileSync(raw.startsWith("file://") ? fileURLToPath(raw) : raw);
}
/** ogg/opus、时长（秒）、波形（每 100ms 一个 0~255 字节，最多 256 个，base64） */
async function voiceMessageOf(input) {
  const ogg = await ffmpeg(["-i", "pipe:0", "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "48k", "-f", "ogg", "pipe:1"], input);
  const pcm = await ffmpeg(["-i", "pipe:0", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"], input);
  const samples = Math.floor(pcm.length / 2);
  const seconds = samples / 8000;
  const n = Math.max(1, Math.min(256, Math.ceil(seconds * 10)));
  const per = Math.max(1, Math.floor(samples / n));
  const peaks = [];
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (let j = i * per; j < Math.min(samples, (i + 1) * per); j++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(j * 2)));
    peaks.push(peak);
  }
  const top = Math.max(1, ...peaks);
  return { ogg, seconds: Math.max(0.1, Math.round(seconds * 100) / 100), waveform: Buffer.from(peaks.map((v) => Math.round((v / top) * 255))).toString("base64") };
}
async function sendVoiceMessage(adapter, uin, params, seg) {
  const rest = adapter.requireBot(uin).getREST();
  const channelId = await channelOf(adapter, uin, params.scene_type, params.scene_id);
  if (!channelId) throw new Error("找不到要发语音的频道");
  const { ogg, seconds, waveform } = await voiceMessageOf(await audioBytes(seg.data || {}));
  const boundary = `voice-${Date.now().toString(36)}`;
  const payload = { flags: 8192, attachments: [{ id: 0, filename: "voice-message.ogg", duration_secs: seconds, waveform }] };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="voice-message.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`),
    ogg,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${rest.token}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.id) throw new Error(`Discord 拒收语音消息 ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return { message_id: adapter.createId(j.id) };
}

// ── 适配器补丁 ───────────────────────────────────────────────
const origSend = DiscordAdapter.prototype.sendMessage;
DiscordAdapter.prototype.sendMessage = async function (uin, params) {
  const message = softReplies(withFilenames(params.message));
  const next = { ...params, message };
  // 单独一段语音（Aurabot 的语音条本来就单独发）：按 Discord 语音消息发
  if (Array.isArray(message) && message.length === 1 && ["record", "voice", "audio"].includes(message[0]?.type)) {
    try {
      return await sendVoiceMessage(this, uin, next, message[0]);
    } catch (error) {
      console.warn(`[voice] 按语音消息发失败，改按附件发：${error.message}`);
    }
  }
  return origSend.call(this, uin, next);
};

const origHistory = DiscordAdapter.prototype.getMessageHistory;
DiscordAdapter.prototype.getMessageHistory = async function (uin, params) {
  if (params?.scene_type !== "private") return origHistory.call(this, uin, params);
  const channelId = await channelOf(this, uin, "private", params.scene_id);
  const messages = await this.requireBot(uin).getMessageHistory(channelId, params.limit || 50);
  return [...messages.values()].map((msg) => this.convertMessageToInfo(msg));
};

const origGetMessage = DiscordAdapter.prototype.getMessage;
DiscordAdapter.prototype.getMessage = async function (uin, params) {
  if (params?.scene_type !== "private") return origGetMessage.call(this, uin, params);
  const channelId = await channelOf(this, uin, "private", params.scene_id);
  const msg = await this.requireBot(uin).getMessage(channelId, this.coerceId(params.message_id).string);
  return this.convertMessageToInfo(msg);
};

/** 频道所在的服务器（查成员要用），缓存一下 */
const guildOfChannel = new Map();
async function guildOf(adapter, uin, channelId) {
  if (guildOfChannel.has(channelId)) return guildOfChannel.get(channelId);
  const ch = await adapter.requireBot(uin).getREST().request(`/channels/${channelId}`);
  const g = ch?.guild_id || "";
  guildOfChannel.set(channelId, g);
  return g;
}
const memberName = (m) => m?.nick || m?.user?.global_name || m?.user?.username || "";

DiscordAdapter.prototype.getGroupInfo = async function (uin, params) {
  const channelId = params.group_id.string;
  try {
    const ch = await this.requireBot(uin).getREST().request(`/channels/${channelId}`);
    return { group_id: params.group_id, group_name: ch?.name || `频道 ${channelId}` };
  } catch {
    return { group_id: params.group_id, group_name: `频道 ${channelId}` };
  }
};
DiscordAdapter.prototype.getGroupMemberInfo = async function (uin, params) {
  const channelId = params.group_id.string;
  const userId = params.user_id.string;
  const rest = this.requireBot(uin).getREST();
  try {
    const guild = await guildOf(this, uin, channelId);
    const m = guild ? await rest.request(`/guilds/${guild}/members/${userId}`) : null;
    if (m) return { group_id: params.group_id, user_id: params.user_id, user_name: memberName(m) || userId };
  } catch {}
  try {
    const u = await rest.request(`/users/${userId}`);
    return { group_id: params.group_id, user_id: params.user_id, user_name: u?.global_name || u?.username || userId };
  } catch {
    return { group_id: params.group_id, user_id: params.user_id, user_name: userId };
  }
};
DiscordAdapter.prototype.getGroupMemberList = async function (uin, params) {
  const channelId = params.group_id.string;
  const guild = await guildOf(this, uin, channelId);
  if (!guild) return [];
  // 需要机器人开着 Server Members Intent；一次最多 1000 人，够用了
  const list = await this.requireBot(uin).getREST().request(`/guilds/${guild}/members`, { query: { limit: 1000 } });
  return (Array.isArray(list) ? list : []).filter((m) => m?.user?.id).map((m) => ({ group_id: params.group_id, user_id: this.createId(m.user.id), user_name: memberName(m) }));
};

// set_input_status → 「正在输入」；set_self_nickname → 同步各服务器昵称；其他照常
const origExecute = OneBotV12ActionService.prototype.execute;
OneBotV12ActionService.prototype.execute = async function (action, params = {}) {
  if (action === "set_input_status") {
    const { adapter, accountId } = this.context;
    const channelId = params.group_id
      ? adapter.coerceId(String(params.group_id)).string
      : await dmChannelOf(adapter, accountId, adapter.coerceId(String(params.user_id)).string);
    if (channelId) await adapter.requireBot(accountId).getREST().request(`/channels/${channelId}/typing`, { method: "POST" });
    return {};
  }
  if (action === "set_self_nickname") {
    const { adapter, accountId } = this.context;
    const rest = adapter.requireBot(accountId).getREST();
    const nick = String(params.nickname || "").trim().slice(0, 32);
    if (!nick) return { ok: false };
    // 走代理时偶尔 TLS 握手断掉（DISCORD_REST_NETWORK_ERROR）：每个请求最多试 3 次
    const retry = async (fn) => {
      for (let i = 0; ; i++) {
        try { return await fn(); } catch (error) { if (i >= 2) throw error; await new Promise((r) => setTimeout(r, 2000)); }
      }
    };
    const guilds = await retry(() => rest.request("/users/@me/guilds"));
    const list = Array.isArray(guilds) ? guilds : [];
    for (const g of list) {
      if (!g?.id) continue;
      try {
        await retry(() => rest.request(`/guilds/${g.id}/members/@me`, { method: "PATCH", body: { nick } }));
      } catch {}
    }
    return { ok: true, count: list.length };
  }
  return origExecute.call(this, action, params);
};

// v12 事件补上发送者名字（协议层只给 user_id）
const origToV12 = OneBotV12Protocol.prototype.convertToV12Format;
OneBotV12Protocol.prototype.convertToV12Format = function (event) {
  const out = origToV12.call(this, event);
  if (out && out.type === "message" && event.sender) {
    const name = event.sender.name || event.sender.nickname || "";
    if (name) out.user_name = name;
    if (event.sender.card) out.user_displayname = event.sender.card;
  }
  return out;
};

// ── 启动 ─────────────────────────────────────────────────────
BaseApp.configDir = DATA_DIR;
class BridgeApp extends BaseApp {
  async listenHttpServer(signal) {
    await listenHttpServer(this.httpServer, { port: resolveListenPort(this.config.port, process.env.PORT), host: "127.0.0.1" }, signal);
  }
}
const v12 = { use_http: true, use_ws: true, heartbeat_interval: 15000, ...(ACCESS_TOKEN ? { access_token: ACCESS_TOKEN } : {}) };
const app = new BridgeApp({
  port: PORT,
  log_level: "info",
  general: { "onebot.v12": v12 },
  [`discord.${BOT_ID}`]: {
    account_id: BOT_ID,
    token: TOKEN,
    receive_mode: "gateway",
    ...(PROXY_URL ? { proxy: { url: PROXY_URL } } : {}),
    intents: ["Guilds", "GuildMembers", "GuildMessages", "GuildMessageReactions", "DirectMessages", "DirectMessageReactions", "MessageContent"],
    "onebot.v12": v12,
  },
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    try { await app.stop(); } finally { process.exit(0); }
  });
}
// Aurabot 关掉时会断开 stdin：跟着退出，别留孤儿进程
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();

await app.start();
const base = `127.0.0.1:${PORT}/discord/${BOT_ID}/onebot/v12`;
console.log(`AURABOT_BRIDGE_READY ${JSON.stringify({ botUserId: BOT_ID, httpUrl: `http://${base}`, wsUrl: `ws://${base}` })}`);
