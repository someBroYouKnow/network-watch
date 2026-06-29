const state = {
  requests: new Map(),
  order: [],
  selectedId: null,
  filterText: '',
  filterType: 'all',
  errorsOnly: false,
  connected: false,
  totalBytes: 0,
  startTime: null,
  currentTargetLabel: '',
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const elHost = $('#inp-host');
const elPort = $('#inp-port');
const elRefresh = $('#btn-refresh');
const elTarget = $('#sel-target');
const elAttach = $('#btn-attach');
const elDetach = $('#btn-detach');
const elStatus = $('#status-badge');
const elClear = $('#btn-clear');
const elExport = $('#btn-export');
const elFilter = $('#inp-filter');
const elErrorsOnly = $('#chk-errors-only');
const elReqCount = $('#req-count');
const elTbody = $('#request-tbody');
const elEmpty = $('#empty-state');
const elDetailEmpty = $('#detail-empty');
const elDetailContent = $('#detail-content');
const elPaneHeaders = $('#pane-headers');
const elPaneReqBody = $('#pane-request-body');
const elPaneRespBody = $('#pane-response-body');
const elPaneTiming = $('#pane-timing');
const elPaneRaw = $('#pane-raw');
const elSbRequests = $('#sb-requests');
const elSbSize = $('#sb-size');
const elSbTarget = $('#sb-target');
const elModalOverlay = $('#modal-overlay');
const elModalClose = $('#modal-close');
const elDetailPanel = $('#detail-panel');
const elResizeHandle = $('#resize-handle');

const elToast = document.createElement('div');
elToast.id = 'toast';
document.body.appendChild(elToast);

function showHelpModal() {
  elModalOverlay.hidden = false;
  elModalOverlay.classList.remove('is-hidden');
  elModalOverlay.setAttribute('aria-hidden', 'false');
}

function hideHelpModal() {
  elModalOverlay.hidden = true;
  elModalOverlay.classList.add('is-hidden');
  elModalOverlay.setAttribute('aria-hidden', 'true');
}

function showToast(msg, duration = 2500) {
  elToast.textContent = msg;
  elToast.classList.add('show');
  window.setTimeout(() => elToast.classList.remove('show'), duration);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

function formatMs(ms) {
  if (ms == null || Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}

function statusClass(code) {
  if (!code) return 'status-pending';
  if (code === 'ERR') return 'status-error';
  if (code < 300) return 'status-2xx';
  if (code < 400) return 'status-3xx';
  if (code < 500) return 'status-4xx';
  return 'status-5xx';
}

function methodClass(method = '') {
  const known = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
  return known.includes(method) ? `method-${method}` : 'method-OTHER';
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function tryPrettyJson(text) {
  if (!text) return '';
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function parseUrlParts(url) {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname + u.search + u.hash };
  } catch {
    return { host: '', path: url || '' };
  }
}

function requestDuration(req) {
  if (req.startedAt == null || req.finishedAt == null) return null;
  return (req.finishedAt - req.startedAt) * 1000;
}

function getOrCreateRequest(requestId) {
  let req = state.requests.get(requestId);
  if (!req) {
    req = {
      id: requestId,
      method: '',
      url: '',
      status: null,
      statusText: '',
      resourceType: 'Other',
      requestHeaders: {},
      responseHeaders: {},
      requestExtraHeaders: {},
      responseExtraHeaders: {},
      postData: null,
      mimeType: '',
      protocol: '',
      fromCache: false,
      encodedDataLength: 0,
      startedAt: null,
      finishedAt: null,
      failed: false,
      errorText: '',
      timing: null,
      initiator: null,
      wsFrames: [],
      bodyCache: null,
      bodyBase64: false,
    };
    state.requests.set(requestId, req);
    state.order.push(requestId);
  }
  return req;
}

function applyNetworkEvent(ev) {
  const req = getOrCreateRequest(ev.requestId);
  if (ev.type === 'request') {
    req.method = ev.method;
    req.url = ev.url;
    req.resourceType = ev.resourceType || req.resourceType;
    req.requestHeaders = ev.headers || {};
    req.postData = ev.postData || null;
    req.startedAt = ev.timestamp ?? req.startedAt;
    req.wallTime = ev.wallTime;
    req.initiator = ev.initiator || null;
    if (!state.startTime) state.startTime = ev.timestamp;
  } else if (ev.type === 'request-extra') {
    req.requestExtraHeaders = ev.headers || {};
  } else if (ev.type === 'response') {
    req.status = ev.status;
    req.statusText = ev.statusText;
    req.responseHeaders = ev.headers || {};
    req.mimeType = ev.mimeType || '';
    req.protocol = ev.protocol || '';
    req.fromCache = ev.fromCache;
    req.remoteIPAddress = ev.remoteIPAddress;
    req.remotePort = ev.remotePort;
    req.timing = ev.timing;
    req.resourceType = ev.resourceType || req.resourceType;
  } else if (ev.type === 'response-extra') {
    req.responseExtraHeaders = ev.headers || {};
    if (!req.status && ev.statusCode) req.status = ev.statusCode;
    req.headersText = ev.headersText;
  } else if (ev.type === 'finished') {
    req.finishedAt = ev.timestamp;
    req.encodedDataLength = ev.encodedDataLength || 0;
  } else if (ev.type === 'failed') {
    req.finishedAt = ev.timestamp;
    req.failed = true;
    req.status = 'ERR';
    req.errorText = ev.errorText || ev.blockedReason || 'Failed';
  } else if (ev.type === 'ws-created') {
    req.url = ev.url;
    req.method = 'WS';
    req.resourceType = 'WebSocket';
    req.initiator = ev.initiator || null;
  } else if (ev.type === 'ws-sent' || ev.type === 'ws-received') {
    req.resourceType = 'WebSocket';
    req.wsFrames.push({ direction: ev.type === 'ws-sent' ? 'sent' : 'received', timestamp: ev.timestamp, opcode: ev.opcode, payload: ev.payload });
  }
  recalculateTotals();
  renderList();
  if (state.selectedId === ev.requestId) renderDetails();
}

function recalculateTotals() {
  state.totalBytes = Array.from(state.requests.values()).reduce((sum, req) => sum + (req.encodedDataLength || 0), 0);
}

function filteredRequests() {
  const q = state.filterText.trim().toLowerCase();
  return state.order.map(id => state.requests.get(id)).filter(req => {
    if (!req) return false;
    if (state.filterType !== 'all' && req.resourceType !== state.filterType) return false;
    if (state.errorsOnly && !(req.failed || (typeof req.status === 'number' && req.status >= 400))) return false;
    if (!q) return true;
    return [req.url, req.method, req.status, req.resourceType, req.mimeType].some(v => String(v ?? '').toLowerCase().includes(q));
  });
}

function renderList() {
  const rows = filteredRequests();
  elTbody.innerHTML = rows.map(req => {
    const { host, path } = parseUrlParts(req.url);
    const status = req.status || '…';
    const dur = requestDuration(req);
    return `<tr data-id="${escapeHtml(req.id)}" class="${state.selectedId === req.id ? 'selected' : ''}">
      <td><span class="status-pill ${statusClass(req.status)}">${escapeHtml(status)}</span></td>
      <td><span class="method-pill ${methodClass(req.method)}">${escapeHtml(req.method || '—')}</span></td>
      <td><span class="type-pill">${escapeHtml(req.resourceType || 'Other')}</span></td>
      <td title="${escapeHtml(req.url)}"><span class="url-host">${escapeHtml(host)}</span>${escapeHtml(path)}</td>
      <td>${escapeHtml(formatBytes(req.encodedDataLength))}</td>
      <td>${escapeHtml(formatMs(dur))}</td>
    </tr>`;
  }).join('');
  elEmpty.hidden = state.order.length > 0;
  elReqCount.textContent = `${rows.length} request${rows.length === 1 ? '' : 's'}`;
  elSbRequests.textContent = `${state.order.length} request${state.order.length === 1 ? '' : 's'}`;
  elSbSize.textContent = `${formatBytes(state.totalBytes)} transferred`;
}

function headersTable(headers = {}) {
  const entries = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return '<p class="k">No headers captured.</p>';
  return `<table class="headers-table"><tbody>${entries.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</tbody></table>`;
}

function renderDetails() {
  const req = state.requests.get(state.selectedId);
  if (!req) {
    elDetailEmpty.hidden = false;
    elDetailContent.hidden = true;
    return;
  }
  elDetailEmpty.hidden = true;
  elDetailContent.hidden = false;

  const url = escapeHtml(req.url || '');
  elPaneHeaders.innerHTML = `<div class="section"><h3>General</h3><div class="kv">
    <div class="k">Request URL</div><div class="v">${url}</div>
    <div class="k">Method</div><div>${escapeHtml(req.method || '—')}</div>
    <div class="k">Status</div><div><span class="${statusClass(req.status)}">${escapeHtml(req.status || 'Pending')}</span> ${escapeHtml(req.statusText || req.errorText || '')}</div>
    <div class="k">Resource Type</div><div>${escapeHtml(req.resourceType || 'Other')}</div>
    <div class="k">Protocol</div><div>${escapeHtml(req.protocol || '—')}</div>
    <div class="k">Remote Address</div><div>${escapeHtml(req.remoteIPAddress ? `${req.remoteIPAddress}:${req.remotePort || ''}` : '—')}</div>
    <div class="k">From Cache</div><div>${req.fromCache ? 'Yes' : 'No'}</div>
    <div class="k">Transferred</div><div>${escapeHtml(formatBytes(req.encodedDataLength))}</div>
    <div class="k">Duration</div><div>${escapeHtml(formatMs(requestDuration(req)))}</div>
  </div></div>
  <div class="section"><h3>Request Headers</h3>${headersTable({ ...req.requestHeaders, ...req.requestExtraHeaders })}</div>
  <div class="section"><h3>Response Headers</h3>${headersTable({ ...req.responseHeaders, ...req.responseExtraHeaders })}</div>`;

  elPaneReqBody.innerHTML = req.postData ? `<pre>${escapeHtml(tryPrettyJson(req.postData))}</pre>` : '<p class="k">No request body captured.</p>';
  renderResponseBodyPane(req);
  renderTimingPane(req);
  elPaneRaw.innerHTML = `<pre>${escapeHtml(JSON.stringify(req, null, 2))}</pre>`;
}

function renderResponseBodyPane(req) {
  const frames = req.wsFrames.length ? `<div class="section"><h3>WebSocket Frames</h3><pre>${escapeHtml(req.wsFrames.map(f => `[${f.direction}] opcode=${f.opcode} ${f.payload}`).join('\n'))}</pre></div>` : '';
  if (req.bodyCache != null) {
    const body = req.bodyBase64 ? `[base64 encoded]\n${req.bodyCache}` : tryPrettyJson(req.bodyCache);
    elPaneRespBody.innerHTML = `${frames}<pre>${escapeHtml(body)}</pre>`;
    return;
  }
  if (req.failed) {
    elPaneRespBody.innerHTML = `${frames}<p class="k">Request failed: ${escapeHtml(req.errorText)}</p>`;
    return;
  }
  elPaneRespBody.innerHTML = `${frames}<div class="body-actions"><button id="btn-load-body" class="btn btn-secondary">Load response body</button></div><p class="k">Bodies are fetched on demand after the request finishes.</p>`;
  const btn = $('#btn-load-body');
  if (btn) btn.addEventListener('click', () => loadResponseBody(req.id));
}

async function loadResponseBody(requestId) {
  const req = state.requests.get(requestId);
  if (!req) return;
  const result = await window.cdp.getResponseBody({ requestId });
  if (!result.ok) {
    showToast(result.error || 'Could not load body');
    elPaneRespBody.innerHTML = `<p class="k">${escapeHtml(result.error || 'Could not load body')}</p>`;
    return;
  }
  req.bodyCache = result.body;
  req.bodyBase64 = result.base64Encoded;
  renderDetails();
}

function renderTimingPane(req) {
  const dur = requestDuration(req);
  const timing = req.timing || {};
  const phases = [
    ['DNS', timing.dnsStart, timing.dnsEnd],
    ['Connect', timing.connectStart, timing.connectEnd],
    ['SSL', timing.sslStart, timing.sslEnd],
    ['Send', timing.sendStart, timing.sendEnd],
    ['Wait', timing.sendEnd, timing.receiveHeadersEnd],
  ].filter(([, s, e]) => s >= 0 && e >= 0 && e >= s);
  const max = Math.max(...phases.map(([, , e]) => e), 1);
  const phaseHtml = phases.map(([name, s, e]) => `<div class="timeline-row"><div class="k">${escapeHtml(name)}</div><div class="bar"><span style="margin-left:${(s / max) * 100}%;width:${Math.max(((e - s) / max) * 100, 1)}%"></span></div><div>${escapeHtml(formatMs(e - s))}</div></div>`).join('');
  elPaneTiming.innerHTML = `<div class="section"><h3>Summary</h3><div class="kv"><div class="k">Started</div><div>${escapeHtml(req.wallTime ? new Date(req.wallTime * 1000).toLocaleString() : '—')}</div><div class="k">Total</div><div>${escapeHtml(formatMs(dur))}</div><div class="k">Encoded Size</div><div>${escapeHtml(formatBytes(req.encodedDataLength))}</div></div></div><div class="section"><h3>Phases</h3>${phaseHtml || '<p class="k">No detailed timing available.</p>'}</div>`;
}

async function scanTargets() {
  const host = elHost.value.trim() || 'localhost';
  const port = Number(elPort.value || 9222);
  elRefresh.disabled = true;
  elTarget.disabled = true;
  elAttach.disabled = true;
  elTarget.innerHTML = '<option value="">Scanning…</option>';
  const res = await window.cdp.listTargets({ host, port });
  elRefresh.disabled = false;
  if (!res.ok) {
    setStatus('error', 'No browser');
    elTarget.innerHTML = '<option value="">No targets found</option>';
    showToast(`Could not connect to ${host}:${port}. Open help for launch flags.`, 5000);
    showHelpModal();
    return;
  }
  if (!res.targets.length) {
    elTarget.innerHTML = '<option value="">No page tabs found</option>';
    showToast('Connected, but no page tabs were available.');
    return;
  }
  elTarget.innerHTML = res.targets.map(t => `<option value="${escapeHtml(t.id)}" title="${escapeHtml(t.url)}">${escapeHtml(t.title)} — ${escapeHtml(t.url)}</option>`).join('');
  elTarget.disabled = false;
  elAttach.disabled = false;
  setStatus('idle', 'Ready');
  showToast(`Found ${res.targets.length} tab${res.targets.length === 1 ? '' : 's'}`);
}

async function attachSelected() {
  if (!elTarget.value) return;
  const opt = elTarget.selectedOptions[0];
  const res = await window.cdp.attachTarget({ host: elHost.value.trim() || 'localhost', port: Number(elPort.value || 9222), targetId: elTarget.value });
  if (!res.ok) {
    setStatus('error', 'Attach failed');
    showToast(res.error || 'Could not attach');
    return;
  }
  state.connected = true;
  state.currentTargetLabel = opt ? opt.textContent : elTarget.value;
  elAttach.disabled = true;
  elDetach.disabled = false;
  elRefresh.disabled = true;
  elTarget.disabled = true;
  setStatus('live', 'Live');
  elSbTarget.textContent = `Connected: ${state.currentTargetLabel}`;
  showToast('Connected and capturing network traffic');
}

async function detach() {
  await window.cdp.detach();
  state.connected = false;
  elAttach.disabled = !elTarget.value;
  elDetach.disabled = true;
  elRefresh.disabled = false;
  elTarget.disabled = false;
  setStatus('idle', 'Idle');
  elSbTarget.textContent = 'Not connected';
}

function setStatus(kind, text) {
  elStatus.className = `badge badge-${kind}`;
  elStatus.textContent = text;
}

function clearRequests() {
  state.requests.clear();
  state.order = [];
  state.selectedId = null;
  state.totalBytes = 0;
  state.startTime = null;
  renderList();
  renderDetails();
}

function makeHar() {
  const entries = state.order.map(id => state.requests.get(id)).filter(Boolean).map(req => {
    const started = req.wallTime ? new Date(req.wallTime * 1000).toISOString() : new Date().toISOString();
    const requestHeaders = Object.entries({ ...req.requestHeaders, ...req.requestExtraHeaders }).map(([name, value]) => ({ name, value: String(value) }));
    const responseHeaders = Object.entries({ ...req.responseHeaders, ...req.responseExtraHeaders }).map(([name, value]) => ({ name, value: String(value) }));
    let urlObj;
    try { urlObj = new URL(req.url); } catch { urlObj = null; }
    return {
      startedDateTime: started,
      time: requestDuration(req) || 0,
      request: {
        method: req.method || 'GET',
        url: req.url || '',
        httpVersion: req.protocol || 'HTTP/1.1',
        cookies: [],
        headers: requestHeaders,
        queryString: urlObj ? Array.from(urlObj.searchParams.entries()).map(([name, value]) => ({ name, value })) : [],
        headersSize: -1,
        bodySize: req.postData ? req.postData.length : 0,
        postData: req.postData ? { mimeType: req.requestHeaders['content-type'] || req.requestHeaders['Content-Type'] || '', text: req.postData } : undefined,
      },
      response: {
        status: typeof req.status === 'number' ? req.status : 0,
        statusText: req.statusText || req.errorText || '',
        httpVersion: req.protocol || 'HTTP/1.1',
        cookies: [],
        headers: responseHeaders,
        content: { size: req.bodyCache ? req.bodyCache.length : (req.encodedDataLength || 0), mimeType: req.mimeType || '', text: req.bodyCache || undefined, encoding: req.bodyBase64 ? 'base64' : undefined },
        redirectURL: '',
        headersSize: -1,
        bodySize: req.encodedDataLength || 0,
      },
      cache: {},
      timings: { send: -1, wait: -1, receive: -1 },
      serverIPAddress: req.remoteIPAddress,
      connection: req.remotePort ? String(req.remotePort) : undefined,
      _resourceType: req.resourceType,
    };
  });
  return { log: { version: '1.2', creator: { name: 'Network Inspector', version: '1.0.0' }, pages: [], entries } };
}

async function exportHar() {
  const content = JSON.stringify(makeHar(), null, 2);
  const res = await window.cdp.saveFile({ defaultPath: `network-${new Date().toISOString().replace(/[:.]/g, '-')}.har`, content });
  if (res.ok) showToast('HAR exported');
  else if (!res.canceled) showToast(res.error || 'Export failed');
}

function activateDetailTab(tab) {
  $$('.detail-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  $$('.detail-pane').forEach(pane => { pane.hidden = pane.id !== `pane-${tab}`; pane.classList.toggle('active', !pane.hidden); });
}

elRefresh.addEventListener('click', scanTargets);
elAttach.addEventListener('click', attachSelected);
elDetach.addEventListener('click', detach);
elClear.addEventListener('click', clearRequests);
elExport.addEventListener('click', exportHar);
elFilter.addEventListener('input', () => { state.filterText = elFilter.value; renderList(); });
elErrorsOnly.addEventListener('change', () => { state.errorsOnly = elErrorsOnly.checked; renderList(); });
elModalClose.addEventListener('click', hideHelpModal);
elModalOverlay.addEventListener('click', (e) => { if (e.target === elModalOverlay) hideHelpModal(); });

$$('.type-btn').forEach(btn => btn.addEventListener('click', () => {
  $$('.type-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.filterType = btn.dataset.type;
  renderList();
}));

elTbody.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  state.selectedId = tr.dataset.id;
  renderList();
  renderDetails();
});

$('#detail-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.detail-tab');
  if (btn) activateDetailTab(btn.dataset.tab);
});

let resizing = false;
elResizeHandle.addEventListener('mousedown', () => { resizing = true; document.body.style.cursor = 'col-resize'; });
window.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  const width = window.innerWidth - e.clientX;
  elDetailPanel.style.width = `${Math.max(340, Math.min(window.innerWidth * 0.7, width))}px`;
});
window.addEventListener('mouseup', () => { resizing = false; document.body.style.cursor = ''; });

window.cdp.onNetworkEvent(applyNetworkEvent);
window.cdp.onTargetDisconnected(() => {
  state.connected = false;
  elDetach.disabled = true;
  elRefresh.disabled = false;
  elTarget.disabled = false;
  elAttach.disabled = !elTarget.value;
  setStatus('error', 'Disconnected');
  elSbTarget.textContent = 'Not connected';
  showToast('Browser target disconnected');
});
window.cdp.onExportHar(exportHar);
window.cdp.onShowHelp(showHelpModal);
window.addEventListener('beforeunload', () => window.cdp.removeAllListeners());

renderList();
renderDetails();
