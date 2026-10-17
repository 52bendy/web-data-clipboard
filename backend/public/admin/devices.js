/* Device list page (REQ-202610-1262, PRD §4.2). */
(() => {
  const { api, formatTime, clear, textCell, setMessage } = window.DCC;
  const rows = document.getElementById('device-rows');
  const empty = document.getElementById('empty');
  const message = document.getElementById('message');
  const filter = document.getElementById('filter');
  const refresh = document.getElementById('refresh');
  const threshold = document.getElementById('threshold');
  let devices = [];

  function render() {
    const needle = filter.value.trim().toLowerCase();
    const visible = devices.filter(
      (device) =>
        !needle ||
        device.device_id.toLowerCase().includes(needle) ||
        device.device_name.toLowerCase().includes(needle),
    );
    clear(rows);
    for (const device of visible) {
      const tr = document.createElement('tr');
      if (!device.online) tr.className = 'row-offline';
      tr.appendChild(textCell(device.device_id, 'mono'));
      tr.appendChild(textCell(device.device_name));
      tr.appendChild(textCell(device.platform));
      tr.appendChild(textCell(formatTime(device.last_seen)));
      const status = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `badge ${device.online ? 'badge-online' : 'badge-offline'}`;
      badge.textContent = device.online ? '在线' : '离线';
      status.appendChild(badge);
      tr.appendChild(status);
      rows.appendChild(tr);
    }
    empty.hidden = visible.length !== 0;
  }

  async function load() {
    refresh.disabled = true;
    try {
      const payload = await api('/api/admin/devices');
      devices = payload.data.devices || [];
      document.getElementById('stat-total').textContent = payload.data.stats.total;
      document.getElementById('stat-online').textContent = payload.data.stats.online;
      document.getElementById('stat-offline').textContent = payload.data.stats.offline;
      const thresholdMs = payload.data.stats.online_threshold_ms;
      threshold.textContent = `在线阈值：${Math.round(thresholdMs / 60000)} 分钟`;
      setMessage(message, '');
      render();
    } catch (error) {
      setMessage(message, error.message, 'error');
    } finally {
      refresh.disabled = false;
    }
  }

  filter.addEventListener('input', render);
  refresh.addEventListener('click', load);
  load();
  setInterval(load, 15000);
})();
