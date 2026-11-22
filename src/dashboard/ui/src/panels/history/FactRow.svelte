<script>
  import { formatTime } from '../../lib/history.js';

  /** GET /history/facts 返回的一条 */
  export let item;
  export let selected = false;
  export let expanded = false;
  /** 键盘焦点所在行；kbd 为 true 时才画出焦点环（鼠标操作时不画） */
  export let focused = false;
  export let kbd = false;
  /** 正在进行的单条操作：'approve' | 'reject' | 'reset' | 'restore'，空串为空闲 */
  export let busy = '';
  /** { state: 'loading' | 'ok' | 'error', data?, error? }，展开时才会有 */
  export let evidence = undefined;
  /** async (item, payload) => ({ ok, error? })，由父组件真正发 PUT */
  export let save = async () => ({ ok: false, error: '' });

  export let onselect = () => {};
  export let ontoggle = () => {};
  export let onact = () => {};
  export let onretry = () => {};
  export let onfocusrow = () => {};
  export let oneditchange = () => {};

  const FLAG_TEXT = {
    short_term: '所有说法都不超过 2 个字，按子串统计的使用次数可能偏高，请对照下面的原始消息确认',
    low_usage: '使用情况刚好踩在准入线上（2 人、不超过 3 条消息）',
  };

  let editing = false;
  let saving = false;
  let editError = '';
  let form = {};

  $: meme = item.kind === 'meme' ? item.meme : null;
  $: title = meme?.term || item.content;
  $: usage = meme?.usage;
  $: flags = item.flags || [];
  $: locked = !!busy || saving;
  $: citedCount = item.citedCount ?? 0;

  function startEdit() {
    if (editing || locked) return;
    form = meme
      ? {
          term: meme.term || '',
          meaning: meme.meaning || '',
          originContext: meme.originContext || '',
          usageBoundaries: meme.usageBoundaries || '',
        }
      : { content: item.content || '' };
    editError = '';
    editing = true;
    oneditchange(true);
    // 编辑时顺手展开，方便对照引用的原始消息
    if (!expanded) ontoggle();
  }

  function cancelEdit() {
    editing = false;
    editError = '';
    oneditchange(false);
  }

  async function submitEdit() {
    if (saving) return;
    let payload;
    if (meme) {
      const m = {
        term: form.term.trim(),
        meaning: form.meaning.trim(),
        originContext: form.originContext.trim(),
        usageBoundaries: form.usageBoundaries.trim(),
      };
      if (!m.term || !m.meaning) {
        editError = '原词和含义不能为空';
        return;
      }
      payload = { meme: m };
    } else {
      const content = form.content.trim();
      if (!content) {
        editError = '内容不能为空';
        return;
      }
      payload = { content };
    }
    saving = true;
    editError = '';
    const res = await save(item, payload);
    saving = false;
    if (res.ok) {
      editing = false;
      oneditchange(false);
    } else {
      editError = res.error || '保存失败';
    }
  }

  function onFormKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitEdit();
    }
  }
</script>

<div
  class="hist-row"
  class:focused={focused && kbd}
  class:is-selected={selected}
  data-hkey={item.historyKey}
  tabindex="-1"
  aria-busy={locked}
  onfocusin={onfocusrow}
>
  <input
    type="checkbox"
    class="checkbox checkbox-sm checkbox-primary mt-0.5"
    checked={selected}
    onchange={(e) => onselect(e.currentTarget.checked)}
    aria-label="选择：{title}"
  />

  <div class="hist-main">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      {#if meme}
        <span class="font-semibold break-words min-w-0">{meme.term}</span>
        {#if usage}
          <span class="badge badge-sm badge-ghost gap-1" title="使用情况：{usage.messages} 条消息，{usage.senders} 人用过">
            <i class="fa-regular fa-comment-dots"></i>{usage.messages} 条 · {usage.senders} 人
          </span>
        {:else}
          <span class="badge badge-sm badge-ghost opacity-70" title="解析不到使用情况">使用情况未知</span>
        {/if}
      {:else}
        <span class="badge badge-sm badge-ghost gap-1"><i class="fa-regular fa-eye"></i>观察</span>
      {/if}
      {#if flags.length}
        <span class="badge badge-sm badge-warning gap-1" title={flags.map((f) => FLAG_TEXT[f] || f).join('\n')}>
          <i class="fa-solid fa-triangle-exclamation"></i>留意
        </span>
      {/if}
    </div>

    {#if meme}
      <p class="text-sm opacity-85 break-words mt-0.5" class:line-clamp-2={!expanded}>{meme.meaning || '（没有含义说明）'}</p>
    {:else}
      <p class="text-sm break-words mt-0.5 whitespace-pre-wrap" class:line-clamp-3={!expanded}>{item.content}</p>
    {/if}

    {#if flags.length}
      <ul class="text-xs mt-1 space-y-0.5">
        {#each flags as f}
          <li class="flex gap-1.5 items-start">
            <i class="fa-solid fa-triangle-exclamation mt-0.5 shrink-0 opacity-70"></i>
            <span class="opacity-80 break-words min-w-0">{FLAG_TEXT[f] || f}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="text-xs opacity-60 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
      {#if item.sourceTopicLabel}<span class="break-words min-w-0"><i class="fa-regular fa-bookmark mr-1"></i>{item.sourceTopicLabel}</span>{/if}
      <span>引用 {citedCount} 条</span>
      {#if item.observedAt}<span title={formatTime(item.observedAt)}>{formatTime(item.observedAt)}</span>{/if}
    </div>

    {#if editing}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="hist-edit" onkeydown={onFormKeydown}>
        {#if meme}
          <label class="block">
            <span class="label text-xs py-1">原词</span>
            <input type="text" class="input input-sm input-bordered w-full" bind:value={form.term} maxlength="200" />
            <span class="label text-[0.7rem] opacity-60 py-1">有多个说法时用「 / 」隔开，和列表里的显示一致</span>
          </label>
          <label class="block">
            <span class="label text-xs py-1">真实含义</span>
            <textarea class="textarea textarea-bordered textarea-sm w-full" rows="2" bind:value={form.meaning}></textarea>
          </label>
          <label class="block">
            <span class="label text-xs py-1">来源背景</span>
            <textarea class="textarea textarea-bordered textarea-sm w-full" rows="2" bind:value={form.originContext}></textarea>
          </label>
          <label class="block">
            <span class="label text-xs py-1">使用边界</span>
            <textarea class="textarea textarea-bordered textarea-sm w-full" rows="2" bind:value={form.usageBoundaries}></textarea>
          </label>
        {:else}
          <label class="block">
            <span class="label text-xs py-1">观察内容</span>
            <textarea class="textarea textarea-bordered textarea-sm w-full" rows="4" bind:value={form.content}></textarea>
          </label>
        {/if}
        {#if editError}
          <div class="alert alert-error py-2 text-xs" role="alert">
            <i class="fa-solid fa-circle-exclamation"></i><span class="min-w-0 break-words">{editError}</span>
          </div>
        {/if}
        <div class="flex flex-wrap items-center gap-2">
          <button class="btn btn-xs btn-primary" disabled={saving} onclick={submitEdit}>
            {#if saving}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-floppy-disk"></i>{/if}
            保存并通过
          </button>
          <button class="btn btn-xs btn-ghost" disabled={saving} onclick={cancelEdit}>取消</button>
          <span class="text-[0.7rem] opacity-60">保存后这条会标为已通过，之后不会再被离线合成覆盖。Ctrl+Enter 保存，Esc 取消。</span>
        </div>
      </div>
    {/if}

    {#if expanded}
      <div class="hist-detail">
        {#if meme}
          <dl class="hist-dl">
            <dt>来源背景</dt><dd>{meme.originContext || '—'}</dd>
            <dt>使用边界</dt><dd>{meme.usageBoundaries || '—'}</dd>
            {#if meme.variants?.length > 1}
              <dt>各种说法</dt>
              <dd class="flex flex-wrap gap-1">
                {#each meme.variants as v}<span class="badge badge-sm badge-outline">{v}</span>{/each}
              </dd>
            {/if}
            <dt>相关成员</dt>
            <dd class="flex flex-wrap gap-1">
              {#if meme.participants?.length}
                {#each meme.participants as p}
                  <span class="badge badge-sm badge-ghost" title={p.userId}>{p.displayName || p.userId}</span>
                {/each}
              {:else}—{/if}
            </dd>
            <dt>来源话题</dt><dd>{item.sourceTopicLabel || '—'}</dd>
          </dl>
        {:else}
          <dl class="hist-dl">
            <dt>来源话题</dt><dd>{item.sourceTopicLabel || '—'}</dd>
          </dl>
        {/if}

        <div class="mt-2">
          <div class="text-xs font-semibold mb-1"><i class="fa-regular fa-comments mr-1 opacity-60"></i>引用的原始消息</div>
          {#if !evidence || evidence.state === 'loading'}
            <div class="flex items-center gap-2 text-xs opacity-70 py-2">
              <span class="loading loading-spinner loading-xs"></span> 正在加载引用消息…
            </div>
          {:else if evidence.state === 'error'}
            <div class="alert alert-error py-2 text-xs" role="alert">
              <i class="fa-solid fa-circle-exclamation"></i>
              <span class="min-w-0 break-words">{evidence.error}</span>
              <button class="btn btn-xs" onclick={onretry}>重试</button>
            </div>
          {:else}
            {#if evidence.data.topic}
              <div class="text-xs opacity-70 mb-1 break-words">
                话题「{evidence.data.topic.label}」{#if evidence.data.topic.summary}：{evidence.data.topic.summary}{/if}
              </div>
            {/if}
            {#if evidence.data.messages?.length}
              <ul class="hist-evidence">
                {#each evidence.data.messages as m (m.messageId)}
                  <li>
                    <div class="text-[0.7rem] opacity-60">
                      <span class="font-semibold opacity-100">{m.displayName || m.userId}</span>
                      · {formatTime(m.timestamp)}
                    </div>
                    <div class="text-xs whitespace-pre-wrap break-words">{m.text}</div>
                  </li>
                {/each}
              </ul>
            {:else if !evidence.data.missing}
              <div class="text-xs opacity-60">没有可以展示的引用消息</div>
            {/if}
            {#if evidence.data.missing > 0}
              <div class="text-xs mt-1.5 flex gap-1.5 items-start opacity-80">
                <i class="fa-solid fa-circle-info mt-0.5"></i>
                <span>另有 {evidence.data.missing} 条引用的消息已经不存在或已被屏蔽，无法展示。</span>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <div class="hist-actions">
    {#if item.status === 'pending'}
      <button
        class="btn btn-xs btn-soft btn-success"
        disabled={locked}
        aria-label="通过：{title}"
        title="通过（A）"
        onclick={() => onact('approve')}
      >
        {#if busy === 'approve'}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-check"></i>{/if}
        <span class="hist-lbl">通过</span>
      </button>
    {:else if item.status === 'approved'}
      <button
        class="btn btn-xs btn-soft"
        disabled={locked}
        aria-label="退回待审：{title}"
        title="退回待审"
        onclick={() => onact('reset')}
      >
        {#if busy === 'reset'}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-rotate-left"></i>{/if}
        <span class="hist-lbl">退回待审</span>
      </button>
    {:else}
      <button
        class="btn btn-xs btn-soft btn-success"
        disabled={locked}
        aria-label="恢复：{title}"
        title="恢复为已通过（A）"
        onclick={() => onact('restore')}
      >
        {#if busy === 'restore'}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-trash-can-arrow-up"></i>{/if}
        <span class="hist-lbl">恢复</span>
      </button>
    {/if}

    {#if item.status !== 'rejected'}
      <button
        class="btn btn-xs btn-soft btn-error"
        disabled={locked}
        aria-label="拒绝：{title}"
        title="拒绝（X）"
        onclick={() => onact('reject')}
      >
        {#if busy === 'reject'}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-xmark"></i>{/if}
        <span class="hist-lbl">拒绝</span>
      </button>
      <button
        class="btn btn-xs btn-ghost"
        disabled={locked || editing}
        aria-label="编辑：{title}"
        title="编辑"
        onclick={startEdit}
      >
        <i class="fa-solid fa-pen-to-square"></i><span class="hist-lbl">编辑</span>
      </button>
    {/if}

    <button
      class="btn btn-xs btn-ghost"
      aria-label={expanded ? `收起：${title}` : `展开：${title}`}
      aria-expanded={expanded}
      title={expanded ? '收起（Enter）' : '展开（Enter）'}
      onclick={ontoggle}
    >
      <i class="fa-solid {expanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>
    </button>
  </div>
</div>

<style>
  .hist-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0.4rem 0.75rem;
    padding: 0.75rem 0.5rem 0.75rem 0.75rem;
    border-left: 3px solid transparent;
    scroll-margin-top: 9rem;
    outline: none;
  }
  .hist-row.is-selected {
    background: color-mix(in srgb, var(--color-primary) 6%, transparent);
  }
  .hist-row.focused {
    border-left-color: var(--color-primary);
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
    background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  }
  .hist-row[aria-busy='true'] {
    opacity: 0.75;
  }

  .hist-main {
    min-width: 0;
  }

  .hist-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: flex-end;
    gap: 0.25rem;
  }

  .hist-edit {
    margin-top: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--color-primary) 35%, transparent);
    background: color-mix(in srgb, var(--color-base-content) 4%, transparent);
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.25rem;
  }

  .hist-detail {
    margin-top: 0.5rem;
    padding: 0.6rem 0.75rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--color-base-content) 5%, transparent);
    font-size: 0.75rem;
  }

  .hist-dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.3rem 0.75rem;
  }
  .hist-dl dt {
    opacity: 0.6;
  }
  .hist-dl dd {
    overflow-wrap: anywhere;
  }

  .hist-evidence {
    max-height: 16rem;
    overflow-y: auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.4rem;
  }
  .hist-evidence li {
    overflow-wrap: anywhere;
    padding: 0.35rem 0.6rem;
    border-radius: 0.375rem;
    background: var(--color-base-100);
    border: 1px solid color-mix(in srgb, var(--color-base-content) 10%, transparent);
  }

  /* 窄屏：操作收成条目下方的一行图标 */
  @media (max-width: 640px) {
    .hist-row {
      grid-template-columns: auto minmax(0, 1fr);
      padding: 0.6rem 0.4rem 0.6rem 0.5rem;
    }
    .hist-actions {
      grid-column: 2;
      justify-content: flex-start;
    }
    .hist-lbl {
      display: none;
    }
    .hist-actions .btn {
      min-width: 2rem;
      min-height: 2rem;
    }
    .hist-dl {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.1rem;
    }
    .hist-dl dd {
      margin-bottom: 0.3rem;
    }
  }
</style>
