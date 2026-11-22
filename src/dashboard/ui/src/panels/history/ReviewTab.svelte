<script>
  import { onDestroy, tick } from 'svelte';
  import {
    activeTab,
    activeHistoryTab,
    selectedHistoryChatId,
    pendingHistoryReview,
  } from '../../lib/stores.js';
  import { historyRequest, describeError } from '../../lib/history.js';
  import FactRow from './FactRow.svelte';
  import ImportCommand from './ImportCommand.svelte';

  const PAGE_SIZE = 30;
  const KINDS = [
    { id: 'meme', label: '群梗', icon: 'fa-face-grin-squint' },
    { id: 'observation', label: '群观察', icon: 'fa-eye' },
  ];
  const STATUSES = [
    { id: 'pending', label: '待审核' },
    { id: 'approved', label: '已通过' },
    { id: 'rejected', label: '已拒绝' },
  ];
  const SORTS = [
    { id: 'recent', label: '最近' },
    { id: 'usage_desc', label: '使用最多' },
    { id: 'usage_asc', label: '使用最少' },
  ];
  /** 各操作把条目从当前状态移到哪个状态 */
  const ACTION_TARGET = { approve: 'approved', reject: 'rejected', reset: 'pending', restore: 'approved' };
  const ACTION_DONE = { approve: '已通过', reject: '已拒绝', reset: '已退回待审', restore: '已恢复' };

  // 筛选
  let kind = 'meme';
  let status = 'pending';
  let sort = 'recent';
  let qInput = '';
  let q = '';
  let page = 0;

  // 列表
  let items = [];
  let total = 0;
  let counts = null;
  let loading = false;
  let loaded = false;
  let loadError = '';

  // 行状态（均以 historyKey 为键）
  let selected = {};
  let expanded = {};
  let evidence = {};
  let busyRow = {};
  let editing = {};
  let bulkBusy = '';

  let focusKey = null;
  let kbd = false;
  let notice = null;
  let noticeTimer;
  let qTimer;
  let loadedKey = null;
  let lastScope = null;
  let seq = 0;
  /** 筛选或会话变化时 +1，用来丢弃旧筛选下才返回的操作结果 */
  let epoch = 0;
  let listEl;
  let toolbarEl;
  let allBox;

  $: active = $activeTab === 'history' && $activeHistoryTab === 'h-review';
  $: chatId = $selectedHistoryChatId;
  $: filterKey = [chatId, kind, status, sort, q].join('|');
  $: if (active && chatId && filterKey !== loadedKey) resetAndLoad();

  $: kindLabel = kind === 'meme' ? '群梗' : '群观察';
  $: statusLabel = STATUSES.find((s) => s.id === status)?.label || '';
  $: pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  $: selectedKeys = items.filter((i) => selected[i.historyKey]).map((i) => i.historyKey);
  $: allSelected = items.length > 0 && selectedKeys.length === items.length;
  $: if (allBox) allBox.indeterminate = selectedKeys.length > 0 && !allSelected;
  $: allZero = !!counts && counts.pending + counts.approved + counts.rejected === 0;

  // 任务页点「待审」数字时带来的筛选。用订阅而不是 $: 语句：订阅回调同步执行，
  // 保证首次加载前 kind / status 已经就位，不会先按默认筛选发一次请求再被丢弃
  const unsubPreset = pendingHistoryReview.subscribe((p) => {
    if (p) applyPreset(p);
  });

  function applyPreset(p) {
    pendingHistoryReview.set(null);
    if (p.kind && p.kind !== kind) setKind(p.kind);
    if (p.status) status = p.status;
    qInput = '';
    q = '';
  }

  function setKind(k) {
    kind = k;
    // 使用次数排序只对群梗有意义
    if (k !== 'meme' && sort !== 'recent') sort = 'recent';
  }

  function resetAndLoad() {
    loadedKey = filterKey;
    // 换会话或换种类后，旧的计数没有意义
    const scope = `${chatId}|${kind}`;
    if (scope !== lastScope) {
      lastScope = scope;
      counts = null;
    }
    epoch++;
    page = 0;
    items = [];
    total = 0;
    selected = {};
    expanded = {};
    evidence = {};
    editing = {};
    busyRow = {};
    focusKey = null;
    notice = null;
    load();
  }

  async function load({ silent = false } = {}) {
    if (!chatId) return;
    const my = ++seq;
    if (!silent) loading = true;
    const params = new URLSearchParams({
      chatId,
      kind,
      status,
      sort,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (q) params.set('q', q);
    const res = await historyRequest(`/history/facts?${params}`);
    if (my !== seq) return;
    loading = false;
    if (res.ok && res.data && Array.isArray(res.data.items)) {
      loadError = '';
      loaded = true;
      total = res.data.total ?? res.data.items.length;
      counts = res.data.counts || counts;
      // 翻到了已经没有数据的页（别处删光了）：回到最后一页
      if (!res.data.items.length && total > 0 && page > 0) {
        page = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
        load();
        return;
      }
      items = res.data.items;
      // 只保留还在页面上的选择，避免批量操作带上看不见的条目
      const keys = new Set(items.map((i) => i.historyKey));
      selected = Object.fromEntries(Object.entries(selected).filter(([k]) => keys.has(k)));
    } else {
      // 失败时保留原有列表，只在原位置给出错误和重试
      loadError = describeError(res);
    }
  }

  function onSearchInput() {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { q = qInput.trim(); }, 300);
  }

  function applySearchNow() {
    clearTimeout(qTimer);
    q = qInput.trim();
  }

  function clearSearch() {
    clearTimeout(qTimer);
    qInput = '';
    q = '';
  }

  function goPage(p) {
    if (loading || p < 0 || p >= pageCount || p === page) return;
    page = p;
    selected = {};
    focusKey = null;
    load();
    toolbarEl?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // ─── 提示 ───
  function showNotice(type, text) {
    clearTimeout(noticeTimer);
    notice = { type, text };
    if (type !== 'error') noticeTimer = setTimeout(() => { notice = null; }, 3500);
  }

  // ─── 本地更新 ───
  function omit(obj, keys) {
    const set = new Set(keys);
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !set.has(k)));
  }

  function setBusy(keys, action) {
    busyRow = { ...busyRow, ...Object.fromEntries(keys.map((k) => [k, action])) };
  }

  function clearBusy(keys) {
    busyRow = omit(busyRow, keys);
  }

  /** 把条目从当前列表移除；焦点行被移除时，焦点落到顺位的下一行（没有就落到上一行） */
  function removeKeys(keys) {
    const gone = new Set(keys);
    const focusIdx = items.findIndex((i) => i.historyKey === focusKey);
    const before = items.length;
    items = items.filter((i) => !gone.has(i.historyKey));
    total = Math.max(0, total - (before - items.length));
    selected = omit(selected, keys);
    expanded = omit(expanded, keys);
    editing = omit(editing, keys);
    if (focusKey && gone.has(focusKey)) {
      focusKey = items[Math.min(focusIdx, items.length - 1)]?.historyKey ?? null;
      focusRow(focusKey);
    }
  }

  function shiftCounts(from, to, n) {
    if (!counts || !n) return;
    counts = {
      ...counts,
      [from]: Math.max(0, (counts[from] ?? 0) - n),
      [to]: (counts[to] ?? 0) + n,
    };
  }

  /** 操作成功后：原地移除、刷新计数，再静默拉一次补齐本页并校准计数 */
  function afterChange(keys, to, affected) {
    removeKeys(keys);
    shiftCounts(status, to, affected ?? keys.length);
    if (!items.length && page > 0) {
      page -= 1;
      load();
    } else {
      load({ silent: true });
    }
  }

  async function review(keys, action) {
    const res = await historyRequest('/history/facts/review', {
      method: 'POST',
      body: { chatId, action, historyKeys: keys },
    });
    return res.ok && res.data?.ok ? { ok: true, affected: res.data.affected } : { ok: false, error: describeError(res) };
  }

  async function act(item, action) {
    const key = item.historyKey;
    if (busyRow[key] || bulkBusy) return;
    const ep = epoch;
    setBusy([key], action);
    const res = await review([key], action);
    if (ep !== epoch) return;
    clearBusy([key]);
    if (res.ok) {
      afterChange([key], ACTION_TARGET[action], res.affected);
      showNotice('success', `${ACTION_DONE[action]}：${item.meme?.term || '1 条观察'}`);
    } else {
      showNotice('error', `操作失败：${res.error}`);
    }
  }

  async function bulk(action) {
    const keys = [...selectedKeys];
    if (!keys.length || bulkBusy) return;
    if (action === 'reject' && !confirm(`确认拒绝选中的 ${keys.length} 条${kindLabel}？\n拒绝后离线合成不会再写入它们，可以在「已拒绝」里恢复。`)) return;
    const ep = epoch;
    bulkBusy = action;
    setBusy(keys, action);
    const res = await review(keys, action);
    if (ep !== epoch) return;
    bulkBusy = '';
    clearBusy(keys);
    if (res.ok) {
      afterChange(keys, ACTION_TARGET[action], res.affected);
      const n = res.affected ?? keys.length;
      showNotice('success', `${ACTION_DONE[action]} ${n} 条${n < keys.length ? `（选中 ${keys.length} 条，其余已不在原状态）` : ''}`);
    } else {
      showNotice('error', `批量操作失败：${res.error}`);
    }
  }

  async function saveItem(item, payload) {
    const key = item.historyKey;
    const ep = epoch;
    const res = await historyRequest('/history/facts', {
      method: 'PUT',
      body: { chatId, historyKey: key, ...payload },
    });
    if (!(res.ok && res.data?.ok)) {
      return {
        ok: false,
        error: res.status === 400
          ? `保存失败：${typeof res.data?.error === 'string' && res.data.error ? res.data.error : '必填项不能为空'}`
          : describeError(res),
      };
    }
    if (ep === epoch) {
      if (status === 'pending') {
        // 保存即标为已通过，所以会离开待审核列表
        afterChange([key], 'approved', 1);
        showNotice('success', '已保存，并标为已通过（已从待审核移出）');
      } else {
        const updated = res.data.item;
        if (updated?.historyKey === key) items = items.map((i) => (i.historyKey === key ? updated : i));
        load({ silent: true });
        showNotice('success', '已保存');
      }
    }
    return { ok: true };
  }

  // ─── 展开与引用消息 ───
  async function loadEvidence(item, force = false) {
    const key = item.historyKey;
    const cur = evidence[key];
    if (!force && cur && cur.state !== 'error') return;
    const ep = epoch;
    evidence = { ...evidence, [key]: { state: 'loading' } };
    const res = await historyRequest(
      `/history/evidence?chatId=${encodeURIComponent(chatId)}&historyKey=${encodeURIComponent(key)}`,
    );
    if (ep !== epoch) return;
    evidence = {
      ...evidence,
      [key]: res.ok && res.data
        ? { state: 'ok', data: res.data }
        : { state: 'error', error: describeError(res) },
    };
  }

  function toggleExpand(item) {
    const key = item.historyKey;
    const open = !expanded[key];
    expanded = { ...expanded, [key]: open };
    if (open) loadEvidence(item);
  }

  // ─── 选择 ───
  function setSelected(key, on) {
    selected = on ? { ...selected, [key]: true } : omit(selected, [key]);
  }

  function toggleAll() {
    selected = allSelected ? {} : Object.fromEntries(items.map((i) => [i.historyKey, true]));
  }

  // ─── 键盘 ───
  function findRow(key) {
    return key && listEl ? [...listEl.querySelectorAll('[data-hkey]')].find((el) => el.dataset.hkey === key) : null;
  }

  async function focusRow(key) {
    await tick();
    findRow(key)?.focus();
  }

  function moveFocus(delta) {
    if (!items.length) return;
    const idx = items.findIndex((i) => i.historyKey === focusKey);
    const next = idx < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, idx + delta));
    focusKey = items[next].historyKey;
    focusRow(focusKey);
  }

  function onKeydown(e) {
    if (!active || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target instanceof Element ? e.target : null;
    // 输入框、下拉、文本域聚焦时一律不响应；有弹窗时也不响应
    if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (document.querySelector('dialog[open]')) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      kbd = true;
      moveFocus(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    // 焦点在按钮或链接上时，Enter / 空格交给它自己处理
    if (t?.closest('button, a, summary')) return;
    const item = items.find((i) => i.historyKey === focusKey);
    if (!item) return;
    const key = item.historyKey;

    if (e.key === ' ') {
      e.preventDefault();
      kbd = true;
      setSelected(key, !selected[key]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      kbd = true;
      toggleExpand(item);
    } else if (editing[key]) {
      // 正在编辑这一行时不触发通过 / 拒绝，免得丢掉没保存的修改
      return;
    } else if (e.key === 'a' || e.key === 'A') {
      kbd = true;
      if (item.status === 'pending') act(item, 'approve');
      else if (item.status === 'rejected') act(item, 'restore');
    } else if (e.key === 'x' || e.key === 'X') {
      kbd = true;
      if (item.status !== 'rejected') act(item, 'reject');
    }
  }

  function onPointerDown() {
    kbd = false;
  }

  onDestroy(() => {
    unsubPreset();
    clearTimeout(noticeTimer);
    clearTimeout(qTimer);
  });
</script>

<svelte:window onkeydown={onKeydown} onpointerdown={onPointerDown} />

<div class="space-y-3">
  <!-- 工具栏 -->
  <div class="card bg-base-100 scroll-mt-20" bind:this={toolbarEl}>
    <div class="card-body p-3 gap-2">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div class="join" role="group" aria-label="种类">
          {#each KINDS as k}
            <button
              class="btn btn-xs join-item"
              class:btn-primary={kind === k.id}
              aria-pressed={kind === k.id}
              onclick={() => setKind(k.id)}
            >
              <i class="fa-solid {k.icon}"></i>{k.label}
            </button>
          {/each}
        </div>

        <div class="join" role="group" aria-label="状态">
          {#each STATUSES as s}
            <button
              class="btn btn-xs join-item"
              class:btn-primary={status === s.id}
              aria-pressed={status === s.id}
              onclick={() => (status = s.id)}
            >
              {s.label}
              {#if counts}<span class="font-mono tabular-nums opacity-80">{counts[s.id] ?? 0}</span>{/if}
            </button>
          {/each}
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <label class="input input-sm input-bordered flex items-center gap-2 flex-1 min-w-48 sm:flex-none sm:w-72">
          <i class="fa-solid fa-magnifying-glass opacity-50"></i>
          <input
            type="search"
            class="grow min-w-0"
            placeholder={kind === 'meme' ? '搜索原词、含义…' : '搜索观察内容…'}
            aria-label="搜索"
            bind:value={qInput}
            oninput={onSearchInput}
            onkeydown={(e) => e.key === 'Enter' && applySearchNow()}
          />
          {#if qInput}
            <button class="opacity-60 hover:opacity-100" aria-label="清除搜索" title="清除搜索" onclick={clearSearch}>
              <i class="fa-solid fa-xmark"></i>
            </button>
          {/if}
        </label>

        <label class="flex items-center gap-1.5">
          <span class="text-xs opacity-60 shrink-0">排序</span>
          <select class="select select-sm select-bordered w-32" bind:value={sort} aria-label="排序">
            {#each SORTS as s}
              <option value={s.id} disabled={kind !== 'meme' && s.id !== 'recent'}>{s.label}</option>
            {/each}
          </select>
        </label>

        <button
          class="btn btn-xs btn-ghost ml-auto"
          aria-label="刷新列表"
          title="刷新列表"
          disabled={loading}
          onclick={() => load()}
        >
          <i class="fa-solid fa-rotate" class:fa-spin={loading}></i><span class="hidden sm:inline">刷新</span>
        </button>
      </div>
    </div>
  </div>

  <!-- 列表 -->
  <div class="card bg-base-100">
    {#if loadError}
      <div class="p-3 pb-0">
        <div class="alert alert-error py-2 text-xs" role="alert">
          <i class="fa-solid fa-circle-exclamation"></i>
          <span class="min-w-0 break-words">加载失败：{loadError}{items.length ? '（下面是上次加载的内容）' : ''}</span>
          <button class="btn btn-xs" disabled={loading} onclick={() => load()}>重试</button>
        </div>
      </div>
    {/if}

    {#if items.length}
      <div class="hist-bulk" role="toolbar" aria-label="批量操作">
        <label class="flex items-center gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            class="checkbox checkbox-sm checkbox-primary"
            bind:this={allBox}
            checked={allSelected}
            onchange={toggleAll}
            aria-label="全选本页"
          />
          <span>全选本页</span>
        </label>
        <span class="text-xs opacity-70" aria-live="polite">
          {selectedKeys.length ? `已选 ${selectedKeys.length} 条` : `共 ${total} 条`}
          {#if pageCount > 1}· 第 {page + 1} / {pageCount} 页{/if}
        </span>
        <div class="flex flex-wrap gap-2 ml-auto">
          {#if status === 'pending'}
            <button class="btn btn-xs btn-success" disabled={!selectedKeys.length || !!bulkBusy} onclick={() => bulk('approve')}>
              {#if bulkBusy === 'approve'}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-check"></i>{/if}
              批量通过
            </button>
          {:else if status === 'approved'}
            <button class="btn btn-xs" disabled={!selectedKeys.length || !!bulkBusy} onclick={() => bulk('reset')}>
              {#if bulkBusy === 'reset'}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-rotate-left"></i>{/if}
              批量退回待审
            </button>
          {:else}
            <button class="btn btn-xs btn-success" disabled={!selectedKeys.length || !!bulkBusy} onclick={() => bulk('restore')}>
              {#if bulkBusy === 'restore'}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-trash-can-arrow-up"></i>{/if}
              批量恢复
            </button>
          {/if}
          {#if status !== 'rejected'}
            <button class="btn btn-xs btn-error" disabled={!selectedKeys.length || !!bulkBusy} onclick={() => bulk('reject')}>
              {#if bulkBusy === 'reject'}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-xmark"></i>{/if}
              批量拒绝
            </button>
          {/if}
        </div>
      </div>

      <div class="divide-y divide-base-300" bind:this={listEl} role="list" aria-label="{statusLabel}的{kindLabel}">
        {#each items as item (item.historyKey)}
          <div role="listitem">
            <FactRow
              {item}
              selected={!!selected[item.historyKey]}
              expanded={!!expanded[item.historyKey]}
              focused={focusKey === item.historyKey}
              {kbd}
              busy={busyRow[item.historyKey] || ''}
              evidence={evidence[item.historyKey]}
              save={saveItem}
              onselect={(on) => setSelected(item.historyKey, on)}
              ontoggle={() => toggleExpand(item)}
              onact={(a) => act(item, a)}
              onretry={() => loadEvidence(item, true)}
              onfocusrow={() => (focusKey = item.historyKey)}
              oneditchange={(on) => (editing = { ...editing, [item.historyKey]: on })}
            />
          </div>
        {/each}
      </div>

      {#if pageCount > 1}
        <div class="flex items-center justify-center gap-2 p-3 border-t border-base-300">
          <button class="btn btn-xs" disabled={loading || page === 0} aria-label="上一页" onclick={() => goPage(page - 1)}>
            <i class="fa-solid fa-chevron-left"></i>
          </button>
          <span class="text-xs tabular-nums">第 {page + 1} / {pageCount} 页</span>
          <button class="btn btn-xs" disabled={loading || page >= pageCount - 1} aria-label="下一页" onclick={() => goPage(page + 1)}>
            <i class="fa-solid fa-chevron-right"></i>
          </button>
        </div>
      {/if}
      <div class="px-3 pb-2 text-[0.7rem] opacity-50 hidden md:block">
        快捷键：↑ ↓ 移动　A 通过　X 拒绝　空格 勾选　Enter 展开
      </div>
    {:else if loading || !loaded}
      {#if !loadError}
        <div class="p-6 flex items-center justify-center gap-2 text-sm opacity-70">
          <span class="loading loading-spinner loading-sm"></span> 正在加载…
        </div>
      {/if}
    {:else if !loadError}
      <div class="p-6 text-center space-y-3">
        {#if q}
          <div class="text-sm opacity-70">没有匹配「{q}」的{statusLabel}{kindLabel}</div>
          <button class="btn btn-xs" onclick={clearSearch}>清除搜索</button>
        {:else if allZero}
          <div class="text-sm font-semibold">这个会话还没有合成出{kindLabel}</div>
          <p class="text-xs opacity-70">先导入历史记录，再做离线初始化；合成出的条目会出现在这里等待审核。</p>
          <div class="text-left max-w-2xl mx-auto"><ImportCommand chatId={chatId || ''} /></div>
          <button class="btn btn-xs btn-primary" onclick={() => activeHistoryTab.set('h-tasks')}>去「任务进度」</button>
        {:else}
          <div class="text-sm opacity-70">没有{statusLabel}的{kindLabel}</div>
          {#if status === 'pending'}<div class="text-xs opacity-60">全部审完了。</div>{/if}
        {/if}
      </div>
    {/if}
  </div>
</div>

{#if notice}
  <div class="toast toast-end toast-bottom z-50">
    <div
      class="alert py-2 text-xs"
      class:alert-success={notice.type === 'success'}
      class:alert-error={notice.type === 'error'}
      role={notice.type === 'error' ? 'alert' : 'status'}
    >
      <i class="fa-solid {notice.type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check'}"></i>
      <span class="min-w-0 break-words max-w-64">{notice.text}</span>
      {#if notice.type === 'error'}
        <button class="btn btn-xs btn-ghost" aria-label="关闭提示" title="关闭" onclick={() => (notice = null)}>
          <i class="fa-solid fa-xmark"></i>
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .hist-bulk {
    position: sticky;
    top: 4rem;
    z-index: 10;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    padding: 0.5rem 0.75rem;
    background: var(--color-base-100);
    border-bottom: 1px solid color-mix(in srgb, var(--color-base-content) 12%, transparent);
    border-radius: var(--radius-box, 0.5rem) var(--radius-box, 0.5rem) 0 0;
  }
</style>
