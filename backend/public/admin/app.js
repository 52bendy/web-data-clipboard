/* Shared helpers for the zero-build admin pages (REQ-202610-1262). */
(() => {
  const csrfToken =
    document.querySelector('meta[name="csrf-token"]')?.content || '';

  async function api(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }
    if (!['GET', 'HEAD'].includes(method)) {
      headers['x-csrf-token'] = csrfToken;
    }
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      method,
      headers,
    });
    if (response.status === 401) {
      const next = `${location.pathname}${location.search}`;
      location.href = `/admin/login?next=${encodeURIComponent(next)}`;
      throw new Error('登录状态已失效，请重新登录。');
    }
    const payload = await response.json().catch(() => ({
      code: response.status,
      message: '响应格式不正确。',
      data: null,
    }));
    if (!response.ok) {
      const error = new Error(payload.message || '请求失败。');
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function textCell(value, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = value === null || value === undefined ? '—' : String(value);
    return td;
  }

  function setMessage(node, message, kind = 'info') {
    node.textContent = message;
    node.className = `alert alert-${kind}`;
    node.hidden = !message;
  }

  window.DCC = { api, formatTime, clear, textCell, setMessage, csrfToken };
})();
