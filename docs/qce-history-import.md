# QCE 历史聊天记录导入与离线社会记忆初始化指南

本文档说明如何使用 `qq-chat-exporter` (QCE) 导出 QQ 历史聊天记录，通过 CyberGroupmate 的 `history import`（`pnpm qce-import`）CLI 工具导入历史消息，并在 **Dashboard「历史导入」面板**或通过 `history init`（`pnpm history-init`）CLI 工具完成离线社会记忆初始化与群梗/群观察审核。

## 目录

- [1. 概述与架构原则](#1-概述与架构原则)
- [2. 分步操作流程](#2-分步操作流程)
- [3. 使用 Dashboard「历史导入」面板](#3-使用-dashboard历史导入面板)
- [4. CLI 参数与退出码完整参考](#4-cli-参数与退出码完整参考)
- [5. OneBot 群名片、`@` 提及解析（Issue #81 修复）与 `person_chat_names` 联动](#5-onebot-群名片-提及解析issue-81-修复与-person_chat_names-联动)

---

## 1. 概述与架构原则

CyberGroupmate 的离线历史导入与初始化管线（`src/history/` 与 `src/memory-v2/history-store.ts`）专为「Bot 入群前或离线期间的大规模存量聊天记录」设计，遵循以下五项核心架构约束：

### 1.1 零实时唤醒与回填隔离（Zero Live Wake / Backfill Isolation）
- **纯存储层写入**：`history import` 与 `history init` 直接读写 SQLite（`message_log`、`person_identities`、`person_group_profiles`、`person_chat_names`、`topics`、`core_facts`），**绝不**向 `NotificationCenter` 推送 `nc.message` 事件。
- **不触发实时链路**：导入与离线初始化过程中不会唤醒 `AttentionAccumulator`、`TopicRegistry`、`RecordingPipeline`、`MainAgentLoop` 或 `SubagentManager`，也不会在群聊中触发任何对外回复。
- **来源标记与幂等升级**：QCE 导入的消息在 `message_log` 中标记为 `origin = 'qce'`，按 `(chat_id, message_id)` 主键幂等去重；若同一条消息后续又经由实时 OneBot 通道送达，系统仅将其 `origin` 原地升级为 `'live'`，不会重复累加发言计数或活跃时段统计。

### 1.2 新入群观察者护栏（Newcomer Guard）
- **固定观察者角色**：离线初始化将 Bot 视为刚入群的观察者，`group_models.agent_role` 在存储边界固定写入为 `"新入群观察者（正在熟悉群聊文化与成员）"`（仅在该字段为空或由离线种子写入时生效，不覆盖实时 Reflection 已生成的角色）。
- **禁止伪造亲密度与关系**：对于尚无实时互动证据（无 `interactions` 记录、无非 `offline_history` 的实时 `recent_episodes`、且当前 `affinity_score = 0` / `dunbar_tier = 4` / `relation_to_agent = ""`）的群成员，存储层强制保持：
  - `dunbar_tier = 4`
  - `affinity_score = 0`
  - `dunbar_reason = ""`
  - `relation_to_agent = ""`
- **双重拦截**：除系统提示词约束外，合成阶段（`src/history/initialize.ts`）通过正则与存储边界校验，直接丢弃任何声称「与 AI/Bot 很熟、是好友/死党」或试图输出 `relationToAgent` / `dunbarTier` / `affinityScore` 的条目。

### 1.3 玩梗/反讽与真实个人事实严格分离（Banter / Meme vs. Biographical Fact Separation）
- **群梗与黑话归入 `anecdote`**：群友之间的调侃、反讽、起外号、玩梗（如互称「现充/闲虫」、调侃「你是猫？」等）在离线合成中只能进入 `memes`，落库为 `core_facts` 表中 `category = 'anecdote'`、`subject = 'group:<chatId>'` 的群级事实，且必须同时包含**真实语境含义**（`meaning`）与**使用边界**（`usageBoundaries`）。
- **群聊观察归入 `general`**：有明确消息证据支撑的群内日常互动习惯落库为 `category = 'general'`、`subject = 'group:<chatId>'`。
- **存储边界拒绝个人履历事实**：`commitHistoricalSynthesisUnit` 在数据库事务边界强制校验历史事实白名单——仅允许 `category IN ('anecdote', 'general')` 且 `subject === 'group:<chatId>'`，**严禁**在离线历史初始化阶段生成任何 `biographical`（个人履历）事实，防止将群内玩笑或未经核实的调侃固化为成员真实身份档案。
- **转发消息正文剥离**：聚类与合成前通过 `stripForwardedBodyText()` 自动剥离合并转发消息（`[转发聊天记录: ...]` / `[转发消息: ...]`）的内部正文，防止将外部转发内容错误归因给当前群成员。

### 1.4 严格的同会话检索隔离（Strict Same-Chat Retrieval Isolation）
- **群内名称隔离**：QCE 导入的群名片（`groupCard`）、群内发言昵称与 `@` 提及显示名仅写入按 `chat_id` 作用域隔离的 `person_chat_names` 表；群聊导入**不会**修改全局 `person_identities.display_name`（仅私聊导入可补充全局显示名），彻底避免某人在 A 群的群名片泄漏到 B 群。
- **事实可见性隔离**：离线合成生成的群梗与群观察默认标记为 `visibility = 'contextual'` 且绑定 `source_chat_id = <chatId>`；若目标会话为私聊（`isDirectMessage`）或敏感会话（`markedSensitive` / `config.privacy.sensitiveChats`），则强制标记为 `visibility = 'private'`，跨群检索时自动按可见性策略过滤。

### 1.5 `liveOnly` 保护实时 Reflection 游标（Live Reflection Cursor Protection）
- **不触碰 `last_reflected_at`**：离线合成仅通过 `history_seed_fields` 表按 `(chat_id, entity_kind, entity_id, field)` 记录 `rank_key` 与 `value_hash`，绝不修改 `group_models.last_reflected_at`。
- **`liveOnly` 话题过滤**：实时 Reflection 引擎（`runReflection`）在拉取待反思话题时调用 `memory.getTopicsSince(chatId, since, { liveOnly: true })`，仅读取 `history_key IS NULL` 的实时话题。离线生成的历史话题（带有 `history_key = 'hist_topic:...'`）不会挤占实时 Reflection 窗口，也不会推进或污染实时反思水位线。
- **保护实时与人工编辑**：若某个群画像字段或成员画像字段已被实时 Reflection 更新或被管理员在 Dashboard 中手动修改（当前值哈希与 `history_seed_fields.value_hash` 不一致），后续重跑或续传离线初始化时会自动跳过该字段，绝不回滚实时数据。

---

## 2. 分步操作流程

### 步骤一：在 Windows PC 上使用 `qq-chat-exporter` (QCE) 导出

1. **推荐导出格式**：
   - **Chunked JSONL（推荐用于大群/长历史）**：导出目录包含 `manifest.json`（其中 `chunked.format === "jsonl"`）以及分块目录（如 `chunks/chunk_0001.jsonl` 等）。
   - **Single JSON（适合中小型会话）**：单个 `.json` 文件，根对象包含 `metadata`（可选）、`chatInfo` 与 `messages` 数组。
2. **为什么拒绝 HTML / TXT / Excel / `manifest.js` 格式**：
   - 导入器显式拒绝 `.html` / `.htm`、`.txt`、`.xlsx` / `.xls`、`.csv`、`.zip`、`.js` 以及 QCE Modern HTML Chunked 导出（含 `manifest.js` 或 `data/manifest.js`），并以退出码 `2` 报错。
   - 原因：HTML/TXT/Excel 会丢失结构化字段（如 64 位原始 `messageId`、精确的 `sender.uid`/`sender.uin`、引用回复 `referencedMessageId`、结构化 `@` 提及数组等），而 `manifest.js` 是仅供浏览器前端渲染的 JS 包装格式，不适合作为无损数据导入源。
3. **无需拷贝数 GB 的原始图片/视频文件**：
   - 将导出数据上传至运行 CyberGroupmate 的主机时，**只需拷贝 `.json` 单文件，或 `manifest.json` + `chunks/*.jsonl`**。
   - **不需要**拷贝庞大的 `resources/` 原始媒体文件夹。导入器只会从 JSON 结构中提取轻量级安全元数据（文件名 basename、文件大小、宽高、时长）并在消息文本中生成语义占位符（如 `[📷 图片]`、`[🎭 表情包]`、`[🎬 视频]`、`[🎵 语音]`、`[📎 文件: xxx]`、`[🔗 卡片: xxx]`、`[转发聊天记录: N条]`），流式解析时还会自动丢弃内联 `avatarBase64` / `dataUrl` 以控制内存与数据库体积。
4. **会话 ID 自动识别（`peerUin` / `peerUid`）**：
   - 导入器优先读取 QCE v6.4.3 的 `chatInfo.peerUin` / `chatInfo.peerUid`（向下兼容旧版 `uin` / `uid`）：
     - `chatInfo.type === "group"` → `onebot:group:<群号>`
     - `chatInfo.type === "private"` 或 `"temp"` → `onebot:private:<QQ号或UID>`
   - 若私聊导出的 `chatInfo` 中仅有 NTQQ 内部 `peerUid`（如 `u_xxx`）而无十进制 QQ 号，导入总结中会标记 `isOpaquePeerChat: true` 并给出警告，此时可通过 `--chat-id onebot:private:<QQ号>` 显式指定目标 `chatId`。

---

### 步骤二：Dry-Run 预检与原始消息导入（`qce-import`）

在正式写入数据库前，建议先执行 `--dry-run` 进行流式预检（不创建或修改任何目标 SQLite 表）：

```bash
# 1. Dry-run 预检（支持传入单 JSON 文件、Chunked JSONL 导出目录、或 manifest.json 路径）
pnpm qce-import /path/to/qce-export --dry-run
```

检查输出的 JSON 摘要：
- `chatId` / `chatTitle` / `isDirectMessage` / `isOpaquePeerChat`：确认目标会话 ID 是否符合预期。
- `uidResolution`：查看 `totalDistinctUids`、`resolvedUids`、`unresolvedUids` 与 `unresolvedExamples`。
- `eligibleMessages` / `inserted` / `duplicates` / `conflicts`：评估实际将被写入的消息数量与去重情况。
- `warnings` 与 `malformedLineCount`：确认是否存在未解析的 UID 或损坏的 JSONL 行。

确认无误后执行正式导入：

```bash
# 2. 正式导入到默认数据库 workspace/memory.db
pnpm qce-import /path/to/qce-export \
  --self-id 123456789 \
  --timezone Asia/Shanghai
```

#### 常用导入选项说明
- `--self-id <QQ号或compositeId>`：指定 Bot 自己的 QQ 号（如 `123456789` 或 `onebot:123456789`）。指定后，Bot 自己发送的历史消息会记录到 `message_log`，但 `countAsHuman = false`，不会计入人类群友活跃时段与发言总数，且能正确标记 `@` 提及中的 `isSelf: true`。
- `--user-map <FILE>`：当部分早期 NTQQ 消息仅有 `uid`（如 `"u_abc123"`）而缺失 `uin`（十进制 QQ 号），或同一 `uid` 在导出中出现冲突 `uin` 时，可提供一个 JSON 映射文件（格式为 `{"u_abc123": "10001", "u_def456": "10002"}`），将 `onebot:uid:...` 统一归并到真实的 `onebot:<QQ号>`。
- `--resume`：大文件导入中途若被 `SIGINT`/`SIGTERM` 中断，作业状态会保存在 `history_jobs` 表中（状态为 `paused`）。使用**相同参数**加上 `--resume` 即可从上次提交的 `(lastTimestampMs, lastSourceOrdinal)` 检查点继续导入。若参数（如 `--chat-id`、`--user-map`、`--since` 等）发生变化，会有指纹校验阻止错误续传。
- `--since <TIME>` / `--until <TIME>`：按左闭右开区间 `[since, until)` 过滤消息时间（支持 ISO-8601 时间戳或相对于 `--timezone` 的本地日期时间字符串，如 `2025-01-01` 或 `2025-01-01T00:00:00+08:00`）。
- `--timezone <IANA>`：用于解析无时区时间字符串（`timeStr` / `--since` / `--until`）及计算活跃小时分布（`stats_hour` / `peak_hours`）的 IANA 时区（默认优先读取 `config.yaml` 中的 `timezone`，再回退系统时区或 `UTC`）。活跃小时在**首次导入时写定**，重复导入不会修正；输出摘要的 `timezone` 字段显示实际采用的时区，回退到 `UTC` 时 `warnings` 会给出提示，请先用 `--dry-run` 确认。
- `--include-system` / `--include-recalled`：默认跳过系统提示消息与已撤回消息。开启 `--include-recalled` 时，为保护隐私，撤回消息的原始正文在进入临时缓存库（spool）前即被剥离，仅以 `"[已撤回消息]"` 占位写入且不计入人类发言统计。系统提示（戳一戳、精华消息等）的文本由导出者的 QQ 客户端渲染，可能包含导出者给好友设置的私人备注，开启 `--include-system` 前请留意。

消息文本按 `content.elements` 逐段重建，不沿用 QCE 的 `content.text`：`[图片:<md5>.png]`、`[回复消息]`、`[JSON消息]` 等导出专用标记不会入库，图片与表情包（`subType: "sticker"`）分别记为 `[📷 图片]` / `[🎭 表情包]`，回复关系只保存在 `reply_to_message_id`。遇到无法识别的元素类型时才保留 QCE 原文。合并转发内的发言人统一显示为 `成员A` / `成员B`：QCE 按导出者视角给这些人取名，好友备注（常为真实姓名）与公开昵称无法区分。导出者给好友设的备注（`sender.remark`）只在导入时用来识别并剔除被它顶替的 `sender.name`，不会写入数据库。

---

### 步骤三：离线社会记忆初始化（Dashboard「历史导入」面板或 `history-init`）

消息导入 `message_log` 后，需要执行离线话题聚类（Stage 1: `cluster`）、社会记忆合成（Stage 2: `synthesize`）与可选的向量补写（Stage 3: `embed`）。

- **方式一（推荐日常使用）**：若 Bot 主进程已启动，可直接打开 **Dashboard → 历史导入** 面板，在网页上预估模型调用量、启动/继续/停止「快速初始化」或「补齐全部」，并在合成后批量审核群梗与群观察。详见[第 3 节：使用 Dashboard「历史导入」面板](#3-使用-dashboard历史导入面板)。
- **方式二（CLI 命令行）**：使用 `pnpm history-init` 在命令行执行，支持自定义窗口切分阈值、`--max-windows` 分批限流、`--profile` 指定模型配置，或将导入与初始化合并为一条命令执行。

无论使用面板还是 CLI，都推荐采用**渐进式工作流**：先用 `quick` 模式低成本建立近期与高密度的群聊认知，审核并验证效果后再决定是否跑全量 `full`。

#### 1. 预检调用计划（`--mode quick --dry-run`）

```bash
pnpm history-init \
  --chat-id onebot:group:123456 \
  --mode quick \
  --dry-run
```

`--dry-run` 不会调用任何 LLM API，也不会写入数据库，而是直接输出窗口切分与调用次数估算：
- `totalWindows` / `uncoveredWindows` / `selectedWindows`
- `estimatedClusterCalls`（每个聚类窗口预计 2 次调用：话题切分 + 话题摘要）
- `estimatedSynthesisCalls`（按 UTC ISO 周聚合、每批最多 8 个话题的合成调用数）

> 提示：你也可以在 `history-init` 中直接通过 `--input /path/to/qce-export` 将「导入 + 初始化」合并到一条命令中执行（当 `--stage` 为 `all` 或 `import` 时生效）。

#### 2. 执行快速初始化（`--mode quick`）

```bash
pnpm history-init \
  --chat-id onebot:group:123456 \
  --mode quick
```

- **`quick` vs `full` 窗口选择逻辑**（`src/history/windows.ts`）：
  - 系统先将未覆盖的人类有效消息按静默间隔（默认 `--gap-minutes 30`）、最大时间跨度（默认 `--window-hours 4`）与最大消息数（默认 `--window-messages 120`）切分为时间窗口，再把不足 `--min-window-messages`（默认 10）条的零散窗口并入时间上更近的相邻窗口（合并后不超过最大消息数），避免几条深夜消息单独占用一组模型调用。
  - **`quick` 模式**（默认）：若未覆盖窗口总数 `<= 6` 则全部选中；若 `> 6`，则取**时间最新的 Top 6 窗口**与**消息数最多的 Top 6 窗口**去重合并（最多 12 个窗口），按时间正序执行聚类与合成。
  - **`full` 模式**：选中所有未覆盖的历史消息窗口。

#### 3. 在 Dashboard 或 CLI 中检查与审核初始化结果

`quick` 模式完成后，可通过以下方式检查与审核生成的记忆质量：
- 打开 **Dashboard → 历史导入** 面板：在「任务进度」子页查看已聚类覆盖率与各阶段进度；在「梗与观察审核」子页对照引用的原始消息，批量通过、编辑或拒绝离线合成出的群梗与群观察（详见[第 3 节](#3-使用-dashboard历史导入面板)）。
- 打开 **Dashboard → 记忆查询** 面板：在「群组画像」「群内画像」等子页查看该群的 `GroupModel`（群描述、沟通规范、常聊话题、禁忌话题）以及群内成员画像（`traits`、`interests`、`communicationStyle`、`recentEpisodes`）。
- 或使用 CLI 查看统计与检索测试：
  ```bash
  pnpm cli memory status
  pnpm cli memory recall "群梗"
  ```

#### 4. 可选：全量回填、分批限流与阶段控制

如果希望继续处理剩余历史窗口，可切换到 `--mode full`，并结合以下参数精细控制成本与进度：

```bash
# 分批处理：每次最多新处理 10 个逻辑单元（窗口/周批次），配合 --resume 随时续跑
pnpm history-init \
  --chat-id onebot:group:123456 \
  --mode full \
  --max-windows 10 \
  --profile cheap_model \
  --embed
```

- `--stage <import|cluster|synthesize|all>`：
  - `import`：仅执行 QCE 导入（需提供 `--input`）。
  - `cluster`：仅对未覆盖窗口执行离线话题聚类与话题摘要生成，写入 `topics` 与 `history_cluster_coverage`。
  - `synthesize`：仅基于已落库的历史话题（`history_key IS NOT NULL`）按周批次合成群文化、成员画像与群梗。
  - `all`（默认）：依次执行（若提供了 `--input` 则先导入，再聚类、再合成）。
- `--max-windows <N>`：限制本次运行在每个阶段（`cluster` / `synthesize` / `embed`）最多新处理的逻辑单元数。若有剩余未完成单元，作业状态会标记为 `paused` 并在返回 JSON 中报告 `remainingClusterUnits` / `remainingSynthesisUnits`，下次带上 `--resume` 即可继续推进。
- `--profile <NAME>`：显式指定 `config.yaml` 的 `llmProfiles` 中的某个 profile 名称。若指定的 profile 不存在，CLI 会**立即报错退出（退出码 `2`）**，绝不静默回退到其他高价模型。未指定 `--profile` 时，聚类使用 `recording_cluster` 路由，摘要使用 `recording_triage` 路由，合成使用 `reflection` 路由。
- `--embed`：在聚类与合成完成后，为尚未生成向量的历史 `topics` 与历史 `core_facts` 调用 Embedding API 补写向量（并同步写入 `topics_vec` / `facts_vec`）。若 `config.yaml` 中 `embedding.enabled: true`，则默认也会执行该阶段。
- `--allow-private-llm`：**私聊与敏感会话隐私保护开关**。当目标会话是私聊（如 `onebot:private:*`、`group_models.is_direct_message = 1`）或被标记为敏感会话（`marked_sensitive = 1` 或在 `config.privacy.sensitiveChats` 中）时，`history-init` 默认拒绝将历史消息发送给外部 LLM 或 Embedding API。只有显式传入 `--allow-private-llm` 时才允许执行 `cluster` / `synthesize` / `embed`。

---

### 步骤四：在 Docker 容器内运行

Docker 镜像（参见 `Dockerfile`）的工作目录为 `/app`，内置了编译好的依赖与 `/app/node_modules/.bin/tsx`，且默认 `ENTRYPOINT` 为 `["npx", "tsx", "src/main.ts"]`。

在容器环境中运行历史导入或初始化时，**请直接调用 `/app/node_modules/.bin/tsx /app/src/cli.ts history ...`**（无需联网下载包，且与 CI 冒烟测试 `.github/workflows/ghcr-publish.yml` 完全一致）。

#### 方式 A：在已运行的 `cybergroupmate` 容器内执行（`docker exec`）

假设宿主机已将 `./workspace` 挂载到容器的 `/app/workspace`，可将 QCE 导出目录放到宿主机的 `./workspace/qce-export`，然后执行：

```bash
# 1. Dry-run 预检
docker exec -it cybergroupmate \
  /app/node_modules/.bin/tsx /app/src/cli.ts history import \
  /app/workspace/qce-export \
  --db /app/workspace/memory.db \
  --dry-run

# 2. 正式导入历史消息
docker exec -it cybergroupmate \
  /app/node_modules/.bin/tsx /app/src/cli.ts history import \
  /app/workspace/qce-export \
  --db /app/workspace/memory.db \
  --self-id 123456789

# 3. 执行 quick 模式离线社会记忆初始化
docker exec -it cybergroupmate \
  /app/node_modules/.bin/tsx /app/src/cli.ts history init \
  --chat-id onebot:group:123456 \
  --db /app/workspace/memory.db \
  --mode quick
```

> 注意：数据库内置了基于 `history_leases` 表的同会话并发租约锁（默认 TTL 60 秒并自动心跳续期），防止针对同一个 `chatId` 并发运行多个历史导入或初始化任务。

#### 方式 B：启动一次性临时容器执行（`docker run --rm`）

如果主容器尚未启动，可以通过覆盖 `--entrypoint` 挂载宿主机导出目录、`workspace` 和 `config.yaml` 运行一次性导入任务：

> 镜像必须包含本功能：把 `<owner>` 换成构建了这些提交的仓库（例如你自己的 fork 合入 `agentic` 后由 Actions 构建的镜像）。`--self-id` 填机器人账号的 QQ 号，不是导出者本人的。

```bash
docker run --rm \
  --entrypoint /app/node_modules/.bin/tsx \
  -v "$(pwd)/workspace:/app/workspace" \
  -v "$(pwd)/config.yaml:/app/config.yaml:ro" \
  -v "/path/to/host/qce-export:/data/qce-export:ro" \
  ghcr.io/<owner>/cybergroupmate:agentic \
  /app/src/cli.ts history init \
  --input /data/qce-export \
  --db /app/workspace/memory.db \
  --self-id 123456789 \
  --mode quick
```

---

## 3. 使用 Dashboard「历史导入」面板

完成 `qce-import` 消息导入后，可以在 Dashboard 顶部导航栏打开 **「历史导入」** 面板（位于「记忆查询」右侧）。

面板顶部是两个子页共用的**会话选择器**，只列出已有 QCE 导入消息（`origin = 'qce'`）、历史任务记录（`history_jobs`）、带 `history_key` 的历史事实或拒绝墓碑（`history_fact_rejections`）的会话；首次打开时优先选中正在运行初始化的会话，否则选中最近有活动的会话。左侧子导航分为 **「任务进度」** 与 **「梗与观察审核」** 两个子页（当该会话存在待审核条目时，「梗与观察审核」旁会显示待审总数徽章）。面板仅在当前标签页可见时自动轮询（有任务运行时每 3 秒刷新一次，空闲时每 15 秒刷新一次）。

### 3.1 任务进度

「任务进度」子页用于查看导入与离线初始化的整体进度，并直接在主进程后台启动、继续或停止初始化任务。

1. **顶部概览条**：
   - **导入消息**：显示 `origin = 'qce'` 的已导入消息总数，以及下方可用于离线聚类的有效人类消息数（`可用 N 条`）与最早/最新消息日期范围。
   - **已聚类覆盖率**：进度条与百分比，表示已写入 `history_cluster_coverage` 的消息数占可用消息数的比例（`covered / eligible`）。
   - **话题数**：该会话已生成的历史话题总数（`topics` 表中 `history_key IS NOT NULL` 的记录数）。
   - **待审群梗 / 待审观察**：分别展示待审核的群梗与群观察条数，下方附带 `通过 N · 拒绝 M` 统计；点击这两张卡片会直接跳转到「梗与观察审核」子页并自动切到对应种类与「待审核」筛选。
2. **离线初始化卡片与三段进度条**：
   - **三段进度条**：依次展示 **聚类**（`cluster`）、**合成**（`synthesize`）、**向量**（`embed`）三个阶段的已完成单元数 / 总单元数（`done / total`，直接读取 `history_units` 表，命令行启动的任务同样可见）。
   - **五种状态徽章**：
     - `运行中`：进程内运行器或命令行正在执行该会话的初始化任务。
     - `已暂停`：任务被手动停止、达到分批上限或因异常暂停；卡片内会展示暂停原因或错误信息原文，可点「继续」接着跑。
     - `已中断`：数据库中任务状态仍为 `running`，但 `history_leases` 租约已过期（通常因为主进程重启或外部 CLI 进程被强制终止）；已完成的部分不会重做，点「继续」即可。
     - `已完成`：最近一次初始化任务的全部阶段单元均已完成。
     - `未开始`：该会话尚未运行过离线初始化。
3. **操作按钮与运行约束**：
   - **预估用量**：弹窗并列对比「快速初始化」与「补齐全部」的可用消息、窗口总数、未覆盖窗口、本次处理窗口、预计聚类调用、预计合成调用及预计调用合计（纯只读计算，不调用模型、不写数据库）。
   - **快速初始化**：以 `quick` 模式在主进程后台启动初始化，处理最新和最密的少量未覆盖窗口（最多 12 个窗口）。
   - **补齐全部**：以 `full` 模式在主进程后台启动初始化，处理所有未覆盖窗口。
   - **继续**：当最近一次任务处于 `已暂停` 或 `已中断` 时可用，按上次的模式（`quick` 或 `full`）继续推进。若最近一次任务是默认参数的同模式 `已暂停` / `已中断` 任务，直接点击同模式的「快速初始化」或「补齐全部」也会自动按续跑处理；即便开启新任务，已完成聚类的窗口与已完成合成的周批次也不会重复执行。
   - **停止**：通过 `AbortSignal` 请求停止当前由面板启动的运行中任务，当前步骤结束后任务落为 `已暂停`，之后可点「继续」恢复。（若任务是由命令行在外部进程启动且仍在运行，面板会显示进度但无法停止它，需等待其结束或在终端中断。）
   - **单任务并发限制**：Bot 主进程内同一时刻**全局只运行一个初始化任务**，避免与实时对话争抢模型额度。当任意会话有任务在跑时，其他会话的开始/继续按钮均会禁用，并提示当前正在运行的会话名称与一键切换按钮。
   - **私聊与敏感会话同意勾选**：若当前会话是私聊或被标记为敏感会话（顶部带有「私聊/敏感」徽章），开始或继续前必须先勾选 **「允许把这个会话的内容发送给模型」**（对应请求参数 `allowPrivateLlm: true`）；切换会话时该勾选会自动清空。
4. **导入记录与命令示例**：
   - 底部列出该会话的 `qce_import` 导入任务记录（输入指纹短码、状态与更新时间）。
   - **QCE 文件导入本身仍在命令行完成**（需先把导出文件放到服务器上执行 `pnpm qce-import`），卡片下方提供带当前会话 `chatId` 的导入与初始化命令示例及一键复制按钮。

### 3.2 梗与观察审核

「梗与观察审核」子页用于批量审查离线合成写入 `core_facts` 的**群梗**（`category = 'anecdote'`）与**群观察**（`category = 'general'`）。

1. **三种审核状态与重跑保护**：
   | 状态 | 存储表示 | 含义与后续重跑（`history init`）时的行为 |
   |------|----------|------------------------------------------|
   | **待审核**（`pending`） | `core_facts` 中 `history_review IS NULL` | 离线合成刚写入、尚未人工确认的条目；后续重跑离线合成时，同一 `history_key` 仍可被更新。 |
   | **已通过**（`approved`） | `core_facts` 中 `history_review = 'approved'` | 人工点击「通过」或编辑保存后的条目；后续重跑离线合成时**直接跳过，不再被离线合成覆盖**。在「已通过」列表中可点击「退回待审」将其退回 `pending`。 |
   | **已拒绝**（`rejected`） | 从 `core_facts` 移除，写入 `history_fact_rejections` 墓碑表 | 已从 `core_facts`（含全文索引 `core_facts_fts` 与向量表 `facts_vec`）中移除，并在 `history_fact_rejections` 中保存完整快照（`fact_json`）。后续重跑离线合成时，**同一 `history_key`、共享任一归一化变体的群梗、或说法近似重复的群观察都不会再被写入**。在「已拒绝」列表中点击「恢复」可从快照原样写回 `core_facts` 并自动标为 `已通过`。 |
2. **「留意」提示（`flags`）及其触发条件**：
   - 当某条群梗触发以下任一条件时，标题旁会显示黄色 **「留意」** 徽章并在条目下方面板列出原因：
     - **短词提示（`short_term`）**：该群梗的所有说法（变体）长度都不超过 2 个字。由于历史使用次数按字面子串统计，短词的匹配次数可能偏高，建议展开对照原始消息确认。
     - **低频踩线提示（`low_usage`）**：该群梗在历史记录中的使用情况刚好踩在准入线上（`senders <= 2` 且 `messages <= 3`，即不超过 2 人、不超过 3 条消息）。
3. **展开详情与查看引用的原始消息**：
   - 每条群梗默认展示原词、`N 条 · M 人` 的历史使用徽章、真实含义摘要、来源话题名、引用消息条数与观测时间；群观察展示观察正文与引用信息。
   - 点击条目右侧展开箭头（或按 `Enter`）后，群梗会展示完整的**来源背景**、**使用边界**、**各种说法**、**相关成员**（自动解析为该成员在本群的显示名）与**来源话题**，并按需请求加载该条目**引用的原始消息**（显示发言人本群显示名、时间戳与消息文本；若存在已被删除或被访问控制屏蔽的消息，会提示缺失条数；「已拒绝」列表中的条目同样会从墓碑快照加载引用消息）。
4. **单条编辑**：
   - 在「待审核」或「已通过」列表中点击 **「编辑」** 会打开内联编辑表单（并自动展开引用消息方便对照）：
     - **群梗**：提供 **原词**（多个说法用 ` / ` 隔开）、**真实含义**、**来源背景**、**使用边界** 四个字段（其中原词、真实含义、使用边界不能为空；保存时后端会重新拼装标准群梗格式，自动保留原有的「相关成员」和「使用情况」）。
     - **群观察**：提供 **观察内容** 文本框（不能为空）。
   - 点击 **「保存并通过」**（或在表单内按 `Ctrl+Enter` / `Cmd+Enter` 保存，按 `Esc` 取消）后，修改立即落库并自动标为 **已通过**（若处于「待审核」列表，保存后会自动移入「已通过」；若文本内容发生变化，旧向量会被清空）。
5. **筛选、排序与批量操作**：
   - 顶部工具栏支持切换种类（`群梗` / `群观察`）、切换状态（`待审核` / `已通过` / `已拒绝`，各带当前种类下的实时条数）、搜索框（搜索原词、含义、观察内容或来源话题名）与排序（`最近` / `使用最多` / `使用最少`，其中按使用次数排序仅对群梗生效）。列表每页展示 30 条。
   - 列表上方常驻批量操作栏：支持勾选 **「全选本页」**，并根据当前所处状态提供 **批量通过 / 批量拒绝**（待审核）、**批量退回待审 / 批量拒绝**（已通过）或 **批量恢复**（已拒绝）。执行后列表原地更新并刷新各状态计数。
6. **键盘快捷键**：
   - 在「梗与观察审核」子页中（当焦点不在输入框、下拉框、文本域内且无打开的弹窗时）：
     - `↑` / `↓`：在当前页条目之间上下移动焦点
     - `A`：对当前焦点条目执行 **通过**（在「待审核」列表）或 **恢复**（在「已拒绝」列表）
     - `X`：对当前焦点条目执行 **拒绝**（在「待审核」或「已通过」列表）
     - `空格`：勾选或取消勾选当前焦点条目
     - `Enter`：展开或收起当前焦点条目的详情与引用原始消息
   - 若当前焦点条目正处于内联编辑状态，按 `A` / `X` 不会触发通过或拒绝，避免丢失未保存的编辑内容；在编辑表单内可使用 `Ctrl+Enter`（macOS 为 `Cmd+Enter`）保存、`Esc` 取消。

> **重要注意：不要在「记忆查询 → 核心事实」中直接删除历史事实**
>
> 在旧的 **「记忆查询 → 核心事实」** 页面中：
> - **编辑**一条带 `history_key` 的历史事实（`PUT /memory/fact/:id` → `updateFact`）也会自动将其 `history_review` 设为 `'approved'`，后续重跑离线初始化时不会被覆盖。
> - 但点击**删除**（`DELETE /memory/fact/:id` → `deleteFact`）只是直接从 `core_facts` 表删除该行，**不会**在 `history_fact_rejections` 中写入拒绝墓碑。一旦后续重跑 `history init`，被删掉的群梗或群观察仍会被重新合成并写回数据库。
>
> 因此，需要剔除离线合成的群梗或群观察时，请务必在 **「历史导入 → 梗与观察审核」** 页面中使用 **「拒绝」**。

---

## 4. CLI 参数与退出码完整参考

以下选项、默认值与退出码严格对应 `src/history/cli.ts` 实现。

### 4.1 `history import`（别名：`pnpm qce-import`）

用法：
```text
npx tsx src/cli.ts history import <file|directory|manifest.json> [options]
```

| 选项 | 参数类型 | 默认值 | 说明 |
|------|----------|--------|------|
| `<file\|directory\|manifest.json>` | 位置参数（必填） | — | QCE 单 `.json` 文件路径、包含 `manifest.json` 的分块 JSONL 目录、或 `manifest.json` 文件路径 |
| `--db` | `PATH` | `workspace/memory.db` | SQLite 数据库路径 |
| `--chat-id` | `ID` | 自动从 `chatInfo` 推导 | 覆盖目标复合 `chatId`（必须以 `onebot:group:` 或 `onebot:private:` 开头，且与 `chatInfo.type` 一致） |
| `--self-id` | `ID` | 未设置 | Bot 自己的 QQ 号或复合 `userId`（用于区分人类群友与 Bot 自身的发言统计及 `@` `isSelf` 标记） |
| `--user-map` | `FILE` | 未设置 | `UID -> UIN` 映射 JSON 文件路径（将 NTQQ UID 映射为正整数十进制 QQ 号） |
| `--include-system` | 布尔标志 | `false`（默认跳过） | 包含系统提示消息（以 `userId: "system"`、`countAsHuman: false` 落库） |
| `--include-recalled` | 布尔标志 | `false`（默认跳过） | 包含已撤回消息（正文脱敏为 `"[已撤回消息]"`，`countAsHuman: false`） |
| `--timezone` | `IANA` | `config.timezone` → 全局时区 → `UTC` | 用于解析无时区时间字符串与计算按小时活跃度的 IANA 时区（如 `Asia/Shanghai`） |
| `--since` | `TIME` | 未设置 | 仅导入此时间之后（含，`>=`）的消息（开启时间范围过滤时自动跳过 `timeUnknown` 消息） |
| `--until` | `TIME` | 未设置 | 仅导入此时间之前（不含，`<`）的消息 |
| `--dry-run` | 布尔标志 | `false` | 仅流式统计与评估，不写入目标数据库 |
| `--resume` | 布尔标志 | `false` | 从上次中断的 `qce_import` 检查点游标续传（要求选项指纹完全一致） |
| `-h`, `--help` | 布尔标志 | — | 显示 `history import` 帮助信息并退出 |

### 4.2 `history init`（别名：`pnpm history-init`）

用法：
```text
npx tsx src/cli.ts history init [options]
```

> 约束：`--stage import` 必须提供 `--input <path>`；`--stage cluster` 或 `--stage synthesize` 必须提供 `--chat-id <id>`；一般调用至少需要提供 `--chat-id <id>` 或 `--input <path>` 之一。

| 选项 | 参数类型 | 默认值 | 说明 |
|------|----------|--------|------|
| `--input` | `PATH` | 未设置 | 可选 QCE 导出路径（在 `--stage` 为 `import` 或 `all` 时先执行 QCE 导入） |
| `--chat-id` | `ID` | 若传了 `--input` 可自动推导 | 目标复合 `chatId`（如 `onebot:group:123456`） |
| `--db` | `PATH` | `workspace/memory.db` | SQLite 数据库路径 |
| `--stage` | `STAGE` | `all` | 执行阶段：`import` \| `cluster` \| `synthesize` \| `all` |
| `--mode` | `MODE` | `quick` | 窗口选择模式：`quick`（最新 6 + 最密 6 去重，最多 12 个未覆盖窗口）\| `full`（全部未覆盖窗口） |
| `--window-messages` | `N`（正整数） | `120` | 单个聚类窗口的最大消息条数 |
| `--window-hours` | `N`（正数） | `4` | 单个聚类窗口的最大时间跨度（小时） |
| `--gap-minutes` | `N`（正数） | `30` | 切分相邻窗口的静默间隔阈值（分钟） |
| `--min-window-messages` | `N`（非负整数） | `10` | 少于 N 条的窗口并入更近的相邻窗口；`0` 关闭合并 |
| `--since` | `TIME` | 未设置 | 仅处理此时间之后（含，`>=`）的消息与完整落在范围内的历史话题 |
| `--until` | `TIME` | 未设置 | 仅处理此时间之前（不含，`<`）的消息与完整落在范围内的历史话题 |
| `--max-windows` | `N`（正整数） | 无限制 | 本次运行在每个阶段（`cluster` / `synthesize` / `embed`）最多新处理的逻辑单元数 |
| `--profile` | `NAME` | 按组件路由配置 | 显式指定 `config.llmProfiles` 中的 LLM profile（不存在时直接报错退出，不静默回退） |
| `--embed` | 布尔标志 | `false`（或跟随 `config.embedding.enabled`） | 为已提交的历史话题与历史事实补写向量 embedding |
| `--allow-private-llm` | 布尔标志 | `false` | 显式允许将私聊或敏感群的历史消息发送到外部 LLM / Embedding API |
| `--dry-run` | 布尔标志 | `false` | 仅计算窗口切分与调用计划，零 LLM 调用、零数据库写入 |
| `--resume` | 布尔标志 | `false` | 从上次中断的 `initialize` 检查点续传（支持 `quick` 完成后升级为 `full` 续跑） |
| `--self-id` | `ID` | 未设置 | 透传给内嵌 QCE 导入阶段的 `--self-id` |
| `--user-map` | `FILE` | 未设置 | 透传给内嵌 QCE 导入阶段的 `--user-map` |
| `--timezone` | `IANA` | `config.timezone` → 全局时区 → `UTC` | 用于窗口边界解析及内嵌 QCE 导入的 IANA 时区 |
| `--include-system` | 布尔标志 | `false` | 透传给内嵌 QCE 导入阶段的 `--include-system` |
| `--include-recalled` | 布尔标志 | `false` | 透传给内嵌 QCE 导入阶段的 `--include-recalled` |
| `-h`, `--help` | 布尔标志 | — | 显示 `history init` 帮助信息并退出 |

### 4.3 退出码（Exit Codes）

| 退出码 | 触发场景 | 说明 |
|--------|----------|------|
| `0` | 执行成功或打印 `--help` | 命令正常完成，标准输出打印格式化的 JSON 摘要（`QceImportSummary` 或 `HistoryInitSummary`） |
| `1` | 运行时错误 | 数据库连接/锁冲突（`HistoryLeaseError`）、私聊未传 `--allow-private-llm`、LLM 鉴权/配额致命错误、`--resume` 检查点不匹配或文件 I/O 异常 |
| `2` | 参数用法或导出格式错误 | `CliUsageError` / `HistoryUsageError`（缺少必填参数、非法标志、无效日期范围、不存在的 `--profile`）或 `HistoryUnsupportedFormatError`（传入 `.html`/`.txt`/`.xlsx`/`.csv`/`.zip`/`manifest.js` 等不支持格式） |
| `130` | 信号中断（`SIGINT` / `SIGTERM`） | 用户按下 `Ctrl+C` 或进程收到终止信号；当前进行中的作业会自动将状态更新为 `paused` 并安全释放租约，后续可通过 `--resume` 续传 |

---

## 5. OneBot 群名片、`@` 提及解析（Issue #81 修复）与 `person_chat_names` 联动

在 QQ 群聊场景中，同一个用户在不同群往往设置不同的「群名片」（`card` / `groupCard`），且群友在对话或 `@` 时普遍使用本群名片而非全局 QQ 昵称。围绕这一特性，实时 OneBot 适配器与离线 QCE 导入共享同一套基于 `person_chat_names` 的群级名称索引机制：

1. **实时 OneBot 群名片缓存与 `@` 提及解析（Issue #81 修复，`src/adapter/onebot-adapter.ts`）**：
   - `OneBotAdapter` 维护了按群隔离的成员名称缓存 `groupMemberNameCache`（`groupId -> (userId -> displayName)`）以及防并发竞态的版本号 `groupMemberVersion`。
   - 收到群消息时，优先按 `pickOneBotGroupDisplayName(sender.card, sender.nickname)` 提取发言者在本群的显示名并更新该群缓存；当收到 `group_card` / `group_card_change` 通知事件时实时更新或清理缓存。
   - 解析群消息中的 `[CQ:at,qq=...]` 提及段时，`fetchMentionDisplayName(userId, groupId)` 先查本群 `groupMemberNameCache`，未命中时调用 `get_group_member_info` 获取被提及者在本群的群名片/群昵称，并将其标记为可信群内来源 `nameSource: "chat"`；仅在群成员接口失败时才回退到账号级昵称并标记为 `nameSource: "account_fallback"`（`account_fallback` 不会被写入 `person_chat_names`，防止跨群昵称污染）。
2. **QCE 历史导入的名称提取（`src/history/qce-normalize.ts` & `src/memory-v2/chat-names.ts`）**：
   - QCE 导入每条有效人类群消息时，会自动收集该消息在当前 `chatId` 下的名称观测记录并批量写入 `person_chat_names` 表：
     - `sender_card`（权重 6）：来自 `sender.groupCard` / `sender.card`
     - `sender_display`（权重 5）：消息最终采用的群内显示名
     - `sender_nickname`（权重 4）：来自 `sender.nickname` / `sender.nick`
     - `sender_name`（权重 3）：来自 `sender.name`（自动剔除与导出者私人好友备注 `sender.remark` 相同的名称，防止导出者私人备注泄漏到群公共记忆）
     - `mention_display`（权重 1）：来自消息内 `@` 提及携带的群名片或昵称（标记 `nameSource: "qce"`）
3. **`memory.resolvePerson` 与 `memory.getPersonDossier` 的群内精准检索（`src/meta-sandbox/meta-api/memory.ts`）**：
   - 当 Agent 在沙盒中调用 `memory.resolvePerson(query, { chatId })`、`memory.getPersonDossier(query, { chatId })` 或 `memory.searchEntities(query, { chatId })` 时，检索器会优先查询目标 `chatId` 的 `person_chat_names` 表。
   - 匹配排序综合考虑匹配精度（`exact` > `prefix` > `substring`）、名称类型权重（`sender_card` > `sender_display` > `sender_nickname` > `sender_name` > `self_claim` > `mention_display`）以及最近观测时间（`observed_at`）。
   - 因此，导入 QCE 历史记录后，即使某位老群友在 Bot 正式上线后尚未发过言，Agent 依然能直接通过他在历史记录中用过的群名片、旧昵称或被 `@` 时的称呼，在当前群内精准解析出对应的 `onebot:<QQ号>`。
