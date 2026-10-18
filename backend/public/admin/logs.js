/* Collection log board (REQ-202610-1262, PRD §4.2). */
(() => {
  const { api, formatTime, clear, textCell, setMessage } = window.DCC;
  const rows = document.getElementById('log-rows');
  const empty = document.getElementById('empty');
  const message = document.getElementById('message');
  const pageInfo = document.getElementById('page-info');
  const prev = document.getElementById('prev');
  const next = document.getElementById('next');
  const form = document.getElementById('filters');
  let page = 1;
  let totalPages = 0;

  function query() {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('page_size', document.getElementById('page-size').value);
    const device = document.getElementById('device').value.trim();
    const collector = document.getElementById('collector').value;
    const project = document.getElementById('project').value.trim();
    const source = document.getElementById('source').value.trim();
    const namespace = document.getElementById('namespace').value.trim();
    const date = document.getElementById('date').value;
    const keyword = document.getElementById('keyword').value.trim();
    if (device) params.set('device', device);
    if (collector) params.set('collector', collector);
    if (project) params.set('project', project);
    if (source) params.set('source', source);
    if (namespace) params.set('namespace', namespace);
    if (date) params.set('date', date);
    if (keyword) params.set('keyword', keyword);
    if (document.getElementById('show-raw').checked) params.set('mask', '0');
    return params;
  }

  function render(payload) {
    clear(rows);
    for (const entry of payload.items) {
      const tr = document.createElement('tr');
      tr.appendChild(textCell(formatTime(entry.received_at)));

      // Source label: project (primary), human label (secondary) and the
      // collector badge. All values are written via textContent.
      const source = document.createElement('td');
      const project = document.createElement('span');
      project.className = 'mono';
      project.textContent = entry.source_project || 'unknown';
      source.appendChild(project);
      const label = document.createElement('span');
      label.className = 'muted small block';
      label.textContent = entry.source_label || 'unknown';
      source.appendChild(label);
      const collector = document.createElement('span');
      collector.className = 'badge';
      collector.textContent = entry.collector || 'sms';
      source.appendChild(collector);
      tr.appendChild(source);

      tr.appendChild(textCell(entry.namespace || 'default', 'mono'));
      const device = document.createElement('td');
      device.className = 'mono';
      device.textContent = entry.device_id;
      const name = document.createElement('span');
      name.className = 'muted small block';
      name.textContent = entry.device_name;
      device.appendChild(name);
      tr.appendChild(device);
      tr.appendChild(textCell(entry.platform));
      tr.appendChild(textCell(entry.sender, 'mono'));
      tr.appendChild(textCell(entry.raw_content, 'content-cell'));
      tr.appendChild(textCell(entry.extracted_code, 'mono'));
      const status = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = entry.status;
      status.appendChild(badge);
      tr.appendChild(status);
      rows.appendChild(tr);
    }
    empty.hidden = payload.items.length !== 0;
    totalPages = payload.total_pages;
    pageInfo.textContent = `第 ${payload.page} / ${Math.max(payload.total_pages, 1)} 页 · 共 ${payload.total} 条`;
    prev.disabled = payload.page <= 1;
    next.disabled = payload.page >= payload.total_pages;
  }

  async function load() {
    setMessage(message, '');
    try {
      const payload = await api(`/api/admin/logs?${query().toString()}`);
      render(payload.data);
    } catch (error) {
      setMessage(message, error.message, 'error');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    page = 1;
    load();
  });
  document.getElementById('reset').addEventListener('click', () => {
    form.reset();
    page = 1;
    load();
  });
  prev.addEventListener('click', () => {
    if (page > 1) {
      page -= 1;
      load();
    }
  });
  next.addEventListener('click', () => {
    if (page < totalPages) {
      page += 1;
      load();
    }
  });
  load();
})();
