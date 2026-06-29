const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const CDP = require('chrome-remote-interface');

let mainWindow;
let activeClient = null;
let activeTarget = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../assets/icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    disconnectCDP();
    mainWindow = null;
  });

  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Export HAR...', accelerator: 'CmdOrCtrl+E', click: () => mainWindow?.webContents.send('export-har') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'How to enable remote debugging',
          click: () => mainWindow?.webContents.send('show-help'),
        },
        {
          label: 'DevTools Protocol Reference',
          click: () => shell.openExternal('https://chromedevtools.github.io/devtools-protocol/'),
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

async function disconnectCDP() {
  if (activeClient) {
    try { await activeClient.close(); } catch (_) {}
    activeClient = null;
    activeTarget = null;
  }
}

ipcMain.handle('list-targets', async (_event, { host = 'localhost', port = 9222 }) => {
  try {
    const targets = await CDP.List({ host, port: Number(port) });
    return {
      ok: true,
      targets: targets
        .filter(t => t.type === 'page')
        .map(t => ({
          id: t.id,
          title: t.title || '(untitled)',
          url: t.url,
          type: t.type,
          webSocketDebuggerUrl: t.webSocketDebuggerUrl,
        })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('attach-target', async (_event, { host = 'localhost', port = 9222, targetId }) => {
  await disconnectCDP();

  try {
    const client = await CDP({ host, port: Number(port), target: targetId });
    const { Network, Page } = client;

    activeClient = client;
    activeTarget = targetId;

    await Network.enable({ maxPostDataSize: 65536, maxResourceBufferSize: 10485760 });
    await Page.enable();

    Network.requestWillBeSent(params => {
      mainWindow?.webContents.send('network-event', {
        type: 'request',
        requestId: params.requestId,
        loaderId: params.loaderId,
        timestamp: params.timestamp,
        wallTime: params.wallTime,
        url: params.request.url,
        method: params.request.method,
        headers: params.request.headers,
        postData: params.request.postData || null,
        hasPostData: params.request.hasPostData || false,
        resourceType: params.type,
        initiator: params.initiator,
        redirectResponse: params.redirectResponse || null,
      });
    });

    Network.requestWillBeSentExtraInfo?.(params => {
      mainWindow?.webContents.send('network-event', {
        type: 'request-extra',
        requestId: params.requestId,
        headers: params.headers,
        associatedCookies: params.associatedCookies,
      });
    });

    Network.responseReceived(params => {
      mainWindow?.webContents.send('network-event', {
        type: 'response',
        requestId: params.requestId,
        timestamp: params.timestamp,
        url: params.response.url,
        status: params.response.status,
        statusText: params.response.statusText,
        headers: params.response.headers,
        mimeType: params.response.mimeType,
        remoteIPAddress: params.response.remoteIPAddress,
        remotePort: params.response.remotePort,
        fromCache: Boolean(params.response.fromCache || params.response.fromDiskCache || params.response.fromPrefetchCache),
        protocol: params.response.protocol,
        timing: params.response.timing,
        securityDetails: params.response.securityDetails,
        resourceType: params.type,
      });
    });

    Network.responseReceivedExtraInfo?.(params => {
      mainWindow?.webContents.send('network-event', {
        type: 'response-extra',
        requestId: params.requestId,
        headers: params.headers,
        blockedCookies: params.blockedCookies,
        statusCode: params.statusCode,
        headersText: params.headersText,
      });
    });

    Network.loadingFinished(params => {
      mainWindow?.webContents.send('network-event', {
        type: 'finished',
        requestId: params.requestId,
        timestamp: params.timestamp,
        encodedDataLength: params.encodedDataLength,
      });
    });

    Network.loadingFailed(params => {
      mainWindow?.webContents.send('network-event', {
        type: 'failed',
        requestId: params.requestId,
        timestamp: params.timestamp,
        errorText: params.errorText,
        canceled: params.canceled,
        blockedReason: params.blockedReason,
        corsErrorStatus: params.corsErrorStatus,
      });
    });

    Network.webSocketCreated(params => {
      mainWindow?.webContents.send('network-event', {
        type: 'ws-created',
        requestId: params.requestId,
        url: params.url,
        initiator: params.initiator,
      });
    });

    Network.webSocketFrameSent(params => {
      mainWindow?.webContents.send('network-event', {
        type: 'ws-sent',
        requestId: params.requestId,
        timestamp: params.timestamp,
        payload: params.response.payloadData,
        opcode: params.response.opcode,
      });
    });

    Network.webSocketFrameReceived(params => {
      mainWindow?.webContents.send('network-event', {
        type: 'ws-received',
        requestId: params.requestId,
        timestamp: params.timestamp,
        payload: params.response.payloadData,
        opcode: params.response.opcode,
      });
    });

    client.on('disconnect', () => {
      mainWindow?.webContents.send('target-disconnected', { targetId: activeTarget });
      activeClient = null;
      activeTarget = null;
    });

    return { ok: true };
  } catch (err) {
    await disconnectCDP();
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-response-body', async (_event, { requestId }) => {
  if (!activeClient) return { ok: false, error: 'Not connected' };
  try {
    const result = await activeClient.Network.getResponseBody({ requestId });
    return { ok: true, body: result.body, base64Encoded: result.base64Encoded };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-file', async (_event, { defaultPath, content }) => {
  if (!mainWindow) return { ok: false, error: 'No window available' };
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath,
    filters: [{ name: 'HAR files', extensions: ['har'] }, { name: 'JSON files', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('detach', async () => {
  await disconnectCDP();
  return { ok: true };
});
