# Aurabot 统一记忆架构（单核心模块版）

所有记忆能力统一收敛在主仓库 `dsh-aurabot-qq` 的核心 `memory` 模块（`src/modules/memory/index.js` + `src/features/memory.js` + `memory-store.js` + `memory-vector.js` + `memory-wiki.js`）内，移除了主库内部重叠的三层旧摘要（`gists`、`compressDetails`、`shortTerm`）以及 `mods` 中与主库冲突的冗余记忆模块（`history-vault`、`local-diary`、`little-notes`）。

---

## 一、单一真相源的四层闭环

| 层级 | 存储与位置 | 职责 |
|---|---|---|
| **L0 永久原话正本** | `chatlog/YYYY-MM-DD.jsonl`（`hub.js`，默认 `keepChatlogDays: -1` 永久保留） | 单一原话底座，不双写、不默认过期删除；支持按日期/关键词带前后上下文检索（`search_chatlog`）及按指针回溯 |
| **L1 结构化记忆库** | `memory.sqlite`（`items` / `profiles` / `relations` / `insights` / `styles`） | 后台模型提炼原子事实并自动锚定 `sourceRef`（`{ chatId, day, t, lineIndex, quote }`）；支持中文 BM25 + 可选向量 + RRF + 遗忘曲线 + 双时态 + 多群执行层硬隐私隔离 |
| **L2 第一人称认识页** | `memory-wiki/`（`我.md` + `认识/*.md`） | 仅主人私聊可见的第一人称主题理解页（替代原有干瘪的 `compressDetails`），支持 `[[互链]]`、`#memoryId` 锚点与 `wikiGaps()` 缺口检测 |
| **L3 工作记忆 & 睡后 Dreaming** | `contextFor` + `recallHint` + `sessionRollover`（由 `autonomy` 睡后触发） | 常驻稳定层（≤900 字，含主人认识页目录）+ 每轮轻量自动召回 + 睡后完整 Dreaming 闭环：`consolidate` → `auditMemories`（对照 L0 原话纠错/作废玩笑）→ 主人 `wiki.refresh` → 中文交接归档 |

---

## 二、收敛后的工具分工

- `remember`：聊天中主动记一件事（自动挂 `sourceRef`）
- `recall_memory`：按语义/关键词深挖结构化事实
- `memory_tree`：浏览可见记忆目录（先看编号与短标题）
- `read_memory`：展开记忆全文；传 `withContext: true` 直接顺着 `sourceRef` 拉出 L0 当时原话前后文
- `search_chatlog`：直接按日期或关键词翻当前聊天的永久原话（自动带前后上下文，严格遵守隐私隔离）
- `lookup_person` / `chat_impression`：查人物印象与群印象
- `wiki_open` / `wiki_write`（仅主人私聊）：读写第一人称认识页
- `my_diary`（`autonomy` 内置）：唯一一本只给自己看的私密日记

---

## 三、统一忘记（Forget）

私聊触发 `忘掉 ...` 时，在主模块内一次同步撤回 `items`、`relations`、`insights`、`styles`、`profiles` 与 `chatlog`（`hub.forgetChatLog`），不再存在多库残留。
