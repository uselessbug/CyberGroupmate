<script>
  import {
    historyOverview,
    selectedHistoryChat,
    selectedHistoryChatId,
    activeHistoryTab,
    pendingHistoryReview,
  } from '../../lib/stores.js';
  import {
    historyRequest,
    describeError,
    refreshHistoryOverview,
    chatLabel,
    modeLabel,
    formatTime,
    formatDate,
    formatCount,
    initStatusKey,
    initStatusMeta,
    importStatusMeta,
  } from '../../lib/history.js';
  import { timeAgo } from '../../lib/utils.js';
  import ImportCommand from './ImportCommand.svelte';

  const STAGES = [
    { id: 'cluster', label: '聚类' },
    { id: 'synthesize', label: '合成' },
    { id: 'embed', label: '向量' },
  ];

  let consent = false;
  /** 正在进行的请求：'quick' | 'full' | 'resume' | 'stop' | 'estimate'，空串表示空闲 */
  let busy = '';
  /** { type: 'error' | 'success' | 'info', text } */
  let msg = null;
  let estimateDialog;
  let estimate = { loading: false, quick: null, full: null };
  let lastChatId = null;

  $: chat = $selectedHistoryChat;
  $: runner = $historyOverview.runner;
  $: job = chat?.initJob || null;
  $: statusKey = initStatusKey(chat, runner);
  $: status = initStatusMeta(statusKey);
  $: runningHere = !!chat && runner?.running?.chatId === chat.chatId;
  $: externalRunning = !runningHere && job?.status === 'running';
  $: otherRunning = runner?.running && runner.running.chatId !== chat?.chatId ? runner.running : null;
  $: otherChat = otherRunning ? $historyOverview.chats.find((c) => c.chatId === otherRunning.chatId) : null;
  $: needConsent = !!chat?.isPrivateOrSensitive;
  $: consentMissing = needConsent && !consent;
  $: blockedByRunning = !!runner?.running || externalRunning;
  $: startDisabled = !!busy || blockedByRunning || consentMissing;
  $: resumeDisabled = startDisabled || !job?.resumable;
  $: startNote = otherRunning
    ? `会话「${otherChat ? chatLabel(otherChat) : otherRunning.chatId}」正在执行${modeLabel(otherRunning.mode)}初始化（${timeAgo(otherRunning.startedAt)}开始）。同一时刻只能跑一个任务，开始类按钮暂不可用。`
    : externalRunning
      ? '这个会话的任务由命令行启动并仍在运行，面板无法停止它；等它结束后再从这里开始。'
      : runningHere
        ? ''
        : consentMissing
          ? '这是私聊或敏感会话，需要先勾选上方的同意项才能开始或继续。'
          : '';

  $: messages = chat?.messages || {};
  $: coveragePct = messages.eligible > 0 ? Math.min(100, Math.round(((messages.covered ?? 0) / messages.eligible) * 100)) : 0;
  $: memePending = chat?.facts?.meme?.pending ?? 0;
  $: obsPending = chat?.facts?.observation?.pending ?? 0;

  // 换会话时清掉同意勾选和上一条提示，避免把同意带到另一个会话
  $: if ($selectedHistoryChatId !== lastChatId) {
    lastChatId = $selectedHistoryChatId;
    consent = false;
    msg = null;
  }

  function stageOf(j, id) {
    const s = j?.stages?.[id];
    return { done: s?.done ?? 0, total: s?.total ?? 0 };
  }

  function openReview(kind, reviewStatus = 'pending') {
    pendingHistoryReview.set({ kind, status: reviewStatus });
    activeHistoryTab.set('h-review');
  }

  function setMsg(chatId, next) {
    // 请求回来时用户可能已经切到别的会话
    if ($selectedHistoryChatId === chatId) msg = next;
  }

  async function start(mode, action) {
    if (!chat || busy) return;
    const target = chat;
    busy = action;
    msg = null;
    const body = { chatId: target.chatId, mode };
    if (target.isPrivateOrSensitive && consent) body.allowPrivateLlm = true;
    const res = await historyRequest('/history/init/start', { method: 'POST', body });
    busy = '';
    if (res.status === 202 || (res.ok && res.data?.ok)) {
      setMsg(target.chatId, {
        type: 'success',
        text: `已在后台开始${action === 'resume' ? '继续' : modeLabel(mode)}初始化，进度会自动刷新。`,
      });
    } else if (res.status === 409) {
      const r = res.data?.running;
      const other = r && $historyOverview.chats.find((c) => c.chatId === r.chatId);
      const who = r ? `「${other ? chatLabel(other) : r.chatId}」（${modeLabel(r.mode)}，${timeAgo(r.startedAt)}开始）` : '另一个会话';
      setMsg(target.chatId, { type: 'error', text: `没能开始：已有初始化任务在运行，会话${who}。请等它结束或先停止它。` });
    } else if (res.status === 400 && res.data?.error === 'private_consent_required') {
      setMsg(target.chatId, {
        type: 'error',
        text: '没能开始：这是私聊或敏感会话，需要勾选「允许把这个会话的内容发送给模型」后再试。',
      });
    } else {
      setMsg(target.chatId, { type: 'error', text: `没能开始：${describeError(res)}` });
    }
    refreshHistoryOverview({ queue: true });
  }

  async function stop() {
    if (!chat || busy) return;
    const target = chat;
    busy = 'stop';
    msg = null;
    const res = await historyRequest('/history/init/stop', { method: 'POST', body: { chatId: target.chatId } });
    busy = '';
    if (res.ok && res.data?.ok) {
      setMsg(target.chatId, { type: 'info', text: '已请求停止，任务会在当前步骤结束后变为「已暂停」，之后可以继续。' });
    } else if (res.ok) {
      setMsg(target.chatId, { type: 'info', text: '这个会话当前没有由面板启动的运行中任务。' });
    } else {
      setMsg(target.chatId, { type: 'error', text: `停止失败：${describeError(res)}` });
    }
    refreshHistoryOverview({ queue: true });
  }

  async function openEstimate() {
    if (!chat || busy) return;
    const target = chat;
    busy = 'estimate';
    estimate = { loading: true, quick: null, full: null };
    estimateDialog?.showModal();
    const [quick, full] = await Promise.all(
      ['quick', 'full'].map((mode) => historyRequest('/history/init/estimate', { method: 'POST', body: { chatId: target.chatId, mode } })),
    );
    const pick = (r) => (r.ok && r.data ? { data: r.data } : { error: describeError(r) });
    estimate = { loading: false, quick: pick(quick), full: pick(full) };
    busy = '';
  }

  const ESTIMATE_ROWS = [
    { key: 'eligibleMessages', label: '可用消息' },
    { key: 'totalWindows', label: '窗口总数' },
    { key: 'uncoveredWindows', label: '未覆盖窗口' },
    { key: 'selectedWindows', label: '本次处理窗口' },
    { key: 'estimatedClusterCalls', label: '预计聚类调用' },
    { key: 'estimatedSynthesisCalls', label: '预计合成调用' },
  ];

  function totalCalls(d) {
    return (d?.estimatedClusterCalls ?? 0) + (d?.estimatedSynthesisCalls ?? 0);
  }
</script>

{#if chat}
  <div class="space-y-3">
    <!-- 概览条 -->
    <div class="card bg-base-100">
      <div class="card-body p-4">
        <div class="hist-strip">
          <div class="hist-cell hist-wide">
            <div class="hist-cell-title">导入消息</div>
            <div class="hist-cell-value">{formatCount(messages.imported)}</div>
            <div class="text-xs opacity-60 mt-1">
              可用 {formatCount(messages.eligible)} 条
              <br />
              {formatDate(messages.earliest)} ~ {formatDate(messages.latest)}
            </div>
          </div>

          <div class="hist-cell hist-wide">
            <div class="hist-cell-title">已聚类覆盖率</div>
            <div class="hist-cell-value">{coveragePct}%</div>
            <progress
              class="progress progress-primary w-full my-1"
              value={coveragePct}
              max="100"
              aria-label="已聚类覆盖率"
            ></progress>
            <div class="text-xs opacity-60">{formatCount(messages.covered)} / {formatCount(messages.eligible)} 条</div>
          </div>

          <div class="hist-cell">
            <div class="hist-cell-title">话题数</div>
            <div class="hist-cell-value">{formatCount(chat.topics)}</div>
          </div>

          <button
            class="hist-cell hist-cell-link"
            aria-label="查看待审群梗，共 {memePending} 条"
            title="跳到审核页，查看待审核的群梗"
            onclick={() => openReview('meme')}
          >
            <div class="hist-cell-title">待审群梗 <i class="fa-solid fa-arrow-right text-[0.6rem] opacity-60"></i></div>
            <div class="hist-cell-value">{formatCount(memePending)}</div>
            <div class="text-xs opacity-60 mt-1">通过 {chat.facts?.meme?.approved ?? 0} · 拒绝 {chat.facts?.meme?.rejected ?? 0}</div>
          </button>

          <button
            class="hist-cell hist-cell-link"
            aria-label="查看待审观察，共 {obsPending} 条"
            title="跳到审核页，查看待审核的群观察"
            onclick={() => openReview('observation')}
          >
            <div class="hist-cell-title">待审观察 <i class="fa-solid fa-arrow-right text-[0.6rem] opacity-60"></i></div>
            <div class="hist-cell-value">{formatCount(obsPending)}</div>
            <div class="text-xs opacity-60 mt-1">通过 {chat.facts?.observation?.approved ?? 0} · 拒绝 {chat.facts?.observation?.rejected ?? 0}</div>
          </button>
        </div>
      </div>
    </div>

    <!-- 初始化卡片 -->
    <div class="card bg-base-100">
      <div class="card-body p-4">
        <div class="flex flex-wrap items-center gap-2 mb-1">
          <h3 class="card-title text-sm">离线初始化</h3>
          <span class="badge badge-sm {status.badge} gap-1">
            <i class="fa-solid {status.icon}"></i>{status.label}
          </span>
          {#if job}
            <span class="badge badge-sm badge-outline">{modeLabel(job.mode)}</span>
            <span class="text-xs opacity-60" title={formatTime(job.updatedAt)}>更新于 {timeAgo(job.updatedAt) || '-'}</span>
          {/if}
        </div>

        {#if statusKey === 'paused'}
          <div class="alert alert-warning py-2 text-xs items-start" role="status">
            <i class="fa-solid fa-circle-pause mt-0.5"></i>
            <div class="min-w-0">
              <div class="font-semibold">任务已暂停，可以点「继续」接着跑</div>
              {#if job?.error}
                <div class="font-mono whitespace-pre-wrap break-words mt-1">{job.error}</div>
              {/if}
            </div>
          </div>
        {:else if statusKey === 'stale'}
          <div class="alert alert-error py-2 text-xs items-start" role="status">
            <i class="fa-solid fa-triangle-exclamation mt-0.5"></i>
            <div class="min-w-0">
              <div class="font-semibold">任务被中断</div>
              <div class="mt-0.5">库里仍是运行中，但租约已过期，多半是主进程重启了。已完成的部分不会重做，点「继续」即可。</div>
            </div>
          </div>
        {:else if statusKey === 'none'}
          <p class="text-xs opacity-70">
            这个会话还没有初始化过。「快速初始化」先处理最新和最密的少量窗口，适合先看看效果；「补齐全部」处理所有未覆盖的窗口。
          </p>
        {/if}

        <div class="space-y-2 mt-2">
          {#each STAGES as st}
            {@const s = stageOf(job, st.id)}
            <div class="flex items-center gap-3">
              <span class="text-xs w-9 shrink-0">{st.label}</span>
              <progress
                class="progress flex-1 {statusKey === 'running' ? 'progress-info' : s.total > 0 && s.done >= s.total ? 'progress-success' : 'progress-primary'}"
                value={s.done}
                max={s.total || 1}
                aria-label="{st.label}进度 {s.done} / {s.total}"
              ></progress>
              <span class="text-xs font-mono tabular-nums w-20 text-right shrink-0">{formatCount(s.done)} / {formatCount(s.total)}</span>
            </div>
          {/each}
        </div>

        {#if needConsent}
          <label class="flex items-start gap-2 text-xs cursor-pointer mt-3">
            <input type="checkbox" class="checkbox checkbox-sm checkbox-warning mt-0.5" bind:checked={consent} />
            <span>
              允许把这个会话的内容发送给模型
              <span class="block opacity-60">私聊或敏感会话的聊天内容会发给外部模型和向量接口，勾选后才能开始或继续。</span>
            </span>
          </label>
        {/if}

        <div class="flex flex-wrap items-center gap-2 mt-3">
          <button class="btn btn-sm btn-outline" disabled={!!busy} onclick={openEstimate}>
            {#if busy === 'estimate'}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-calculator"></i>{/if}
            预估用量
          </button>
          <button
            class="btn btn-sm btn-primary"
            disabled={startDisabled}
            title={startNote || '处理最新和最密的少量窗口'}
            onclick={() => start('quick', 'quick')}
          >
            {#if busy === 'quick'}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-bolt"></i>{/if}
            快速初始化
          </button>
          <button
            class="btn btn-sm btn-outline btn-primary"
            disabled={startDisabled}
            title={startNote || '处理所有未覆盖的窗口'}
            onclick={() => start('full', 'full')}
          >
            {#if busy === 'full'}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-layer-group"></i>{/if}
            补齐全部
          </button>
          <button
            class="btn btn-sm btn-outline"
            disabled={resumeDisabled}
            title={!job?.resumable ? '没有可继续的任务（只有已暂停或已中断的任务可以继续）' : startNote || `继续上次的${modeLabel(job.mode)}初始化`}
            onclick={() => start(job.mode, 'resume')}
          >
            {#if busy === 'resume'}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-play"></i>{/if}
            继续
          </button>
          <button
            class="btn btn-sm btn-outline btn-error"
            disabled={!!busy || !runningHere}
            title={runningHere ? '停止当前任务，之后可以继续' : '这个会话没有正在运行的任务'}
            onclick={stop}
          >
            {#if busy === 'stop'}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-stop"></i>{/if}
            停止
          </button>
        </div>

        {#if startNote}
          <p class="text-xs opacity-70 mt-2" role="status">
            <i class="fa-solid fa-circle-info mr-1"></i>{startNote}
            {#if otherRunning}
              <button class="btn btn-xs btn-ghost ml-1" onclick={() => selectedHistoryChatId.set(otherRunning.chatId)}>
                切换到该会话
              </button>
            {/if}
          </p>
        {/if}

        {#if msg}
          <div
            class="alert py-2 text-xs mt-3 items-start"
            class:alert-error={msg.type === 'error'}
            class:alert-success={msg.type === 'success'}
            class:alert-info={msg.type === 'info'}
            role={msg.type === 'error' ? 'alert' : 'status'}
          >
            <i class="fa-solid {msg.type === 'error' ? 'fa-circle-exclamation' : msg.type === 'success' ? 'fa-circle-check' : 'fa-circle-info'} mt-0.5"></i>
            <span class="min-w-0 break-words flex-1">{msg.text}</span>
            <button class="btn btn-xs btn-ghost" aria-label="关闭提示" title="关闭" onclick={() => (msg = null)}>
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        {/if}
      </div>
    </div>

    <!-- 导入记录 + 命令示例 -->
    <div class="card bg-base-100">
      <div class="card-body p-4">
        <h3 class="card-title text-sm mb-1">导入记录</h3>
        <div class="overflow-x-auto">
          <table class="table table-xs">
            <thead><tr><th>导入任务</th><th>状态</th><th>更新时间</th></tr></thead>
            <tbody>
              {#if !chat.importJobs?.length}
                <tr><td colspan="3" class="text-center opacity-60">这个会话还没有导入记录</td></tr>
              {:else}
                {#each chat.importJobs as j (j.jobId)}
                  {@const m = importStatusMeta(j.status)}
                  <tr>
                    <td class="font-mono text-xs" title={j.jobId}>{j.inputKeyShort || j.jobId}</td>
                    <td><span class="badge badge-xs {m.badge}">{m.label}</span></td>
                    <td class="text-xs opacity-60 whitespace-nowrap" title={formatTime(j.updatedAt)}>{timeAgo(j.updatedAt) || '-'}</td>
                  </tr>
                {/each}
              {/if}
            </tbody>
          </table>
        </div>

        <h3 class="card-title text-sm mt-3 mb-1">导入命令示例</h3>
        <p class="text-xs opacity-60 mb-1">QCE 导出文件需要先放到服务器上，导入仍然通过命令行；这里只展示导入的结果。</p>
        <ImportCommand chatId={chat.chatId} />
      </div>
    </div>
  </div>
{/if}

<!-- 预估用量 -->
<dialog bind:this={estimateDialog} class="modal">
  <div class="modal-box max-w-xl">
    <h3 class="text-lg font-bold">预估用量</h3>
    <p class="text-xs opacity-60 mt-1">
      只估算窗口数和模型调用次数，不调用模型，也不写库。实际用量还取决于消息长度。
    </p>
    {#if chat?.isPrivateOrSensitive}
      <div class="alert alert-warning py-2 text-xs mt-3">
        <i class="fa-solid fa-lock"></i>
        <span>这是私聊或敏感会话，开始前需要勾选同意把内容发送给模型。</span>
      </div>
    {/if}

    {#if estimate.loading}
      <div class="flex items-center gap-2 py-6 justify-center text-sm opacity-70">
        <span class="loading loading-spinner loading-sm"></span> 正在估算…
      </div>
    {:else}
      <div class="overflow-x-auto mt-3">
        <table class="table table-sm">
          <thead>
            <tr><th></th><th class="text-right">快速初始化</th><th class="text-right">补齐全部</th></tr>
          </thead>
          <tbody>
            {#each ESTIMATE_ROWS as row}
              <tr>
                <td class="text-xs">{row.label}</td>
                {#each [estimate.quick, estimate.full] as col}
                  <td class="text-right font-mono tabular-nums">
                    {#if col?.data}{formatCount(col.data[row.key])}{:else}-{/if}
                  </td>
                {/each}
              </tr>
            {/each}
            <tr class="font-semibold">
              <td class="text-xs">预计调用合计</td>
              {#each [estimate.quick, estimate.full] as col}
                <td class="text-right font-mono tabular-nums">
                  {#if col?.data}{formatCount(totalCalls(col.data))}{:else}-{/if}
                </td>
              {/each}
            </tr>
          </tbody>
        </table>
      </div>
      {#each [['快速初始化', estimate.quick], ['补齐全部', estimate.full]] as [name, col]}
        {#if col?.error}
          <div class="alert alert-error py-2 text-xs mt-2" role="alert">
            <i class="fa-solid fa-circle-exclamation"></i><span>{name}：{col.error}</span>
          </div>
        {/if}
      {/each}
    {/if}

    <div class="modal-action">
      <form method="dialog"><button class="btn btn-sm">关闭</button></form>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop"><button aria-label="关闭">close</button></form>
</dialog>

<style>
  /* 不用 Tailwind 的 col-span：别的面板里有同名的全局规则会盖掉它 */
  .hist-strip {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
  }
  .hist-wide {
    grid-column: 1 / -1;
  }
  @media (min-width: 1024px) {
    .hist-strip {
      grid-template-columns: 1.5fr 1.5fr 1fr 1fr 1fr;
    }
    .hist-wide {
      grid-column: auto;
    }
  }
  .hist-cell {
    display: block;
    text-align: left;
    min-width: 0;
    padding: 0.6rem 0.75rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--color-base-content) 5%, transparent);
    color: inherit;
  }
  .hist-cell-title {
    font-size: 0.7rem;
    opacity: 0.65;
  }
  .hist-cell-value {
    font-size: 1.4rem;
    line-height: 1.8rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .hist-cell-link {
    cursor: pointer;
    border: 1px solid transparent;
    transition: background 0.15s, border-color 0.15s;
  }
  .hist-cell-link:hover {
    background: color-mix(in srgb, var(--color-primary) 10%, transparent);
    border-color: color-mix(in srgb, var(--color-primary) 30%, transparent);
  }
  .hist-cell-link:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
  @media (max-width: 768px) {
    .hist-cell-value { font-size: 1.15rem; line-height: 1.5rem; }
  }
</style>
