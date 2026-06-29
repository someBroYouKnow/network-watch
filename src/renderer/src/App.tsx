import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { NetworkEvent, NetworkRequest, StatusCode, Target } from './types';

type CaptureState = { requests: Map<string, NetworkRequest>; order: string[] };

type CaptureAction =
  | { type: 'event'; event: NetworkEvent }
  | { type: 'clear' }
  | { type: 'body'; requestId: string; body: string; base64Encoded: boolean };

function captureReducer(state: CaptureState, action: CaptureAction): CaptureState {
  if (action.type === 'clear') {
    return { requests: new Map(), order: [] };
  }

  if (action.type === 'body') {
    const req = state.requests.get(action.requestId);
    if (!req) return state;
    const requests = new Map(state.requests);
    requests.set(action.requestId, { ...req, bodyCache: action.body, bodyBase64: action.base64Encoded });
    return { ...state, requests };
  }

  const { event } = action;
  const existed = state.requests.has(event.requestId);
  const requests = new Map(state.requests);
  requests.set(
    event.requestId,
    applyEventToRequest(requests.get(event.requestId) || createRequest(event.requestId), event),
  );
  const order = existed || state.order.includes(event.requestId)
    ? state.order
    : [...state.order, event.requestId];
  return { requests, order };
}

const RESOURCE_TYPES = ['all', 'XHR', 'Fetch', 'Document', 'Script', 'Stylesheet', 'Image', 'Font', 'WebSocket', 'Other'];
const DETAIL_TABS = ['headers', 'request-body', 'response-body', 'timing', 'raw'] as const;
const MAX_TARGET_LABEL_LENGTH = 100;
type DetailTab = (typeof DETAIL_TABS)[number];

type ToastState = { message: string; id: number } | null;
type StatusKind = 'idle' | 'live' | 'error';

function createRequest(id: string): NetworkRequest {
  return {
    id,
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
}

function formatBytes(bytes: number) {
  if (!bytes || bytes <= 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function formatMs(ms: number | null) {
  if (ms == null || Number.isNaN(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function statusClass(code: StatusCode) {
  if (!code) return 'status-pending';
  if (code === 'ERR') return 'status-error';
  if (code < 300) return 'status-2xx';
  if (code < 400) return 'status-3xx';
  if (code < 500) return 'status-4xx';
  return 'status-5xx';
}

function methodClass(method = '') {
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method) ? `method-${method}` : 'method-OTHER';
}

function tryPrettyJson(text: string | null) {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function parseUrlParts(url: string) {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: parsed.pathname + parsed.search + parsed.hash };
  } catch {
    return { host: '', path: url || '' };
  }
}

function truncateLabel(value: string, maxLength = MAX_TARGET_LABEL_LENGTH) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function requestDuration(req: NetworkRequest) {
  if (req.startedAt == null || req.finishedAt == null) return null;
  return (req.finishedAt - req.startedAt) * 1000;
}

function makeHar(order: string[], requests: Map<string, NetworkRequest>) {
  const entries = order
    .map((id) => requests.get(id))
    .filter(Boolean)
    .map((req) => {
      const request = req as NetworkRequest;
      const started = request.wallTime ? new Date(request.wallTime * 1000).toISOString() : new Date().toISOString();
      const requestHeaders = Object.entries({ ...request.requestHeaders, ...request.requestExtraHeaders }).map(([name, value]) => ({ name, value: String(value) }));
      const responseHeaders = Object.entries({ ...request.responseHeaders, ...request.responseExtraHeaders }).map(([name, value]) => ({ name, value: String(value) }));
      let urlObj: URL | null = null;
      try {
        urlObj = new URL(request.url);
      } catch {
        urlObj = null;
      }

      return {
        startedDateTime: started,
        time: requestDuration(request) || 0,
        request: {
          method: request.method || 'GET',
          url: request.url || '',
          httpVersion: request.protocol || 'HTTP/1.1',
          cookies: [],
          headers: requestHeaders,
          queryString: urlObj ? Array.from(urlObj.searchParams.entries()).map(([name, value]) => ({ name, value })) : [],
          headersSize: -1,
          bodySize: request.postData ? request.postData.length : 0,
          postData: request.postData
            ? { mimeType: String(request.requestHeaders['content-type'] || request.requestHeaders['Content-Type'] || ''), text: request.postData }
            : undefined,
        },
        response: {
          status: typeof request.status === 'number' ? request.status : 0,
          statusText: request.statusText || request.errorText || '',
          httpVersion: request.protocol || 'HTTP/1.1',
          cookies: [],
          headers: responseHeaders,
          content: {
            size: request.bodyCache ? request.bodyCache.length : request.encodedDataLength || 0,
            mimeType: request.mimeType || '',
            text: request.bodyCache || undefined,
            encoding: request.bodyBase64 ? 'base64' : undefined,
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: request.encodedDataLength || 0,
        },
        cache: {},
        timings: { send: -1, wait: -1, receive: -1 },
        serverIPAddress: request.remoteIPAddress,
        connection: request.remotePort ? String(request.remotePort) : undefined,
        _resourceType: request.resourceType,
      };
    });

  return { log: { version: '1.2', creator: { name: 'Network Inspector', version: '1.0.0' }, pages: [], entries } };
}

function applyEventToRequest(current: NetworkRequest, event: NetworkEvent): NetworkRequest {
  const req = { ...current, wsFrames: [...current.wsFrames] };

  if (event.type === 'request') {
    req.method = event.method;
    req.url = event.url;
    req.resourceType = event.resourceType || req.resourceType;
    req.requestHeaders = event.headers || {};
    req.postData = event.postData || null;
    req.startedAt = event.timestamp ?? req.startedAt;
    req.wallTime = event.wallTime;
    req.initiator = event.initiator || null;
  } else if (event.type === 'request-extra') {
    req.requestExtraHeaders = event.headers || {};
  } else if (event.type === 'response') {
    req.status = event.status;
    req.statusText = event.statusText;
    req.responseHeaders = event.headers || {};
    req.mimeType = event.mimeType || '';
    req.protocol = event.protocol || '';
    req.fromCache = event.fromCache;
    req.remoteIPAddress = event.remoteIPAddress;
    req.remotePort = event.remotePort;
    req.timing = event.timing;
    req.resourceType = event.resourceType || req.resourceType;
  } else if (event.type === 'response-extra') {
    req.responseExtraHeaders = event.headers || {};
    if (!req.status && event.statusCode) req.status = event.statusCode;
    req.headersText = event.headersText;
  } else if (event.type === 'finished') {
    req.finishedAt = event.timestamp;
    req.encodedDataLength = event.encodedDataLength || 0;
  } else if (event.type === 'failed') {
    req.finishedAt = event.timestamp;
    req.failed = true;
    req.status = 'ERR';
    req.errorText = event.errorText || event.blockedReason || 'Failed';
  } else if (event.type === 'ws-created') {
    req.url = event.url;
    req.method = 'WS';
    req.resourceType = 'WebSocket';
    req.initiator = event.initiator || null;
  } else if (event.type === 'ws-sent' || event.type === 'ws-received') {
    req.resourceType = 'WebSocket';
    req.wsFrames.push({
      direction: event.type === 'ws-sent' ? 'sent' : 'received',
      timestamp: event.timestamp,
      opcode: event.opcode,
      payload: event.payload,
    });
  }

  return req;
}

function HeadersTable({ headers }: { headers: Record<string, unknown> }) {
  const entries = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return <p className="k">No headers captured.</p>;

  return (
    <table className="headers-table">
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key}>
            <td>{key}</td>
            <td>{String(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div id="modal-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div id="modal">
        <h2>How to enable remote debugging</h2>
        <p>Launch your browser with the remote debugging flag, then click Scan.</p>
        <div className="launch-commands">
          <div className="launch-cmd">
            <span className="browser-name">Chrome / Brave</span>
            <code>google-chrome --remote-debugging-port=9222<br />brave-browser --remote-debugging-port=9222</code>
          </div>
          <div className="launch-cmd">
            <span className="browser-name">Edge</span>
            <code>msedge --remote-debugging-port=9222</code>
          </div>
          <div className="launch-cmd">
            <span className="browser-name">Windows Chrome</span>
            <code>&quot;C:\Program Files\Google\Chrome\Application\chrome.exe&quot; --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0</code>
          </div>
          <div className="launch-cmd">
            <span className="browser-name">Docker host value</span>
            <code>host.docker.internal:9222</code>
          </div>
        </div>
        <button className="btn btn-primary" onClick={onClose}>Got it</button>
      </div>
    </div>
  );
}

function RequestDetails({
  request,
  activeTab,
  setActiveTab,
  onLoadBody,
}: {
  request: NetworkRequest | undefined;
  activeTab: DetailTab;
  setActiveTab: (tab: DetailTab) => void;
  onLoadBody: (id: string) => void;
}) {
  if (!request) {
    return (
      <div id="detail-empty">
        <div className="empty-icon">^</div>
        <p>Select a request to inspect it</p>
      </div>
    );
  }

  const timing = request.timing || {};
  const phases = [
    ['DNS', timing.dnsStart, timing.dnsEnd],
    ['Connect', timing.connectStart, timing.connectEnd],
    ['SSL', timing.sslStart, timing.sslEnd],
    ['Send', timing.sendStart, timing.sendEnd],
    ['Wait', timing.sendEnd, timing.receiveHeadersEnd],
  ].filter(([, start, end]) => typeof start === 'number' && typeof end === 'number' && start >= 0 && end >= 0 && end >= start) as Array<[string, number, number]>;
  const max = Math.max(...phases.map(([, , end]) => end), 1);

  return (
    <div id="detail-content">
      <div id="detail-tabs">
        {DETAIL_TABS.map((tab) => (
          <button key={tab} className={`detail-tab ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)}>
            {tab === 'request-body' ? 'Request Body' : tab === 'response-body' ? 'Response Body' : tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      <div id="detail-panes">
        {activeTab === 'headers' && (
          <div className="detail-pane active">
            <div className="section">
              <h3>General</h3>
              <div className="kv">
                <div className="k">Request URL</div><div className="v">{request.url}</div>
                <div className="k">Method</div><div>{request.method || '-'}</div>
                <div className="k">Status</div><div><span className={statusClass(request.status)}>{request.status || 'Pending'}</span> {request.statusText || request.errorText}</div>
                <div className="k">Resource Type</div><div>{request.resourceType || 'Other'}</div>
                <div className="k">Protocol</div><div>{request.protocol || '-'}</div>
                <div className="k">Remote Address</div><div>{request.remoteIPAddress ? `${request.remoteIPAddress}:${request.remotePort || ''}` : '-'}</div>
                <div className="k">From Cache</div><div>{request.fromCache ? 'Yes' : 'No'}</div>
                <div className="k">Transferred</div><div>{formatBytes(request.encodedDataLength)}</div>
                <div className="k">Duration</div><div>{formatMs(requestDuration(request))}</div>
              </div>
            </div>
            <div className="section"><h3>Request Headers</h3><HeadersTable headers={{ ...request.requestHeaders, ...request.requestExtraHeaders }} /></div>
            <div className="section"><h3>Response Headers</h3><HeadersTable headers={{ ...request.responseHeaders, ...request.responseExtraHeaders }} /></div>
          </div>
        )}
        {activeTab === 'request-body' && <div className="detail-pane active">{request.postData ? <pre>{tryPrettyJson(request.postData)}</pre> : <p className="k">No request body captured.</p>}</div>}
        {activeTab === 'response-body' && (
          <div className="detail-pane active">
            {request.wsFrames.length > 0 && (
              <div className="section">
                <h3>WebSocket Frames</h3>
                <pre>{request.wsFrames.map((f) => `[${f.direction}] opcode=${f.opcode} ${f.payload}`).join('\n')}</pre>
              </div>
            )}
            {request.bodyCache != null ? (
              <pre>{request.bodyBase64 ? `[base64 encoded]\n${request.bodyCache}` : tryPrettyJson(request.bodyCache)}</pre>
            ) : request.failed ? (
              <p className="k">Request failed: {request.errorText}</p>
            ) : (
              <>
                <div className="body-actions"><button className="btn btn-secondary" onClick={() => onLoadBody(request.id)}>Load response body</button></div>
                <p className="k">Bodies are fetched on demand after the request finishes.</p>
              </>
            )}
          </div>
        )}
        {activeTab === 'timing' && (
          <div className="detail-pane active">
            <div className="section">
              <h3>Summary</h3>
              <div className="kv">
                <div className="k">Started</div><div>{request.wallTime ? new Date(request.wallTime * 1000).toLocaleString() : '-'}</div>
                <div className="k">Total</div><div>{formatMs(requestDuration(request))}</div>
                <div className="k">Encoded Size</div><div>{formatBytes(request.encodedDataLength)}</div>
              </div>
            </div>
            <div className="section">
              <h3>Phases</h3>
              {phases.length ? phases.map(([name, start, end]) => (
                <div className="timeline-row" key={name}>
                  <div className="k">{name}</div>
                  <div className="bar"><span style={{ marginLeft: `${(start / max) * 100}%`, width: `${Math.max(((end - start) / max) * 100, 1)}%` }} /></div>
                  <div>{formatMs(end - start)}</div>
                </div>
              )) : <p className="k">No detailed timing available.</p>}
            </div>
          </div>
        )}
        {activeTab === 'raw' && <div className="detail-pane active"><pre>{JSON.stringify(request, null, 2)}</pre></div>}
      </div>
    </div>
  );
}

export function App() {
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState(9222);
  const [targets, setTargets] = useState<Target[]>([]);
  const [selectedTarget, setSelectedTarget] = useState('');
  const [{ requests, order }, dispatchCapture] = useReducer(captureReducer, { requests: new Map(), order: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<{ kind: StatusKind; text: string }>({ kind: 'idle', text: 'Idle' });
  const [currentTargetLabel, setCurrentTargetLabel] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>('headers');
  const [detailWidth, setDetailWidth] = useState('43%');
  const exportRef = useRef(() => {});

  const showToast = useCallback((message: string) => {
    const id = Date.now();
    setToast({ message, id });
    window.setTimeout(() => setToast((current) => (current?.id === id ? null : current)), 2500);
  }, []);

  const totalBytes = useMemo(() => Array.from(requests.values()).reduce((sum, req) => sum + (req.encodedDataLength || 0), 0), [requests]);
  const selectedRequest = selectedId ? requests.get(selectedId) : undefined;

  const filteredRequests = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    return order
      .map((id) => requests.get(id))
      .filter((req): req is NetworkRequest => Boolean(req))
      .filter((req) => {
        if (filterType !== 'all' && req.resourceType !== filterType) return false;
        if (errorsOnly && !(req.failed || (typeof req.status === 'number' && req.status >= 400))) return false;
        if (!query) return true;
        return [req.url, req.method, req.status, req.resourceType, req.mimeType].some((value) => String(value ?? '').toLowerCase().includes(query));
      });
  }, [errorsOnly, filterText, filterType, order, requests]);

  const scanTargets = useCallback(async () => {
    setScanning(true);
    setTargets([]);
    setSelectedTarget('');
    setStatus({ kind: 'idle', text: 'Scanning' });
    try {
      const result = await window.cdp.listTargets({ host: host.trim() || 'localhost', port });
      if (!result.ok) {
        setStatus({ kind: 'error', text: 'No browser' });
        showToast(`Could not connect to ${host}:${port}. Open help for launch flags.`);
        setShowHelp(true);
        return;
      }
      setTargets(result.targets);
      setSelectedTarget(result.targets[0]?.id || '');
      setStatus({ kind: 'idle', text: result.targets.length ? 'Ready' : 'Idle' });
      showToast(result.targets.length ? `Found ${result.targets.length} tab${result.targets.length === 1 ? '' : 's'}` : 'Connected, but no page tabs were available.');
    } finally {
      setScanning(false);
    }
  }, [host, port, showToast]);

  const attachSelected = useCallback(async () => {
    if (!selectedTarget) return;
    const result = await window.cdp.attachTarget({ host: host.trim() || 'localhost', port, targetId: selectedTarget });
    if (!result.ok) {
      setStatus({ kind: 'error', text: 'Attach failed' });
      showToast(result.error || 'Could not attach');
      return;
    }
    const target = targets.find((item) => item.id === selectedTarget);
    setConnected(true);
    setCurrentTargetLabel(target ? `${target.title} - ${target.url}` : selectedTarget);
    setStatus({ kind: 'live', text: 'Live' });
    showToast('Connected and capturing network traffic');
  }, [host, port, selectedTarget, showToast, targets]);

  const detach = useCallback(async () => {
    await window.cdp.detach();
    setConnected(false);
    setStatus({ kind: 'idle', text: 'Idle' });
    setCurrentTargetLabel('');
  }, []);

  const clearRequests = useCallback(() => {
    dispatchCapture({ type: 'clear' });
    setSelectedId(null);
  }, []);

  const exportHar = useCallback(async () => {
    const content = JSON.stringify(makeHar(order, requests), null, 2);
    const result = await window.cdp.saveFile({ defaultPath: `network-${new Date().toISOString().replace(/[:.]/g, '-')}.har`, content });
    if (result.ok) showToast('HAR exported');
    else if (!result.canceled) showToast(result.error || 'Export failed');
  }, [order, requests, showToast]);

  exportRef.current = exportHar;

  const loadResponseBody = useCallback(async (requestId: string) => {
    const result = await window.cdp.getResponseBody({ requestId });
    if (!result.ok) {
      showToast(result.error || 'Could not load body');
      return;
    }
    dispatchCapture({ type: 'body', requestId, body: result.body, base64Encoded: result.base64Encoded });
  }, [showToast]);

  useEffect(() => {
    if (!window.cdp) {
      setStatus({ kind: 'error', text: 'Bridge error' });
      showToast('Preload bridge unavailable. Restart the app.');
      return;
    }

    window.cdp.onNetworkEvent((event) => {
      dispatchCapture({ type: 'event', event });
    });
    window.cdp.onTargetDisconnected(() => {
      setConnected(false);
      setStatus({ kind: 'error', text: 'Disconnected' });
      setCurrentTargetLabel('');
      showToast('Browser target disconnected');
    });
    window.cdp.onExportHar(() => exportRef.current());
    window.cdp.onShowHelp(() => setShowHelp(true));
    return () => window.cdp.removeAllListeners();
  }, [showToast]);

  const startResize = useCallback(() => {
    const onMove = (event: MouseEvent) => {
      const width = window.innerWidth - event.clientX;
      setDetailWidth(`${Math.max(340, Math.min(window.innerWidth * 0.7, width))}px`);
    };
    const onUp = () => {
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  return (
    <>
      <header id="toolbar">
        <div className="toolbar-left">
          <div className="logo"><span className="logo-icon">NW</span><span className="logo-text">Network Inspector</span></div>
          <div className="connect-group">
            <label className="field-label">Host</label>
            <input id="inp-host" type="text" value={host} onChange={(event) => setHost(event.target.value)} spellCheck={false} disabled={connected} />
            <label className="field-label">Port</label>
            <input id="inp-port" type="number" value={port} min="1" max="65535" onChange={(event) => setPort(Number(event.target.value || 9222))} disabled={connected} />
            <button className="btn btn-secondary" title="Scan for tabs" onClick={scanTargets} disabled={connected || scanning}>{scanning ? 'Scanning…' : 'Scan'}</button>
          </div>
          <div className="target-group">
            <label className="field-label">Tab</label>
            <select value={selectedTarget} disabled={connected || scanning || !targets.length} onChange={(event) => setSelectedTarget(event.target.value)}>
              {scanning ? <option value="">Scanning...</option> : targets.length ? targets.map((target) => {
                const label = `${target.title} - ${target.url}`;
                return <option key={target.id} value={target.id} title={label}>{truncateLabel(label)}</option>;
              }) : <option value="">- scan first -</option>}
            </select>
            <button className="btn btn-primary" onClick={attachSelected} disabled={connected || scanning || !selectedTarget}>Connect</button>
            <button className="btn btn-danger" onClick={detach} disabled={!connected}>Disconnect</button>
          </div>
        </div>
        <div className="toolbar-right">
          <span className={`badge badge-${status.kind}`}>{status.text}</span>
          <button className="btn btn-ghost" onClick={clearRequests}>Clear</button>
          <button className="btn btn-ghost" onClick={exportHar}>HAR</button>
        </div>
      </header>
      <div id="filter-bar">
        <input id="inp-filter" type="search" placeholder="Filter by URL, method, status..." value={filterText} onChange={(event) => setFilterText(event.target.value)} />
        <div className="type-filters">
          {RESOURCE_TYPES.map((type) => <button key={type} className={`type-btn ${filterType === type ? 'active' : ''}`} onClick={() => setFilterType(type)}>{type === 'Document' ? 'Doc' : type === 'Script' ? 'JS' : type === 'Stylesheet' ? 'CSS' : type === 'Image' ? 'Img' : type}</button>)}
        </div>
        <label className="checkbox-label"><input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} /> Errors only</label>
        <span id="req-count">{filteredRequests.length} request{filteredRequests.length === 1 ? '' : 's'}</span>
      </div>
      <main id="split-pane">
        <div id="request-list-wrap">
          <table id="request-table">
            <thead><tr><th className="col-status">Status</th><th className="col-method">Method</th><th className="col-type">Type</th><th className="col-url">URL</th><th className="col-size">Size</th><th className="col-time">Time</th></tr></thead>
            <tbody>
              {filteredRequests.map((req) => {
                const url = parseUrlParts(req.url);
                return (
                  <tr key={req.id} className={selectedId === req.id ? 'selected' : ''} onClick={() => setSelectedId(req.id)}>
                    <td><span className={`status-pill ${statusClass(req.status)}`}>{req.status || '...'}</span></td>
                    <td><span className={`method-pill ${methodClass(req.method)}`}>{req.method || '-'}</span></td>
                    <td><span className="type-pill">{req.resourceType || 'Other'}</span></td>
                    <td title={req.url}><span className="url-host">{url.host}</span>{url.path}</td>
                    <td>{formatBytes(req.encodedDataLength)}</td>
                    <td>{formatMs(requestDuration(req))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!order.length ? (
            <div id="empty-state">
              <div className="empty-icon">[]</div>
              <p>Connect to a browser tab to start capturing</p>
              <small>Launch your browser with <code>--remote-debugging-port=9222</code></small>
            </div>
          ) : null}
        </div>
        <div id="resize-handle" onMouseDown={startResize} />
        <div id="detail-panel" style={{ width: detailWidth }}>
          <RequestDetails request={selectedRequest} activeTab={activeTab} setActiveTab={setActiveTab} onLoadBody={loadResponseBody} />
        </div>
      </main>
      <footer id="status-bar">
        <span>{order.length} request{order.length === 1 ? '' : 's'}</span>
        <span>{formatBytes(totalBytes)} transferred</span>
        <span>{currentTargetLabel ? `Connected: ${currentTargetLabel}` : 'Not connected'}</span>
      </footer>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {toast && <div id="toast" className="show">{toast.message}</div>}
    </>
  );
}
