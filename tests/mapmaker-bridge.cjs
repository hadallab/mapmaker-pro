'use strict';
// Transfer test against the official engine.
// - Electron: sends a map into the Mapmaker window (pointed at the cached official
//   bundle), pulls it back, and verifies both match field-for-field.
// - Extension: runs loadMapFromMapmakerPro() from mapmaker-pro.user.js in the official
//   page and checks that the export matches.
// - With --live: opens https://mapmaker.deeeep.io in the Mapmaker window and waits for
//   the editor to become ready (nothing is saved online).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const PATCHRIGHT = process.env.PATCHRIGHT_PATH || 'patchright'; // set PATCHRIGHT_PATH if patchright is installed globally
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const root = path.resolve(__dirname, '..', '..', '..');
const appDir = path.resolve(__dirname, '..');

async function main() {
  const live = process.argv.includes('--live');
  const { limitDecimals } = await import(pathToFileURL(path.join(appDir, 'src', 'engine', 'geometry.js')).href);
  const dpm = await import(pathToFileURL(path.join(appDir, 'src', 'engine', 'dpm.js')).href);
  const { MapDocument } = await import(pathToFileURL(path.join(appDir, 'src', 'engine', 'document.js')).href);
  const canonical = o => {
    const c = JSON.parse(JSON.stringify(o)); delete c.id;
    const walk = x => Array.isArray(x)
      ? x.map(walk)
      : (x && typeof x === 'object')
        ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]))
        : typeof x === 'number' ? limitDecimals(x, 3) : x;
    return walk(c);
  };
  const compare = (label, a, b) => {
    if (a.screenObjects.length !== b.screenObjects.length) throw new Error(`${label}: ${a.screenObjects.length} vs ${b.screenObjects.length} objects`);
    for (let i = 0; i < a.screenObjects.length; i++) {
      if (JSON.stringify(canonical(a.screenObjects[i])) !== JSON.stringify(canonical(b.screenObjects[i]))) {
        throw new Error(`${label}: object ${i} differs`);
      }
    }
    console.log(`PASS ${label} (${a.screenObjects.length} objects)`);
  };
  const exportOf = file => { const doc = new MapDocument(); doc.load(dpm.importMap(dpm.parseDpm(fs.readFileSync(file, 'utf8')))); return dpm.exportMap(doc); };
  const maps = [path.join(__dirname, 'fixtures', 'worldoffish.dpm')];

  const refServer = require(path.join(root, 'reference-study-2026-10-02', 'server.cjs'));
  const { _electron, chromium } = require(PATCHRIGHT);
  try {
    // Electron Mapmaker window
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mmp-bridge-'));
    const app = await _electron.launch({
      executablePath: process.env.MMP_EXE || require(path.join(appDir, 'node_modules', 'electron')),
      args: process.env.MMP_EXE ? ['--user-data-dir=' + userData] : [appDir, '--user-data-dir=' + userData],
      env: { ...process.env, MMP_MAPMAKER_URL: live ? '' : 'http://127.0.0.1:8795/' }
    });
    try {
      const win = await app.firstWindow();
      const cdp = await win.context().newCDPSession(win);
      const evaluate = async (fn, arg) => {
        const expr = '(' + fn.toString() + ')(' + JSON.stringify(arg ?? null) + ')';
        const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
        return r.result.value;
      };
      for (let i = 0; i < 60 && !(await evaluate(() => !!window.mmp)); i++) await new Promise(r => setTimeout(r, 300));
      for (const file of maps) {
        const ours = exportOf(file);
        const sent = await evaluate(text => window.mmpHost.mapmakerSend(text), JSON.stringify(ours));
        if (sent.error) throw new Error(sent.error);
        const pulled = await evaluate(() => window.mmpHost.mapmakerPull());
        if (pulled.error) throw new Error(pulled.error);
        compare('app -> Mapmaker window -> app: ' + path.basename(file), ours, JSON.parse(pulled.text));
      }
      const status = await evaluate(() => window.mmpHost.mapmakerStatus());
      console.log('Mapmaker window status', JSON.stringify(status));
      if (live) {
        console.log('Live site: editor ready in the Mapmaker window', status.ready === true);
        if (!status.ready) throw new Error('live Mapmaker did not become ready');
      }
    } finally {
      await app.close().catch(() => {});
      fs.rmSync(userData, { recursive: true, force: true });
    }

    // Extension loader in the official page
    const src = fs.readFileSync(path.join(root, 'mapmaker-pro', 'mapmaker-pro.user.js'), 'utf8');
    const m = src.match(/async function loadMapFromMapmakerPro\(map\) \{[\s\S]*?\r?\n  \}\r?\n/);
    if (!m) throw new Error('loadMapFromMapmakerPro not found in the userscript');
    const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-swiftshader'] });
    try {
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      const evaluate = async expr => {
        const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
        return r.result.value;
      };
      await page.goto('http://127.0.0.1:8795/', { waitUntil: 'load' });
      const readyExpr = '!!(window.app && app.fromJsonObject && app.layers && app.layers.length >= 16 && !app.loading)';
      for (let i = 0; i < 120 && !(await evaluate(readyExpr)); i++) await new Promise(r => setTimeout(r, 500));
      for (const file of maps) {
        const ours = exportOf(file);
        const out = await evaluate(
          `(async () => { ${m[0]}; const n = await loadMapFromMapmakerPro(${JSON.stringify(ours)}); ` +
          'return { n, map: app.toJsonObject(), dirty: vueData.mapDirty, undo: vueData.historyStatus.canUndo }; })()'
        );
        if (!out.dirty) throw new Error('mapDirty not set');
        if (out.undo) throw new Error('undo history should start empty after import');
        compare('extension loader in official editor: ' + path.basename(file), ours, out.map);
      }
    } finally { await browser.close(); }
  } finally { refServer.close(); }
  console.log('Bridge test passed');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
