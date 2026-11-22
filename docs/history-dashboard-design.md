# 历史导入 Dashboard：设计与接口契约

本文是「历史导入」面板的设计说明，前后端都以这里的契约为准。面板有两块：**任务进度**（看导入与离线初始化跑到哪了，并能开始、继续、停止初始化）和**梗与观察审核**（批量审核离线合成出的群梗与群观察）。

QCE 文件导入本身仍走命令行（文件要先放到服务器上），面板只展示它的结果。

## 1. 为什么审核需要后端配合

离线合成写入的群梗和群观察是 `core_facts` 里带 `history_key` 的行。只在界面上删改是不够的：

- 以后再跑 `history init`（`quick` 之后跑 `full`、升级后重新合成），同一个 `history_key` 会被重新写入，**删掉的会回来，手改的会被覆盖**。
- 审核过的条目需要一个状态，否则下次打开分不清哪些看过。

因此审核有三种结果，全部由后端保证在重跑后依然成立：

| 状态 | 含义 | 重跑时 |
|---|---|---|
| `pending` | 合成写入后尚未审核 | 可被更新 |
| `approved` | 已通过，或被人工编辑过 | 不再被离线合成覆盖 |
| `rejected` | 已拒绝 | 从 `core_facts` 移除并留下墓碑；同一 `history_key`、同一变体的梗、相近说法的观察都不会再写入 |

拒绝可以撤销：墓碑里保存被拒条目的完整快照，恢复时原样写回并标为 `approved`。

## 2. 数据层

- `core_facts.history_review TEXT`：`NULL` 为待审，`'approved'` 为已通过。只对 `history_key IS NOT NULL` 的行有意义。
- 新表 `history_fact_rejections(chat_id, history_key, category, content, fact_json, rejected_at, PRIMARY KEY(chat_id, history_key))`。`fact_json` 是被拒行的完整快照，用于恢复。
- 群梗事实的文本格式（`[群梗: …]；真实含义: …；来源背景: …；相关成员: …；使用边界: …；使用情况: …`）的拼装与解析收拢到一个模块，合成、接口、编辑都用它，界面不解析字符串。

写入规则（`commitHistoricalSynthesisUnit` 与合成前的去重检查共同遵守）：

1. 已有行 `history_review = 'approved'`：跳过，不覆盖。
2. `(chat_id, history_key)` 有墓碑：跳过。
3. 新群梗与**已拒绝**群梗共享任一归一化变体：跳过。
4. 新观察与**已拒绝**观察近似重复：跳过。
5. 通过 Dashboard 编辑带 `history_key` 的事实（包括旧的 `PUT /memory/fact/:id`）：自动标为 `approved`。

已拒绝的条目不进入合成 Prompt 的「已有记录」，只在代码层拦截。

## 3. 进程内运行器

Dashboard 可以直接开始或继续初始化，不必再敲命令。运行器在主进程内调用 `runHistoryInitializationWithMemory`，共用主进程的记忆库连接、限流器和配置：

- 全局同一时刻只跑一个初始化任务，避免和实时对话抢模型额度。
- 停止通过 `AbortSignal` 实现，任务落为 `paused`，可继续。
- 进度不另存，直接读 `history_jobs` / `history_units` / `history_leases`，所以命令行启动的任务在面板上同样可见。
- 私聊或敏感会话必须在请求里显式带 `allowPrivateLlm: true`，否则拒绝启动。
- 主进程重启会中断运行中的任务：库里状态仍是 `running` 但租约已过期，面板显示为「已中断」，可继续。

## 4. 接口契约

全部挂在现有 Dashboard 路由下（`/api/history/...`，沿用 token 鉴权）。条目一律用 `historyKey` 作为标识，它在事实行和墓碑之间保持不变。

### `GET /history/overview`

```jsonc
{
  "runner": { "running": { "chatId": "...", "mode": "quick", "startedAt": "ISO" } },   // 没有在跑时为 null
  "chats": [{
    "chatId": "onebot:group:1",
    "chatTitle": "群名",
    "isPrivateOrSensitive": false,
    "messages": { "imported": 2612, "eligible": 2612, "covered": 910, "earliest": "ISO", "latest": "ISO" },
    "topics": 54,
    "facts": {
      "meme":        { "pending": 12, "approved": 3, "rejected": 1 },
      "observation": { "pending": 8,  "approved": 0, "rejected": 0 }
    },
    "importJobs": [{ "jobId": "...", "status": "done", "updatedAt": "ISO", "inputKeyShort": "02b2752f" }],
    "initJob": {                       // 该会话最近一次初始化任务，没有则为 null
      "jobId": "...", "mode": "quick",
      "status": "running",             // running | paused | done | stale（库里是 running 但租约已失效）
      "updatedAt": "ISO",
      "error": null,                   // paused 时的错误信息
      "stages": {
        "cluster":    { "done": 7, "total": 12 },
        "synthesize": { "done": 0, "total": 0 },
        "embed":      { "done": 0, "total": 0 }
      },
      "resumable": false               // paused 或 stale
    }
  }]
}
```

出现在列表里的会话：有 `origin = 'qce'` 的消息、有历史任务、或有带 `history_key` 的事实，三者满足其一。

### 初始化控制

- `POST /history/init/estimate`，body `{ chatId, mode }` → `{ eligibleMessages, totalWindows, uncoveredWindows, selectedWindows, estimatedClusterCalls, estimatedSynthesisCalls, isPrivateOrSensitive }`。不调用模型，不写库。
- `POST /history/init/start`，body `{ chatId, mode: "quick" | "full", allowPrivateLlm?: boolean }`
  - `202 { ok: true }`：已在后台开始。最近一次任务是同模式的 `paused` / `stale` 时按续跑处理，否则开新任务（已完成的窗口和批次不会重做）。
  - `409 { error: "busy", running: { chatId, mode, startedAt } }`：已有任务在跑。
  - `400 { error: "private_consent_required" }`：私聊或敏感会话未带同意。
- `POST /history/init/stop`，body `{ chatId }` → `{ ok: boolean }`。

### 审核

- `GET /history/facts?chatId=&kind=meme|observation&status=pending|approved|rejected&q=&sort=recent|usage_desc|usage_asc&limit=&offset=`

```jsonc
{
  "total": 48,
  "counts": { "pending": 40, "approved": 6, "rejected": 2 },   // 当前 chatId + kind 下各状态数量
  "items": [{
    "historyKey": "hist_meme:…",
    "kind": "meme",
    "status": "pending",
    "content": "完整文本",
    "meme": {                           // kind 为 observation 时为 null
      "term": "A / B", "variants": ["A", "B"],
      "meaning": "…", "originContext": "…", "usageBoundaries": "…",
      "participants": [{ "userId": "onebot:1", "displayName": "本群显示名" }],
      "usage": { "messages": 7, "senders": 5 }      // 解析不到时为 null
    },
    "sourceTopicLabel": "话题名",
    "citedCount": 3,
    "observedAt": "ISO",
    "flags": ["short_term", "low_usage"]            // 供界面提示；见下
  }]
}
```

`flags`：`short_term` 表示所有变体都不超过 2 个字（按子串统计的次数容易虚高）；`low_usage` 表示使用情况刚好踩在准入线上（2 人且不超过 3 条消息）。`sort` 的 `usage_*` 只对群梗有意义，观察按 `recent` 处理。`limit` 上限 100。

- `GET /history/evidence?chatId=&historyKey=` → `{ topic: { id, label, summary } | null, messages: [{ messageId, userId, displayName, timestamp, text }], missing: 0 }`。`missing` 是引用了但已不存在或已被屏蔽的消息数。已拒绝的条目从墓碑快照取引用。
- `POST /history/facts/review`，body `{ chatId, action: "approve" | "reject" | "reset" | "restore", historyKeys: string[] }` → `{ ok: true, affected: n }`。一次最多 500 条，单事务。`reset` 把 `approved` 退回 `pending`；`restore` 只作用于已拒绝的条目。
- `PUT /history/facts`，body `{ chatId, historyKey, meme?: { term, meaning, originContext, usageBoundaries }, content?: string }` → `{ ok: true, item }`。群梗传 `meme`，观察传 `content`；后端重新拼装文本，保留「相关成员」和「使用情况」。保存即标为 `approved`。必填项为空返回 `400`。

所有写操作都校验目标行属于 `chatId` 且带 `history_key`，不会碰实时产生的事实。

## 5. 界面

顶部标签栏新增「历史导入」，面板内沿用「记忆查询」的左侧子导航样式，两个子页共用顶部的会话选择器（只列有历史数据的会话，默认选最近有活动的）。

### 任务进度

- **概览条**：导入消息数与时间范围、已聚类覆盖率（进度条）、话题数、待审群梗数、待审观察数。点「待审」数字跳到审核页并带上筛选。
- **初始化卡片**：三段进度条（聚类 / 合成 / 向量），各显示 `done / total`；状态徽章区分「运行中」「已暂停」「已中断」「已完成」「未开始」；暂停时显示错误信息原文。
- **操作**：`预估用量`（弹出窗口数与预计模型调用次数）、`快速初始化`、`补齐全部`、`继续`、`停止`。私聊或敏感会话在开始前要勾选「允许把这个会话的内容发送给模型」。有任务在跑时其余开始类按钮禁用，并说明是哪个会话在跑。
- **导入记录**：列出该会话的导入任务与状态；下方给出导入命令示例和复制按钮。
- **轮询**：仅当面板可见时请求 `overview`；有任务运行时 3 秒一次，否则 15 秒一次；同一时刻只允许一个未完成的请求，上一个没回来就跳过本次。

### 梗与观察审核

- **工具栏**：种类切换（群梗 / 群观察）、状态切换（待审核 / 已通过 / 已拒绝，各带数量）、搜索框、排序（最近 / 使用最多 / 使用最少）。
- **条目**：左侧复选框；群梗显示原词、`7 条 · 5 人` 的使用徽章、含义；带 `flags` 的条目加一个「留意」提示并说明原因。展开后显示来源、使用边界、相关成员和**引用的原始消息**（展开时才请求 `evidence`），让审核的人不用离开页面就能判断这条梗是不是真的。
- **单条操作**：通过、拒绝、编辑（群梗是四个字段的表单，观察是一个文本框）。已拒绝列表里是「恢复」。
- **批量操作**：全选本页、已选数量、批量通过、批量拒绝。操作后列表原地更新并刷新计数，不整页重载。
- **键盘**：`↑` `↓` 移动焦点，`A` 通过，`X` 拒绝，`空格` 勾选，`Enter` 展开。输入框聚焦时不响应。
- **空状态与错误**：没有历史数据时说明先用命令行导入并给出命令；请求失败在原位置显示错误和重试，不清空已有列表。
- 每页 30 条。

样式沿用现有面板：`card bg-base-100`、DaisyUI 的 `badge` / `btn-xs` / `progress`、Font Awesome 图标、中文文案。窄屏下子导航横排，条目操作收进一行图标。
