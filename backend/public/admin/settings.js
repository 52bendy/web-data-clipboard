/* Settings panel (REQ-202610-1262, PRD §4.2 / §8.2). */
(() => {
  const { api, setMessage } = window.DCC;
  const message = document.getElementById('message');
  const form = document.getElementById('settings-form');
  const autoExtract = document.getElementById('auto-extract');
  const maskSender = document.getElementById('mask-sender');
  const webhookUrl = document.getElementById('webhook-url');
  const updatedAt = document.getElementById('updated-at');
  const tokenMasked = document.getElementById('token-masked');
  const modal = document.getElementById('reset-modal');
  const resetError = document.getElementById('reset-error');
  const confirmInput = document.getElementById('reset-confirm');
  const tokenResult = document.getElementById('token-result');
  const newToken = document.getElementById('new-token');

  function apply(settings) {
    autoExtract.checked = settings.auto_extract;
    maskSender.checked = settings.mask_sender;
    webhookUrl.value = settings.webhook_url || '';
    tokenMasked.textContent = settings.token_masked || '未配置';
    updatedAt.textContent = settings.updated_at
      ? `最后更新：${new Date(settings.updated_at).toLocaleString('zh-CN', { hour12: false })}`
      : '';
  }

  async function load() {
    try {
      const payload = await api('/api/admin/settings');
      apply(payload.data);
    } catch (error) {
      setMessage(message, error.message, 'error');
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage(message, '');
    try {
      const payload = await api('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          auto_extract: autoExtract.checked,
          mask_sender: maskSender.checked,
          webhook_url: webhookUrl.value.trim(),
        }),
      });
      apply(payload.data);
      setMessage(message, '设置已保存并立即生效。', 'success');
    } catch (error) {
      setMessage(message, error.message, 'error');
    }
  });

  function openModal() {
    confirmInput.value = '';
    resetError.hidden = true;
    modal.hidden = false;
    confirmInput.focus();
  }

  function closeModal() {
    modal.hidden = true;
  }

  document.getElementById('open-reset').addEventListener('click', openModal);
  document.getElementById('cancel-reset').addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });

  document.getElementById('confirm-reset').addEventListener('click', async () => {
    if (confirmInput.value.trim() !== 'RESET') {
      resetError.textContent = '请输入 RESET 以确认。';
      resetError.hidden = false;
      return;
    }
    try {
      const payload = await api('/api/admin/token/reset', {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      });
      closeModal();
      tokenResult.hidden = false;
      newToken.textContent = payload.data.token;
      tokenMasked.textContent = payload.data.token_masked;
      setMessage(message, 'Token 已重置，旧 Token 已失效。', 'success');
    } catch (error) {
      resetError.textContent = error.message;
      resetError.hidden = false;
    }
  });

  document.getElementById('copy-token').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(newToken.textContent);
      setMessage(message, '新 Token 已复制到剪贴板。', 'success');
    } catch {
      setMessage(message, '复制失败，请手动选择文本复制。', 'error');
    }
  });

  load();
})();
