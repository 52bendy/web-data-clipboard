/**
 * Admin dashboard controller (REQ-202610-1261, PRD §4.2).
 *
 * Polls the session-protected `/api/admin/dashboard` aggregate, renders the
 * three stat cards and the live clipboard card, and keeps the copy button
 * usable in both secure contexts (Clipboard API) and plain-HTTP deployments
 * (execCommand fallback). No dynamic value is ever written through innerHTML.
 */
(() => {
  'use strict';

  const root = document.getElementById('dashboard');
  if (!root) return;

  const configured = Number(root.dataset.refreshInterval);
  const refreshMs =
    Number.isFinite(configured) && configured >= 3000
      ? Math.min(configured, 300000)
      : 15000;

  const els = {
    status: document.getElementById('refresh-status'),
    intervalLabel: document.getElementById('refresh-interval-label'),
    refresh: document.getElementById('refresh-button'),
    manualRefresh: document.getElementById('manual-refresh'),
    collected: document.getElementById('stat-collected'),
    extracted: document.getElementById('stat-extracted'),
    devices: document.getElementById('stat-devices'),
    apiWrites: document.getElementById('stat-api-writes'),
    statDate: document.getElementById('stat-date'),
    card: document.getElementById('clipboard-card'),
    badge: document.getElementById('clipboard-state-badge'),
    content: document.getElementById('clipboard-content'),
    empty: document.getElementById('clipboard-empty'),
    expired: document.getElementById('clipboard-expired'),
    expiredText: document.getElementById('clipboard-expired-text'),
    error: document.getElementById('clipboard-error'),
    copy: document.getElementById('copy-button'),
    copyFeedback: document.getElementById('copy-feedback'),
    meta: document.getElementById('clipboard-meta'),
    project: document.getElementById('meta-project'),
    label: document.getElementById('meta-label'),
    collector: document.getElementById('meta-collector'),
    namespace: document.getElementById('meta-namespace'),
    device: document.getElementById('meta-device'),
    platform: document.getElementById('meta-platform'),
    received: document.getElementById('meta-received'),
    expires: document.getElementById('meta-expires'),
    raw: document.getElementById('raw-text'),
    rawText: document.getElementById('clipboard-raw'),
  };

  let refreshTimer = null;
  let countdownTimer = null;
  let inFlight = false;
  let copyValue = '';
  let expiresAt = 0;
  let expiryRefreshRequested = false;
  let copyFeedbackTimer = null;

  els.intervalLabel.textContent = String(Math.round(refreshMs / 1000));

  function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString('zh-CN') : '—';
  }

  function formatTime(ms) {
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function formatDateTime(ms) {
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.ceil(totalSeconds));
    if (seconds >= 60) {
      const minutes = Math.floor(seconds / 60);
      return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
    }
    return `${seconds} 秒`;
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  function setBadge(state, label) {
    els.badge.dataset.state = state;
    els.badge.textContent = label;
  }

  function setCardState(state) {
    els.card.dataset.state = state;
  }

  function hideClipboardBlocks() {
    els.content.hidden = true;
    els.empty.hidden = true;
    els.expired.hidden = true;
    els.error.hidden = true;
    els.meta.hidden = true;
    els.raw.hidden = true;
  }

  function renderStats(stats = {}) {
    els.collected.textContent = formatNumber(stats.today_collected);
    els.extracted.textContent = formatNumber(stats.today_extracted);
    els.devices.textContent = formatNumber(stats.bound_devices);
    els.apiWrites.textContent = formatNumber(stats.today_api_writes);
    els.statDate.textContent = stats.date || '—';
  }

  function renderClipboard(data) {
    const clipboard = data.clipboard;
    const state =
      data.clipboard_state || (clipboard ? 'active' : 'empty');

    hideClipboardBlocks();
    copyValue = '';
    expiresAt = 0;
    expiryRefreshRequested = false;
    els.copy.disabled = true;
    els.copyFeedback.textContent = '';

    if (state === 'active' && clipboard) {
      setCardState('active');
      setBadge('active', '有效');
      els.content.textContent = clipboard.content || clipboard.raw_text || '';
      els.content.hidden = false;

      els.project.textContent = clipboard.source_project || 'unknown';
      els.label.textContent = clipboard.source_label || 'unknown';
      els.collector.textContent = clipboard.collector || 'unknown';
      els.namespace.textContent = clipboard.namespace || 'default';
      els.device.textContent = clipboard.source_device || 'unknown';
      els.platform.textContent = clipboard.platform || 'unknown';
      els.received.textContent = formatDateTime(clipboard.updated_at);
      els.expires.textContent = formatDuration(
        Number(clipboard.expire_in_seconds) || 0,
      );
      els.meta.hidden = false;

      els.rawText.textContent = clipboard.raw_text || '';
      els.raw.hidden = !clipboard.raw_text;

      copyValue = clipboard.content || clipboard.raw_text || '';
      els.copy.disabled = copyValue.length === 0;

      expiresAt =
        Date.now() + Math.max(0, Number(clipboard.expire_in_seconds) || 0) * 1000;
      return;
    }

    if (state === 'expired') {
      setCardState('expired');
      setBadge('expired', '已过期');
      els.expiredText.textContent = data.clipboard_expired_at
        ? `上一条内容已于 ${formatDateTime(
            data.clipboard_expired_at,
          )} 过期并被清除，等待新的采集或写入。`
        : '上一条内容已超过有效期并被清除，等待新的采集或写入。';
      els.expired.hidden = false;
      return;
    }

    setCardState('empty');
    setBadge('empty', '空');
    els.empty.hidden = false;
  }

  function renderError() {
    hideClipboardBlocks();
    setCardState('error');
    setBadge('error', '加载失败');
    els.error.hidden = false;
    els.copy.disabled = true;
    copyValue = '';
  }

  function updateCountdown() {
    if (!expiresAt) return;
    const remainingSeconds = (expiresAt - Date.now()) / 1000;
    els.expires.textContent = formatDuration(remainingSeconds);
    if (remainingSeconds <= 0 && !expiryRefreshRequested) {
      expiryRefreshRequested = true;
      refresh();
    }
  }

  async function refresh({ manual = false } = {}) {
    if (inFlight) return;
    inFlight = true;
    setStatus(manual ? '正在刷新…' : '自动刷新中…');
    try {
      const response = await fetch('/api/admin/dashboard', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (response.status === 401) {
        window.location.href = `/admin/login?next=${encodeURIComponent(
          '/admin',
        )}`;
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!body || body.code !== 200 || !body.data) {
        throw new Error('Invalid dashboard payload');
      }
      renderStats(body.data.stats);
      renderClipboard(body.data);
      setStatus(`已更新 ${formatTime(body.data.refreshed_at || Date.now())}`);
    } catch {
      renderError();
      setStatus('刷新失败，请稍后重试');
    } finally {
      inFlight = false;
    }
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    document.body.removeChild(textarea);
    return copied;
  }

  async function copyClipboard() {
    if (!copyValue) return;
    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(copyValue);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) copied = fallbackCopy(copyValue);

    els.copyFeedback.textContent = copied
      ? '已复制到剪贴板'
      : '复制失败，请手动选择内容';
    els.copyFeedback.style.color = copied ? '' : '#b91c1c';
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = setTimeout(() => {
      els.copyFeedback.textContent = '';
    }, 2500);
  }

  function startRefreshTimer() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!document.hidden) refresh();
    }, refreshMs);
  }

  els.refresh.addEventListener('click', () => refresh({ manual: true }));
  els.manualRefresh.addEventListener('click', () => refresh({ manual: true }));
  els.copy.addEventListener('click', copyClipboard);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  countdownTimer = setInterval(updateCountdown, 1000);
  window.addEventListener('pagehide', () => {
    if (refreshTimer) clearInterval(refreshTimer);
    if (countdownTimer) clearInterval(countdownTimer);
  });

  refresh();
  startRefreshTimer();
})();
