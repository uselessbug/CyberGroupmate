<script>
  import { onDestroy } from 'svelte';
  import { importCommandExample, copyText } from '../../lib/history.js';

  export let chatId = '';

  let copied = false;
  let failed = false;
  let timer;

  $: command = importCommandExample(chatId);

  async function copy() {
    const ok = await copyText(command);
    copied = ok;
    failed = !ok;
    clearTimeout(timer);
    timer = setTimeout(() => { copied = false; failed = false; }, 2000);
  }

  onDestroy(() => clearTimeout(timer));
</script>

<div class="relative">
  <pre class="bg-base-200 rounded-lg p-3 pr-20 text-xs font-mono overflow-x-auto whitespace-pre" tabindex="0" aria-label="导入命令示例">{command}</pre>
  <button
    class="btn btn-xs absolute top-2 right-2"
    class:btn-success={copied}
    class:btn-ghost={!copied}
    aria-label="复制命令"
    title="复制命令"
    onclick={copy}
  >
    <i class="fa-solid {copied ? 'fa-check' : failed ? 'fa-triangle-exclamation' : 'fa-copy'}"></i>
    <span aria-live="polite">{copied ? '已复制' : failed ? '复制失败' : '复制'}</span>
  </button>
</div>
