/**
 * history.js — 「历史导入」面板的请求与展示辅助
 *
 * api() 只返回 res.json()，拿不到 202 / 400 / 409，所以这里单独包一层带状态码的请求；
 * api() 本身保持不变，不影响其它面板。
 */

import { apiBase } from './api.js';
import { historyOverview } from './stores.js';
import { shortId } from './utils.js';

/**
 * @param {string} path  例如 '/history/overview'
 * @param {{ method?: string, body?: object }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, data: any }>}  网络失败时 status 为 0
 */
export async function historyRequest(path, opts = {}) {
  try {
    const res = await fetch(apiBase(path), {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/** 把失败的响应转成一句可读的中文 */
export function describeError(res) {
  if (res.status === 0) return '网络请求失败，请检查与服务的连接';
  if (res.status === 401 || res.status === 403) return '鉴权失败，请检查 URL 中的 token';
  const code = res.data?.error;
  if (code === 'private_consent_required') return '这是私聊或敏感会话，需要先勾选同意才能把内容发送给模型';
  if (typeof code === 'string' && code) return `请求失败（${res.status}）：${code}`;
  return `请求失败（HTTP ${res.status}）`;
}

// ─── Overview 刷新：同一时刻最多一个请求在途 ───
let inflight = null;
let rerun = false;

/**
 * @param {{ queue?: boolean }} [opts]  queue 为 true 时，若已有请求在途则等它回来后再补一次
 *   （用于开始 / 停止之后要尽快看到新状态）；默认直接跳过本次，供定时轮询使用
 */
export function refreshHistoryOverview({ queue = false } = {}) {
  if (inflight) {
    if (queue) rerun = true;
    return inflight;
  }
  inflight = (async () => {
    const res = await historyRequest('/history/overview');
    if (res.ok && res.data && Array.isArray(res.data.chats)) {
      historyOverview.set({
        loaded: true,
        error: '',
        runner: res.data.runner ?? null,
        chats: res.data.chats,
      });
    } else {
      historyOverview.update(o => ({ ...o, error: describeError(res) }));
    }
  })().finally(() => {
    inflight = null;
    if (rerun) {
      rerun = false;
      refreshHistoryOverview();
    }
  });
  return inflight;
}

// ─── 展示辅助 ───

export function chatLabel(chat) {
  if (!chat) return '';
  return chat.chatTitle || shortId(chat.chatId);
}

export function modeLabel(mode) {
  return mode === 'full' ? '完整' : mode === 'quick' ? '快速' : (mode || '');
}

export function formatTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

export function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString();
}

export function formatCount(n) {
  return Number(n ?? 0).toLocaleString();
}

const INIT_STATUS = {
  running: { label: '运行中', badge: 'badge-info', icon: 'fa-spinner fa-spin' },
  paused: { label: '已暂停', badge: 'badge-warning', icon: 'fa-circle-pause' },
  stale: { label: '已中断', badge: 'badge-error', icon: 'fa-triangle-exclamation' },
  done: { label: '已完成', badge: 'badge-success', icon: 'fa-circle-check' },
  none: { label: '未开始', badge: 'badge-ghost', icon: 'fa-circle' },
};

/**
 * 初始化状态：进程内运行器正在跑这个会话时一律算「运行中」，
 * 否则取库里最近一次任务的状态（命令行启动的任务也在这里体现）。
 */
export function initStatusKey(chat, runner) {
  if (!chat) return 'none';
  if (runner?.running?.chatId === chat.chatId) return 'running';
  const s = chat.initJob?.status;
  return s && INIT_STATUS[s] ? s : 'none';
}

export function initStatusMeta(key) {
  return INIT_STATUS[key] || INIT_STATUS.none;
}

const IMPORT_STATUS = {
  done: { label: '已完成', badge: 'badge-success' },
  running: { label: '进行中', badge: 'badge-info' },
  paused: { label: '已暂停', badge: 'badge-warning' },
  failed: { label: '失败', badge: 'badge-error' },
  error: { label: '失败', badge: 'badge-error' },
};

export function importStatusMeta(status) {
  return IMPORT_STATUS[status] || { label: status || '未知', badge: 'badge-ghost' };
}

/** 导入 + 初始化的命令行示例（导入本身要先把文件放到服务器上，面板只展示结果） */
export function importCommandExample(chatId) {
  return [
    '# 1. 导入 QCE 导出（先加 --dry-run 预检，确认无误后去掉）',
    'pnpm qce-import /path/to/qce-export --timezone Asia/Shanghai --dry-run',
    '',
    '# 2. 离线初始化（也可以直接在面板里点「快速初始化」）',
    `pnpm history-init --chat-id ${chatId || '<chatId>'} --mode quick`,
  ].join('\n');
}

/** 复制文本；非 https 的内网访问没有 navigator.clipboard，退回 execCommand */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 走回退 */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
