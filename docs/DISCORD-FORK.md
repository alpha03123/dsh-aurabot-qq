# Aurabot Discord fork：改造方案

仓库：`alpha03123/dsh-aurabot-qq`（主程序，MIT）、`alpha03123/dsh-aurabot-qq-mods`（模块，CC BY-NC-SA 4.0，个人非商用、保留署名、改动沿用同协议）。
定位：只给 Discord 用，经 onebots 协议桥接入；QQ 专属代码直接删，不保留兼容。
起点：上游 v1.2.1（现在线上跑的版本）＋我们已有的本地改动（reply/hold 钩子、bili duty 修正、autonomy 0.7、browser-ops 无头模式、bot-peers）。之后不再跟上游合并，只按需挑修复。

## 现状里已经坏掉的（调查结论）

- @ 和引用：发出去的 @ 变成乱码，带引用的消息被 Discord 整条拒收；收到的 @、引用读错字段，被 @ 了也不知道。
- QQ 表情发出去是乱码；收文件全失败（读错文件名字段）；桥的报错全显示成 -1。
- 超过 2000 字的回复会被 Discord 拒发（没有分段）。
- 星璃 / 汐 在好几处被当成「大肥鱼」：主动搭话素材、记忆提取的自我过滤、默认唤醒词、写死的兴趣（白米饭、鲸鱼、女仆）。
- 模型每轮被告知「你现在在 QQ 上」，教她用 QQ 号 @、QQ 小黄脸、戳一戳，还禁止 Markdown。
- QQ 专属功能还在定时空跑：QQ 空间日记（每天 2 次先花一次模型调用再失败）、空间互动（每 30 分钟报错）、表情收藏同步。36 个 `qq_*` 工具里大半在 Discord 上用不了，还在占提示词、诱导她说「弄好了」。
- 三套作息互相打架：autonomy 7–24、speakUp 8–23（bili、空间互动、purpose 还在读它）、群聊 quietHours 1–8。
- `asleep()` 跟「忙时晚点回」开关绑在一起：关掉晚回，机器人同伴就以为她醒着。
- 绕过「每天主动找主人 ≤3 次」额度的路：bili 自己的 autoBrowse 每天最多再跑 3 轮并分享、定时提醒半夜也照发、speakup 兜底、cabinworld 报告。
- autonomy 的记忆提示直接读 `memories.json`，换成 SQLite 存储后这个文件不存在，提示一直是空的。

## 阶段

### 0. 基线（先做）
- `yozi` 分支：v1.2.1 + 现在线上的代码原样提交；模块仓库同理（autonomy / browser-ops / bot-peers）。
- 部署：在 `~/dev/aurabot-fork` 改，脚本同步到 E: 上 DSH 读的目录（沿用现在的 junction），DSH 热加载。

### 1. 立刻见效的修复（还在 v11 上，风险低）
- 桥报错读 `msg`；收到的 at / reply / 文件按桥的真实字段读；回复按 2000 字分段。
- Discord 上关掉并隐藏 QQ 专属：空间日记、空间互动、表情收藏同步、改资料、qq_api、加好友处理、QQ 卡片。
- 作息统一：核心加一个 `isAwake()`，优先问 autonomy，bili / 空间 / purpose / host 都改用它；群聊 quietHours 跟随。
- autonomy：`asleep()` 不再依赖晚回开关；删掉 speakup 兜底；睡着时的定时提醒等醒了再说；记忆提示改走 memory 接口。
- bili：关 autoBrowse / 自动分享 / 截图，分享改由 autonomy 排进安排、走额度。

### 2. 去掉硬编码
- 人设名一律读当前人设：purpose、记忆自我过滤、唤醒词、兴趣、泄密过滤。默认人设不再是大肥鱼。
- 提示词的平台规则重写成 Discord 版：允许 Markdown、`<at:用户ID>`、Unicode / 服务器表情、表情回应。
- 配置改名并自动迁移：`ownerQQ → ownerId`、`botQQ → selfId`、`audienceQQs → audienceIds` 等；记忆里的 `qq / about_qq` 迁移成 `uid / about_uid`；`qq_*` 工具改成中性名字。
- 所有 ID 一律当字符串：去掉 24 处 `Number(id)`、10 处「5~12 位数字」正则，设置向导接受 Discord ID。
- 删掉 NapCat / SnowLuma 网关和 Windows 专用的启动管理。

### 3. OneBot v12 + 内嵌协议桥
- 网关层改 v12：ID 用真实 Discord ID（字符串），支持「服务器 + 频道」两层，多 bot 共用一条连接。
- fork 依赖里锁定 `onebots` + v12 协议 + Discord 适配器；Aurabot 启动时以子进程拉起桥（崩了自动重启），Discord token 在面板里填，桥加访问令牌。
- 现在 `start.mjs` 里的补丁（群查询转 Discord 频道 / 用户）挪进 fork。
- 数据迁移：按桥的映射表，把记忆、会话、主人 ID 里的假数字号换成真实 Discord ID。

### 4. Discord 等价功能（都走桥已开放的接口）
- QQ 空间 → 见下方「待定」。
- 点赞 / 戳一戳 → 表情回应；别人对她的消息点表情 = 戳她。
- QQ 签名 / 状态 → Discord 自定义状态，可以直接显示她此刻在做什么（「在星巴克」「睡着了」）。
- 群名片 → 服务器昵称；群头衔 / 管理员 → 服务器角色。
- 表情：名字 → Unicode 表情表 + 服务器自定义表情；表情包收藏只存本地，可发服务器贴纸。
- 正在输入 → Discord typing；发文件 → 文件消息。

### 5. 模块统一
- autonomy 对外提供：`asleep()`、`busy()`、`awakeWindow()`、`canReachOwner()/spend()`（全模块共用主动找主人额度）、`note()`（别的模块通过它记生活事件）。
- 记忆的「你最近做过的事」不再重复 autonomy 管的那部分；心情「超开心多说话」在精力低时让位。

## 已定（2026-11-18）
1. QQ 空间 → 私密日记照旧 + 另开一个公开「动态」频道，偶尔发短动态，别人回复她会回。
2. cabinworld 从 fork 里删掉。
3. Discord 自定义状态跟着 autonomy 显示她此刻在做什么。
4. 按 0→5 的顺序做，每步上线验证再继续。
