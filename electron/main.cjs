// Electron main process (CommonJS)
const { app, BrowserWindow, Menu, shell, ipcMain, powerSaveBlocker, dialog, session, net } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

let express, WebSocketServer, WebSocket;
try {
  express = require('express');
  ({ WebSocketServer, WebSocket } = require('ws'));
} catch (e) {
  console.error('[sync] Failed to load express/ws:', e.message);
}

const isDev = process.env.NODE_ENV === 'development';
const SYNC_PORT = 9877;
const READONLY_PORT = 9878;

// Disable Chromium security features that block renderer fetch() calls to
// local-network IPs (Private Network Access / CORS-RFC1918).
app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('disable-features', 'PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests,OutOfBlinkCors');

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ── Sync server (Express HTTP + WebSocket relay) ─────────────────────────────
let syncServerStarted = false;
let _lanIp = '127.0.0.1';
let _interactiveEnabled = true;
let _readonlyEnabled = true;
let _wss = null;
let _wssRo = null;

let _imagesDir = '';

function ensureImagesDir() {
  if (!_imagesDir) _imagesDir = path.join(app.getPath('userData'), 'served-images');
  if (!fs.existsSync(_imagesDir)) fs.mkdirSync(_imagesDir, { recursive: true });
  return _imagesDir;
}

function makeStaticApp(distPath) {
  const a = express();
  // Serve uploaded logos — vMix can fetch these over the LAN
  a.use('/images', (req, res, next) => {
    express.static(ensureImagesDir(), { maxAge: 0 })(req, res, next);
  });
  a.get('/', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(distPath, 'index.html')); });
  a.use(express.static(distPath, { maxAge: '1y', index: false }));
  a.get('/{*path}', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(distPath, 'index.html')); });
  return a;
}

function startSyncServer() {
  if (!express || !WebSocketServer || syncServerStarted) return;
  syncServerStarted = true;
  _lanIp = getLanIp();

  const distPath = path.join(__dirname, '..', 'dist');

  // ── Interactive server (9877) ────────────────────────────────────────────
  const syncServer = http.createServer(makeStaticApp(distPath));
  _wss = new WebSocketServer({ server: syncServer });

  let cachedFullState = null;

  _wss.on('connection', (ws) => {
    if (!_interactiveEnabled) { ws.close(4003, 'disabled'); return; }
    if (cachedFullState) ws.send(JSON.stringify(cachedFullState));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'FULL_STATE') {
          cachedFullState = msg;
          // Push new full state to all read-only clients
          for (const c of _wssRo.clients) {
            if (c.readyState === WebSocket.OPEN) c.send(data.toString());
          }
        }
        if (msg.type === 'REQUEST_STATE' && cachedFullState) {
          ws.send(JSON.stringify(cachedFullState));
        }
        // Relay to every other interactive client
        for (const client of _wss.clients) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(msg));
          }
        }
        // Push actions to read-only clients so their widgets update live
        if (msg.type === 'ACTION') {
          for (const c of _wssRo.clients) {
            if (c.readyState === WebSocket.OPEN) c.send(data.toString());
          }
        }
      } catch (_) {}
    });
  });

  syncServer.listen(SYNC_PORT, '0.0.0.0', () => {
    console.log(`Interactive: http://${_lanIp}:${SYNC_PORT}`);
    // Once the HTTP server is ready, switch any windows that loaded the fallback
    if (!isDev) {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.getURL().startsWith('file:') &&
          win.loadURL(`http://127.0.0.1:${SYNC_PORT}`).catch(console.error);
      }
    }
  });

  // ── Read-only server (9878) ──────────────────────────────────────────────
  const roServer = http.createServer(makeStaticApp(distPath));
  _wssRo = new WebSocketServer({ server: roServer });

  _wssRo.on('connection', (ws) => {
    if (!_readonlyEnabled) { ws.close(4003, 'disabled'); return; }
    if (cachedFullState) ws.send(JSON.stringify(cachedFullState));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Read-only clients may only request state — never relay their actions
        if (msg.type === 'REQUEST_STATE' && cachedFullState) {
          ws.send(JSON.stringify(cachedFullState));
        }
      } catch (_) {}
    });
  });

  roServer.listen(READONLY_PORT, '0.0.0.0', () => {
    console.log(`Read-only:   http://${_lanIp}:${READONLY_PORT}`);
  });
}

startSyncServer();

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0e0e16',
    webPreferences: {
      // Disable web security so fetch() can reach vMix on the local network (CORS bypass)
      webSecurity: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      // Prevent Chromium from throttling the renderer when the window is not focused.
      // Without this the onmessage handler for timerWorker stalls when the app is idle.
      backgroundThrottling: false,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    // Load via the sync HTTP server so the renderer uses Chromium's network
    // stack for vMix API fetch() calls (same behaviour as dev mode).
    // Fall back to file:// if the server isn't up yet — the listen callback
    // above will switch to http:// once the server is ready.
    win.loadURL(`http://127.0.0.1:${SYNC_PORT}`).catch(() => {
      win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    });
  }

  // Open external links in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── Sync server info + toggles ───────────────────────────────────────────────
ipcMain.handle('sync:getServerInfo', () => ({
  ip: _lanIp,
  port: SYNC_PORT,
  url: `http://${_lanIp}:${SYNC_PORT}`,
  readonlyPort: READONLY_PORT,
  readonlyUrl: `http://${_lanIp}:${READONLY_PORT}`,
  interactiveEnabled: _interactiveEnabled,
  readonlyEnabled: _readonlyEnabled,
}));

ipcMain.handle('sync:toggleInteractive', () => {
  _interactiveEnabled = !_interactiveEnabled;
  if (!_interactiveEnabled && _wss) {
    for (const c of _wss.clients) c.close(4003, 'disabled');
  }
  return _interactiveEnabled;
});

ipcMain.handle('sync:toggleReadonly', () => {
  _readonlyEnabled = !_readonlyEnabled;
  if (!_readonlyEnabled && _wssRo) {
    for (const c of _wssRo.clients) c.close(4003, 'disabled');
  }
  return _readonlyEnabled;
});

// ── Power save blocker — prevent system sleep while a timer is running ────────
let _powerSaveId = -1;

ipcMain.handle('timer:setSleepBlock', (_e, block) => {
  if (block && _powerSaveId === -1) {
    _powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!block && _powerSaveId !== -1) {
    powerSaveBlocker.stop(_powerSaveId);
    _powerSaveId = -1;
  }
});

// ── Logo image serving ───────────────────────────────────────────────────────

ipcMain.handle('images:openDialog', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Logo Image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('images:save', (_e, srcPath) => {
  const dir = ensureImagesDir();
  const ext = path.extname(srcPath);
  const name = `${Date.now()}_${path.basename(srcPath, ext).replace(/[^a-zA-Z0-9_-]/g, '_')}${ext}`;
  fs.copyFileSync(srcPath, path.join(dir, name));
  return { name, url: `http://${_lanIp}:${SYNC_PORT}/images/${name}` };
});

ipcMain.handle('images:list', () => {
  const dir = ensureImagesDir();
  const files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|gif|webp|svg)$/i.test(f));
  return files.map(name => ({ name, url: `http://${_lanIp}:${SYNC_PORT}/images/${name}` }));
});

ipcMain.handle('images:delete', (_e, name) => {
  const file = path.join(ensureImagesDir(), path.basename(name));
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

ipcMain.handle('images:baseUrl', () => `http://${_lanIp}:${SYNC_PORT}/images`);

// ── HTTP proxy for renderer → vMix (electron.net uses Chromium stack, no PNA restrictions in main process) ──
ipcMain.handle('net:httpGet', (_e, url) => {
  return new Promise((resolve, reject) => {
    const request = net.request(url);
    const chunks = [];
    request.on('response', (response) => {
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 400) reject(new Error(`HTTP ${response.statusCode}`));
        else resolve(body);
      });
      response.on('error', (err) => reject(new Error(err.message)));
    });
    request.on('error', (err) => reject(new Error(err.message)));
    request.end();
  });
});

// ── NDI source discovery via mDNS ────────────────────────────────────────────
// NDI advertises sources as _ndi._tcp on the local network.
// dns-sd (macOS built-in) can browse for them; avahi-browse on Linux.
ipcMain.handle('ndi:scan', () => {
  return new Promise((resolve) => {
    const sources = new Set();

    const platform = process.platform;
    let proc;

    try {
      if (platform === 'darwin') {
        proc = spawn('dns-sd', ['-B', '_ndi._tcp', 'local']);
      } else if (platform === 'linux') {
        proc = spawn('avahi-browse', ['-t', '-r', '_ndi._tcp']);
      } else {
        // Windows: Bonjour SDK not guaranteed; skip auto-discovery
        return resolve([]);
      }

      proc.stdout.on('data', (data) => {
        for (const line of data.toString().split('\n')) {
          // dns-sd:       "  15:30:00.000  Add  2  1  local  _ndi._tcp.  SOURCE NAME"
          // avahi-browse: "= eth0 IPv4 SOURCE NAME  _ndi._tcp  local"
          const match = line.match(/_ndi\._tcp[.\s]+(.+)/);
          if (match && /\bAdd\b|^=/.test(line)) {
            const name = match[1].trim();
            if (name) sources.add(name);
          }
        }
      });

      proc.on('error', () => resolve([]));

      // Give it 3 s to collect announcements, then stop
      setTimeout(() => {
        try { proc.kill(); } catch (_) {}
        resolve([...sources]);
      }, 3000);

    } catch (_) {
      resolve([]);
    }
  });
});

// macOS menu
const template = [
  ...(process.platform === 'darwin'
    ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }]
    : []),
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' }, { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ],
  },
  {
    label: 'View',
    submenu: [
      { role: 'reload' }, { role: 'forceReload' },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
    ],
  },
  {
    label: 'Window',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
  },
];

app.whenReady().then(() => {
  // Inject CORS headers into every HTTP response so the renderer can reach
  // vMix (and any other local network API) from the file:// origin.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Access-Control-Allow-Origin': ['*'],
        'Access-Control-Allow-Methods': ['GET, POST, PUT, DELETE, OPTIONS'],
        'Access-Control-Allow-Headers': ['Content-Type'],
      },
    });
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
