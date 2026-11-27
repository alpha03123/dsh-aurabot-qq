# LLM Wiki 记忆系统回放验收

对应计划：`LLM-WIKI-MEMORY-PLAN.md`。这是 E2E 验收，不是单元测试。**全程调用真实模型**，用的是线上同一个 provider 和模型，结果可以直接当作上线参考。

## 它验什么

| 部分 | 怎么验 | 模型 |
|---|---|---|
| Dreaming 长期运行 | 35 天模拟时间线（2026-12-01 ~ 2027-01-04，跨月、跨年），每晚按线上入口跑一次 Dreaming，逐晚检查 | 线上同一模型，走实现里的 `askModel` 原路径 |
| 语言层检索 | 回放结束后，用线上同一套系统提示和工具，按主人口吻提 15 个问题，每题默认 3 次 | 线上同一模型、同一 effort |
| 判定 | 能用字符串判的用字符串；语义类的交给评测模型 | `gpt-6-luna`（和被测模型不同，避免自己评自己） |
| 真实数据初版 | `--mode real` 用线上真实 chatlog 补跑出初版 Wiki，交给人看 | 线上同一模型 |

时间线里的对话按主人真实聊天的口吻手写（短句、「猫猫」、代词），不是模型生成的规整对话。设计意图写在 `timeline.mjs` 文件头。

## 运行

在 Windows 上、DSH 用的同一个环境里运行（需要能访问 `http://127.0.0.1:8080/v1`，并且有环境变量 `LOCAL_SUB2_API_KEY`）：

> 注意：`LOCAL_SUB2_API_KEY` 和启动 8788 时 DSH 用的是同一个 key。它不在用户或系统环境变量里，Host Control 的 PowerShell 默认也没有。运行前要在当前会话里先设好（`$env:LOCAL_SUB2_API_KEY = ...`，取值方式和启动 8788 时一样），不要把 key 写进仓库或日志。脚本开跑前会先预检，缺 key 或端点不通会直接报错。

```powershell
cd <repo>\dsh-aurabot-qq
node tools/wiki-acceptance/run.mjs --mode real      # 先跑：线上 5 天原话 → 初版 Wiki，人看一遍
node tools/wiki-acceptance/run.mjs --mode replay    # 再跑：35 晚回放 + 探针，出通过/不通过
```

常用参数：

- `--until 2026-12-14`：只回放到某天（调试用，不跑最终检查和探针）
- `--skip-probes`：只验 Dreaming
- `--probe-runs 5`：每题跑几次（默认 3）
- `--out <dir>`：输出目录（默认 `tools/wiki-acceptance/out/<mode>-<时间>`，已加入 .gitignore）
- `--source <dir>`：线上数据目录（默认 `%USERPROFILE%\.dsh\plugins-data\aurabot`）

可选环境变量：`REPLAY_BASE_URL`、`REPLAY_API_KEY_ENV`、`REPLAY_JUDGE_MODEL`、`REPLAY_JUDGE_EFFORT`、`REPLAY_CHAT_EFFORT`（默认取线上 `model.reasoningEffort`）、`REPLAY_SEND_TEMPERATURE=1`、`REPLAY_TIMEOUT_MS`。

**安全**：只读线上目录里的 `config.json`、`personas/`，real 模式再读 `chatlog/` 和 autonomy 的 `activity.jsonl`。所有写入都在输出目录的 `data/` 下（`AURABOT_DATA_DIR` 指过去）。不会打印 key。

**耗时和用量**：replay 大约 35 晚 × 每晚几次 Dreaming 调用，加上 15 题 × 3 次 × 1~4 轮，再加评测，总计约 300~400 次模型调用。按端点速度估算 30~90 分钟，建议放后台跑。

## 适配层契约（实现方填写 `adapter.mjs`）

`adapter.mjs` 只做接线，必须调用线上同一份代码，不能另写一套给验收用的逻辑。

| 方法 | 要求 |
|---|---|
| `nightly({ day, now })` | 睡后 Dreaming 的线上入口。从游标补跑到 `day`（含），返回 `{ ok, days, error? }`，`days` 是实际整理的日期，按顺序排列 |
| `state()` | 返回 `{ lastDreamedDay }` |
| `forget(keyword, { now })` | 和线上「忘掉 xxx」走同一条路径 |
| `wikiDir()` | memory-wiki 的绝对路径 |
| `activityFile()` | autonomy 的 `activity.jsonl` 路径 |
| `chatContext({ now })` | 主人私聊新一天第一句话时，线上给语言层的 `{ system, tools }` |
| `searchChatlog(query)` | 原话检索 |

`nightly` 的行为规则：

1. **游标为空**时，从 chatlog 最早一天开始补。
2. **没有聊天的日子**也算整理完，游标照样推进到 `day`。
3. **一晚是原子的**：遇到模型空返回、输出截断、解析失败或缩水拦截，整晚不落盘、游标不动，下一晚连同失败的那天一起补。不能把截断输出里能解析的部分先写进去，所以 Dreaming 的输出要有完整性校验，比如完整的 JSON。
4. **不能被峰谷省钱推迟**。回放的睡后时间是次日 01:30。

`chatContext` 的要求：

- `system` 要和线上组装一致：人格 + 规则 + 常驻页（主人、近期与约定、我、带概要的目录）+ handoff。
- `tools` 至少包含 `wiki_open` 和 `search_chatlog`，每个是 `{ name, description, parameters, execute }`。

`forget` 要清掉 Wiki（含 `.history/`），并让 chatlog 里相关原话标上 `forgottenAt`，之后 `search_chatlog` 搜不到。回放里 12-12 提到的名字，12-14 白天才被要求忘掉，而 12-12、12-13 两晚没跑 Dreaming，所以 12-14 当晚补跑时也不能把它写进去。

run.mjs 已经替你做好的：

- 隔离数据目录；
- 全局 `Date` 换成回放时钟，实现里直接用 `Date.now()` 即可；
- `dsh.llm.stream` 接到真实端点；
- 每天的 chatlog 和 activity 写好，格式和线上一致。

## 通过标准

**Dreaming（硬性，全部满足）**

| 检查 | 时间点 |
|---|---|
| 正常的晚上都成功，并把游标推进到当天 | 每晚 |
| `近期与约定` 没有只写相对时间（明天、周六、下周……）而不写日期的行 | 每晚 |
| 博物院改期后只留 12-06 的安排；去过后移出待办，并进入 `回忆/2026-12` | 12-03、12-07 |
| 体检换算成 12-16；做完后不再是待办 | 12-09、12-17 |
| 跨年烟花带日期记下，到 12-30 仍在热层（远期约定没被降温误删）；看完后移出待办，进入回忆 | 12-11 → 12-30 → 01-01 |
| 拿铁原地改成美式，没有新旧两条并存 | 12-18 |
| 芒果过敏、生日 3月14日 写进 `主人.md`，最后仍在 | 12-17、12-22、最终 |
| 两晚停跑后按顺序补跑 12-12、12-13、12-14 | 12-14 |
| 上游返回空或截断的那晚，页面不变、游标不动；次晚一起补 | 12-21/22、12-25/26 |
| 「忘掉」之后，Wiki（含 `.history`）和原话检索都查不到 | 12-14、最终 |
| 酸菜鱼琐事不在热层；吉他不再写成当前爱好 | 最终 |
| `回忆/2026-12` 跨月后仍保留博物院、烟花、围巾 | 最终 |
| 10 个只提过一次的细节，至少 8 个还能在 Wiki 里找到 | 最终 |
| `.history/` 里有修改前快照 | 最终 |

**Dreaming（只警告）**：常驻四页总字数超过 8000。

**语言层探针（硬性）**

| 指标 | 标准 |
|---|---|
| 编造次数（长尾、长期、陷阱、忘掉题合计） | 0 |
| 说出被要求忘掉的名字 | 0 次 |
| 陷阱题（红色发卡、看海） | 全部判 correct 或 dont_know |
| 长期事实题（芒果、咖啡、生日） | 正确率 ≥ 90% |
| 长尾题（药名、面馆、猫名、博物院日期、鞋码、农场名） | 正确率 ≥ 70% |
| 日常闲聊硬塞旧事 | 0 次 |
| 探针调用出错 | 0 次 |

**语言层探针（参考）**：日常闲聊调工具的比例超过 20% 只警告；长尾题主动调工具的比例只记录、不判。

## 输出

- `report.md`：结论和每一项检查、每晚的整理日期、游标、改动页、常驻字数、没答对的探针（附回答和评测理由）
- `report.json`：完整数据
- `nights/<日期>/`：每晚 Dreaming 后的页面快照。**这部分要人看**：逐晚对比，看有没有慢慢磨损、语气漂移、乱发挥
- `probes.jsonl`：每次探针的回答、工具调用、评测结果
- `run.log`：运行日志，含实现自己打的日志
- `data/`：隔离数据目录，含模型调用留底 `traces/`

## 和真实聊天验收的关系

回放和探针都通过，才进入上线。上线后还有一轮主人自己的真实聊天验收（见计划 Step 4）。模拟问法比真实聊天规整，模型会不会主动去查，最终以真实 trace 为准。
