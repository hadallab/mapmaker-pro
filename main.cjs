'use strict';
// Electron main process: window, native file dialogs, recent files, symbol library and
// crash recovery storage. The renderer never touches the file system directly.

const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const userDir = () => app.getPath('userData');
const storePath = name => path.join(userDir(), name);

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(storePath(name), 'utf8')); } catch { return fallback; }
}

function writeJson(name, value) {
  fs.mkdirSync(userDir(), { recursive: true });
  const target = storePath(name);
  fs.writeFileSync(target + '.tmp', JSON.stringify(value));
  fs.renameSync(target + '.tmp', target);
}

// Write through a temporary file so a crash never leaves a half-written map.
function writeAtomic(file, text) {
  const tmp = file + '.mmp-tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function addRecent(file) {
  const list = readJson('recent.json', []).filter(f => f !== file);
  list.unshift(file);
  writeJson('recent.json', list.slice(0, 12));
}

let win = null;
let pendingOpen = process.argv.slice(app.isPackaged ? 1 : 2).find(a => /\.(dpm|json)$/i.test(a)) || null;

function createWindow() {
  const state = readJson('window.json', { width: 1600, height: 960 });
  // Forget a saved position that is no longer on any screen (monitor removed, resolution
  // changed); the window then opens centred on the primary display.
  const visible = state.x != null && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return state.x + 100 > a.x && state.y + 40 > a.y && state.x < a.x + a.width - 100 && state.y < a.y + a.height - 40;
  });
  if (!visible) { delete state.x; delete state.y; }
  win = new BrowserWindow({
    width: state.width, height: state.height, x: state.x, y: state.y,
    minWidth: 1100, minHeight: 680,
    backgroundColor: '#11141a',
    title: 'Mapmaker Pro',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#11141a', symbolColor: '#aab3c5', height: 36 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  // Never stay invisible: show even if the first paint is slow.
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); }, 3000);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  let allowClose = false;
  win.on('close', event => {
    const b = win.getNormalBounds();
    writeJson('window.json', { ...b, maximized: win.isMaximized() });
    if (allowClose) return;
    event.preventDefault();
    win.webContents.send('app:request-close');
  });
  ipcMain.removeHandler('app:close-confirmed');
  ipcMain.handle('app:close-confirmed', () => {
    allowClose = true;
    if (mapmakerWin && !mapmakerWin.isDestroyed()) mapmakerWin.destroy();
    win.close();
  });
}

const filters = [{ name: 'Deeeep.io map', extensions: ['dpm', 'json'] }, { name: 'All files', extensions: ['*'] }];

ipcMain.handle('file:open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open map', filters, properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return readMap(r.filePaths[0]);
});

// Editor-only data (object names, groups, symmetry links, reference image, Napoleon
// blocks) lives next to the map in "<map>.mmp.json" so the DPM itself stays exactly what
// Mapmaker writes. When the DPM's SHA-256 differs (edited externally), the sidecar is
// marked stale so the renderer can re-attach matching objects by signature.
const sha256 = text => require('node:crypto').createHash('sha256').update(text).digest('hex');
const sidecarPath = file => file + '.mmp.json';

function readMap(file) {
  const text = fs.readFileSync(file, 'utf8');
  addRecent(file);
  let sidecar = null;
  try {
    const meta = JSON.parse(fs.readFileSync(sidecarPath(file), 'utf8'));
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      sidecar = meta.dpmSha256 === sha256(text) ? meta : { ...meta, stale: true };
    }
  } catch { /* no sidecar */ }
  return { path: file, name: path.basename(file), text, sidecar };
}

ipcMain.handle('file:open-path', (_e, file) => {
  if (!fs.existsSync(file)) return { error: 'File not found: ' + file };
  return readMap(file);
});

ipcMain.handle('file:save', async (_e, { path: file, text, defaultName, sidecar }) => {
  let target = file;
  if (!target) {
    const r = await dialog.showSaveDialog(win, { title: 'Save map', defaultPath: defaultName || 'map.dpm', filters });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  writeAtomic(target, text);
  if (sidecar) writeAtomic(sidecarPath(target), JSON.stringify({ ...sidecar, dpmSha256: sha256(text) }));
  else if (fs.existsSync(sidecarPath(target))) fs.unlinkSync(sidecarPath(target));
  addRecent(target);
  return { path: target, name: path.basename(target) };
});

ipcMain.handle('file:export-png', async (_e, { bytes, dataUrl, defaultName }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save screenshot',
    defaultPath: defaultName || 'map.png',
    filters: [{ name: 'PNG image', extensions: ['png'] }]
  });
  if (r.canceled || !r.filePath) return null;
  writeAtomic(r.filePath, bytes ? Buffer.from(bytes) : Buffer.from(dataUrl.split(',')[1], 'base64'));
  return { path: r.filePath };
});

ipcMain.handle('file:reveal', (_e, file) => shell.showItemInFolder(file));
ipcMain.handle('recent:list', () => readJson('recent.json', []).filter(f => fs.existsSync(f)));
ipcMain.handle('recent:clear', () => writeJson('recent.json', []));
ipcMain.handle('store:get', (_e, name) => readJson('store-' + name + '.json', null));
ipcMain.handle('store:set', (_e, name, value) => writeJson('store-' + name + '.json', value));
ipcMain.handle('recovery:write', (_e, text) => { fs.mkdirSync(userDir(), { recursive: true }); writeAtomic(storePath('recovery.dpm'), text); });
ipcMain.handle('recovery:read', () => { try { return fs.readFileSync(storePath('recovery.dpm'), 'utf8'); } catch { return null; } });
ipcMain.handle('recovery:clear', () => { try { fs.unlinkSync(storePath('recovery.dpm')); } catch { /* none */ } });
ipcMain.handle('app:pending-open', () => { const f = pendingOpen; pendingOpen = null; return f; });
ipcMain.handle('app:version', () => app.getVersion());

// ---------------------------------------------------------------- Mapmaker window
// The real mapmaker.deeeep.io runs in its own window with a persistent session, so the
// user's login and Cloudflare clearance survive restarts. Maps are moved in and out with
// the editor's own globals (window.app is the official MapEditor).

const MAPMAKER_URL = process.env.MMP_MAPMAKER_URL || 'https://mapmaker.deeeep.io/';
const MAPMAKER_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*deeeep\.io(\/|$)/i;
const allowedInMapmaker = url => MAPMAKER_ORIGIN.test(url) || url.startsWith(MAPMAKER_URL);

// Mirrors what MapEditor.onMapChanged does after loading a map: fromJsonObject, then the
// spawn budget trims, then a fresh undo history; mapDirty makes Save available.
const LOADER = `async (map) => {
  const app = window.app;
  if (!app || typeof app.fromJsonObject !== 'function') throw new Error('Mapmaker editor is not ready');
  await app.fromJsonObject(map);
  if (typeof app.trimNpcCount === 'function') app.trimNpcCount();
  if (typeof app.trimFoodCount === 'function') app.trimFoodCount();
  if (app.history && typeof app.history.init === 'function') app.history.init(app.toJsonObject());
  if (window.vueData) window.vueData.mapDirty = true;
  return Object.keys(app.screenObjects).length;
}`;

let mapmakerWin = null;

function openMapmaker() {
  if (mapmakerWin && !mapmakerWin.isDestroyed()) { mapmakerWin.show(); mapmakerWin.focus(); return mapmakerWin; }
  mapmakerWin = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: 'Deeeep.io Mapmaker',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#11141a',
    webPreferences: {
      partition: 'persist:mapmaker',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  const wc = mapmakerWin.webContents;
  // Present a regular Chrome user agent; Electron's suffix is not needed by the site.
  wc.setUserAgent(wc.getUserAgent().replace(/ (Electron|mapmaker-pro|Mapmaker Pro)\/\S+/gi, ''));
  wc.setWindowOpenHandler(({ url }) => {
    if (allowedInMapmaker(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { partition: 'persist:mapmaker', sandbox: true }
        }
      };
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!allowedInMapmaker(url)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  mapmakerWin.on('closed', () => { mapmakerWin = null; });
  mapmakerWin.loadURL(MAPMAKER_URL);
  return mapmakerWin;
}

async function mapmakerReady(timeoutMs = 45000) {
  const w = mapmakerWin && !mapmakerWin.isDestroyed() ? mapmakerWin : openMapmaker();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (w.isDestroyed()) throw new Error('The Mapmaker window was closed');
    try {
      const ok = await w.webContents.executeJavaScript(
        '!!(window.app && window.app.fromJsonObject && window.app.layers && window.app.layers.length >= 16 && !window.app.loading)'
      );
      if (ok) return w;
    } catch { /* page still loading */ }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('Mapmaker did not finish loading. If a Cloudflare check is shown in the Mapmaker window, complete it and try again.');
}

ipcMain.handle('mapmaker:open', () => { openMapmaker(); return true; });

ipcMain.handle('mapmaker:status', async () => {
  if (!mapmakerWin || mapmakerWin.isDestroyed()) return { open: false };
  try {
    return await mapmakerWin.webContents.executeJavaScript(`(() => {
      const v = window.vueData, m = v && v.map;
      return {
        open: true,
        ready: !!(window.app && window.app.fromJsonObject),
        user: v && v.user ? (v.user.username || v.user.name || 'signed in') : null,
        map: m && m.id ? { id: m.id, stringId: m.string_id, title: m.title } : null,
        dirty: !!(v && v.mapDirty)
      };
    })()`);
  } catch { return { open: true, ready: false }; }
});

ipcMain.handle('mapmaker:send', async (_e, text) => {
  try {
    const w = await mapmakerReady();
    const count = await w.webContents.executeJavaScript(`(${LOADER})(${text})`);
    w.show(); w.focus();
    return { count };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('mapmaker:pull', async () => {
  try {
    if (!mapmakerWin || mapmakerWin.isDestroyed()) return { error: 'The Mapmaker window is not open' };
    const w = await mapmakerReady(5000);
    const text = await w.webContents.executeJavaScript('JSON.stringify(window.app.toJsonObject())');
    const title = await w.webContents.executeJavaScript(
      '(window.vueData && window.vueData.map && (window.vueData.map.string_id || window.vueData.map.title)) || ""'
    );
    return { text, name: (title || 'mapmaker') + '.dpm' };
  } catch (e) { return { error: e.message }; }
});

// ---------------------------------------------------------------- updates
// electron-updater reads latest.yml from a static address (any web host or a GitHub
// release) and verifies the downloaded installer against its SHA-512 before installing.

const UPDATE_REPO = { owner: 'hadallab', repo: 'mapmaker-pro' };
let updater = null;
function getUpdater() {
  if (!app.isPackaged) return null;
  if (!updater) {
    updater = require('electron-updater').autoUpdater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    const send = (type, data) => { if (win && !win.isDestroyed()) win.webContents.send('update:event', { type, ...data }); };
    updater.on('download-progress', p => send('progress', { percent: p.percent }));
    updater.on('update-downloaded', info => send('downloaded', { version: info.version }));
    updater.on('error', e => send('error', { message: e.message }));
  }
  return updater;
}

ipcMain.handle('update:check', async (_e, url) => {
  const u = getUpdater();
  if (!u) return { error: 'Updates work in the installed app, not in the development build.' };
  try {
    // Default feed: the public GitHub Releases of the project. A custom address in
    // Preferences > Updates overrides it (any static host with latest.yml).
    if (url) u.setFeedURL({ provider: 'generic', url });
    else u.setFeedURL({ provider: 'github', owner: UPDATE_REPO.owner, repo: UPDATE_REPO.repo });
    const r = await u.checkForUpdates();
    const latest = r?.updateInfo?.version;
    const available = r?.isUpdateAvailable ?? (!!latest && latest !== app.getVersion());
    return {
      current: app.getVersion(),
      latest,
      available,
      notes: typeof r?.updateInfo?.releaseNotes === 'string' ? r.updateInfo.releaseNotes : ''
    };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('update:download', async () => {
  const u = getUpdater();
  if (!u) return { error: 'Updater unavailable' };
  try { await u.downloadUpdate(); return { ok: true }; } catch (e) { return { error: e.message }; }
});
ipcMain.handle('update:install', () => { const u = getUpdater(); if (u) setImmediate(() => u.quitAndInstall(false, true)); return true; });

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const file = argv.find(a => /\.(dpm|json)$/i.test(a));
    if (!win || win.isDestroyed()) {
      pendingOpen = file || null;
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.moveTop();
    win.focus();
    if (file) win.webContents.send('app:open-path', file);
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
