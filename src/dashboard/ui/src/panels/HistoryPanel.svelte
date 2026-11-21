<script>
  import { onMount, onDestroy } from "svelte";
  import {
    activeTab,
    activeHistoryTab,
    selectedHistoryChatId,
    selectedHistoryChat,
    historyOverview,
  } from "../lib/stores.js";
  import { refreshHistoryOverview, chatLabel, initStatusKey, initStatusMeta } from "../lib/history.js";
  import TasksTab from "./history/TasksTab.svelte";
  import ReviewTab from "./history/ReviewTab.svelte";
  import ImportCommand from "./history/ImportCommand.svelte";

  const subTabs = [
    { id: "h-tasks", label: "任务进度", icon: "fa-bars-progress" },
    { id: "h-review", label: "梗与观察审核", icon: "fa-clipboard-check" },
  ];

  const FAST_MS = 3000;
  const SLOW_MS = 15000;

  let mounted = false;
  let timer;
  // 审核页首次打开后常驻（切到任务页只是隐藏），这样筛选、选择和展开状态不会丢
  let reviewVisited = false;

  // 仅当「历史导入」标签可见时才轮询；有任务在跑 3 秒一次，否则 15 秒一次
  $: polling = mounted && $activeTab === "history";
  $: interval = $historyOverview.runner?.running ? FAST_MS : SLOW_MS;
  $: if (polling) tick();
  $: if (!polling) clearTimeout(timer);
  $: if (polling && interval) schedule();
  $: if ($activeHistoryTab === "h-review") reviewVisited = true;

  $: chats = $historyOverview.chats;
  $: ensureSelection(chats, $historyOverview.runner);
  $: chat = $selectedHistoryChat;
  $: status = initStatusMeta(initStatusKey(chat, $historyOverview.runner));
  $: pendingTotal = chat
    ? (chat.facts?.meme?.pending ?? 0) + (chat.facts?.observation?.pending ?? 0)
    : 0;

  function schedule() {
    clearTimeout(timer);
    if (!polling) return;
    timer = setTimeout(tick, interval);
  }

  async function tick() {
    if (!polling) return;
    // 页面在后台时不请求，回到前台由 visibilitychange 补一次
    if (!document.hidden) await refreshHistoryOverview();
    schedule();
  }

  function onVisibility() {
    if (polling && !document.hidden) tick();
  }

  onMount(() => {
    mounted = true;
    document.addEventListener("visibilitychange", onVisibility);
  });

  onDestroy(() => {
    clearTimeout(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  });

  function activityTime(c) {
    const times = [c.initJob?.updatedAt, ...(c.importJobs || []).map((j) => j.updatedAt), c.messages?.latest]
      .map((t) => Date.parse(t))
      .filter(Number.isFinite);
    return times.length ? Math.max(...times) : 0;
  }

  /** 没选或选的会话已不在列表里时：优先有任务在跑的，否则选最近有活动的 */
  function ensureSelection(list, runner) {
    if (!list.length) return;
    if (list.some((c) => c.chatId === $selectedHistoryChatId)) return;
    const runningId = runner?.running?.chatId;
    const running = list.find((c) => c.chatId === runningId) || list.find((c) => c.initJob?.status === "running");
    const best = running || [...list].sort((a, b) => activityTime(b) - activityTime(a))[0];
    selectedHistoryChatId.set(best.chatId);
  }

  function optionLabel(c, runningId) {
    const tags = [];
    if (c.chatId === runningId) tags.push("运行中");
    if (c.isPrivateOrSensitive) tags.push("私聊/敏感");
    return tags.length ? `${chatLabel(c)}（${tags.join("、")}）` : chatLabel(c);
  }

  function switchTab(id) {
    activeHistoryTab.set(id);
  }
</script>

<!-- Chat selector (shared by both sub-pages) -->
<div class="card bg-base-100 mb-3">
  <div class="card-body p-3">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h3 class="card-title text-sm">
        <i class="fa-solid fa-file-import opacity-50 mr-1"></i> 历史导入
      </h3>
      {#if chats.length}
        <label class="flex items-center gap-2 min-w-0 flex-1 sm:flex-none">
          <span class="text-xs opacity-60 shrink-0">会话</span>
          <select
            class="select select-sm select-bordered min-w-0 w-full sm:w-72"
            aria-label="会话"
            bind:value={$selectedHistoryChatId}
          >
            {#each chats as c (c.chatId)}
              <option value={c.chatId}>{optionLabel(c, $historyOverview.runner?.running?.chatId)}</option>
            {/each}
          </select>
        </label>
        {#if chat}
          <span class="badge badge-sm {status.badge} gap-1" title="该会话的初始化状态">
            <i class="fa-solid {status.icon}"></i>{status.label}
          </span>
          {#if chat.isPrivateOrSensitive}
            <span class="badge badge-sm badge-warning badge-outline gap-1" title="私聊或敏感会话，发送给模型前需要明确同意">
              <i class="fa-solid fa-lock"></i>私聊/敏感
            </span>
          {/if}
        {/if}
      {/if}
      <button
        class="btn btn-xs btn-ghost ml-auto"
        aria-label="刷新"
        title="刷新"
        onclick={() => refreshHistoryOverview({ queue: true })}
      >
        <i class="fa-solid fa-rotate"></i><span class="hidden sm:inline">刷新</span>
      </button>
    </div>
  </div>
</div>

{#if $historyOverview.error}
  <div class="alert alert-error py-2 text-xs mb-3" role="alert">
    <i class="fa-solid fa-circle-exclamation"></i>
    <span class="min-w-0 break-words">{$historyOverview.error}</span>
    <button class="btn btn-xs" onclick={() => refreshHistoryOverview({ queue: true })}>重试</button>
  </div>
{/if}

<div class="hist-layout">
  <!-- Left Sidebar Nav -->
  <div class="hist-sidebar">
    <div class="card bg-base-100">
      <div class="card-body p-3">
        <h3 class="card-title text-sm mb-1">
          <i class="fa-solid fa-clock-rotate-left opacity-50 mr-1"></i> 导入与初始化
        </h3>
        <nav class="space-y-0.5" aria-label="历史导入">
          {#each subTabs as tab}
            <button
              class="hist-nav-item"
              class:active={$activeHistoryTab === tab.id}
              aria-current={$activeHistoryTab === tab.id ? "page" : undefined}
              onclick={() => switchTab(tab.id)}
            >
              <i class="fa-solid {tab.icon} fa-fw"></i>
              <span>{tab.label}</span>
              {#if tab.id === "h-review" && pendingTotal > 0}
                <span class="badge badge-xs badge-warning" title="待审 {pendingTotal} 条">{pendingTotal}</span>
              {/if}
            </button>
          {/each}
        </nav>
      </div>
    </div>
  </div>

  <!-- Right Content Area -->
  <div class="hist-content">
    {#if !$historyOverview.loaded}
      {#if !$historyOverview.error}
        <div class="card bg-base-100">
          <div class="card-body p-6 items-center text-sm opacity-70">
            <span class="loading loading-spinner loading-sm"></span>
            <span>正在加载…</span>
          </div>
        </div>
      {/if}
    {:else if !chats.length}
      <div class="card bg-base-100">
        <div class="card-body p-5 gap-3">
          <h3 class="card-title text-sm">
            <i class="fa-solid fa-inbox opacity-50 mr-1"></i> 还没有历史数据
          </h3>
          <p class="text-sm opacity-70">
            还没有任何会话导入过历史记录。QCE 导出文件需要先放到服务器上，用命令行导入；导入后这里会显示进度，并可以直接开始初始化。
          </p>
          <ImportCommand chatId="" />
        </div>
      </div>
    {:else}
      <div class:hidden={$activeHistoryTab !== "h-tasks"}><TasksTab /></div>
      {#if reviewVisited}
        <div class:hidden={$activeHistoryTab !== "h-review"}><ReviewTab /></div>
      {/if}
    {/if}
  </div>
</div>

<style>
  /* ── Two-column layout（与记忆查询面板一致） ── */
  .hist-layout {
    display: flex;
    gap: 1rem;
  }

  .hist-sidebar {
    width: 12.5rem;
    flex-shrink: 0;
  }

  .hist-content {
    flex: 1;
    min-width: 0;
  }

  .hist-nav-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    border-radius: 0.375rem;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    transition:
      background 0.15s,
      opacity 0.15s,
      color 0.15s;
    background: none;
    border: none;
    color: inherit;
    width: 100%;
    opacity: 0.7;
  }
  .hist-nav-item:hover {
    opacity: 1;
    background: var(--color-base-200);
  }
  .hist-nav-item.active {
    opacity: 1;
    background: color-mix(in srgb, var(--color-primary) 15%, transparent);
    color: var(--color-primary);
  }
  .hist-nav-item:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
  .hist-nav-item .badge {
    margin-left: auto;
  }

  @media (max-width: 768px) {
    .hist-layout { flex-direction: column; gap: 0.5rem; }
    .hist-sidebar {
      width: 100%;
      flex-shrink: 0;
    }
    .hist-sidebar .card-body { padding: 0.4rem !important; }
    .hist-sidebar .card-title { display: none; }
    .hist-sidebar nav {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
    }
    .hist-nav-item {
      white-space: nowrap;
      padding: 0.3rem 0.5rem;
      font-size: 0.7rem;
      width: auto;
    }
    .hist-nav-item i { display: none; }
    .hist-nav-item .badge { margin-left: 0.25rem; }
  }
</style>
