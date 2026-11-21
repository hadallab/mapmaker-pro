'use strict';
// Starts the real Electron app, opens a map through the preload bridge, edits, saves to a
// temporary file through the main process, and checks the saved file re-imports cleanly.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PATCHRIGHT = process.env.PATCHRIGHT_PATH || 'patchright'; // set PATCHRIGHT_PATH if patchright is installed globally

async function main() {
  const { _electron } = require(PATCHRIGHT);
  const appDir = path.resolve(__dirname, '..');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mmp-smoke-'));
  const fixture = path.join(__dirname, 'fixtures', 'worldoffish.dpm');
  const out = path.join(userData, 'saved.dpm');
  // MMP_EXE points at a packaged build (tools/package.cjs); default runs the source tree.
  const packaged = process.env.MMP_EXE;
  const app = await _electron.launch({
    executablePath: packaged || require(path.join(appDir, 'node_modules', 'electron')),
    args: packaged ? ['--user-data-dir=' + userData, fixture] : [appDir, '--user-data-dir=' + userData, fixture],
    cwd: packaged ? path.dirname(packaged) : appDir
  });
  const errors = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', e => errors.push(e.message));
    win.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    // Patchright evaluates in an isolated world by default; the app lives in the main world.
    const cdp = await win.context().newCDPSession(win);
    const evaluate = async (fn, arg) => {
      const expr = '(' + fn.toString() + ')(' + JSON.stringify(arg ?? null) + ')';
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    for (let i = 0; i < 60 && !(await evaluate(() => !!(window.mmp && window.mmp.doc.count() > 100))); i++) {
      await new Promise(r => setTimeout(r, 500));
    }
    await win.waitForTimeout(800);
    const info = await evaluate(() => ({
      host: window.mmpHost?.kind, objects: mmp.doc.count(), file: mmp.state.file.name, title: document.title,
      errors: mmp.issueSummary().error
    }));
    console.log('opened', JSON.stringify(info));
    if (info.host !== 'electron') throw new Error('preload bridge missing');
    // The scene canvas must contain the map, not just the backdrop colour.
    const pixels = await evaluate(() => new Promise(resolve => setTimeout(() => {
      const c = document.getElementById('scene');
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const colours = new Set();
      let lit = 0;
      for (let i = 0; i < d.length; i += 4 * 97) {
        colours.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
        if (d[i] + d[i + 1] + d[i + 2] > 120) lit++;
      }
      resolve({ size: c.width + 'x' + c.height, colours: colours.size, lit, visible: document.visibilityState });
    }, 300)));
    console.log('scene canvas', JSON.stringify(pixels));
    if (pixels.colours < 20) throw new Error('scene canvas looks empty');
    await win.screenshot({ path: path.join(__dirname, 'artifacts', 'electron-window.png') });

    // High-resolution screenshot: render the full map at 8K and put it on the clipboard.
    const shot = await evaluate(async () => {
      const S = await import('./ui/screenshot.js');
      const r = await S.renderShot(mmp, { rect: S.areaRect(mmp, 'map'), longSide: 8192, helpers: false, hiddenLayers: true, transparent: false });
      const blob = await new Promise(res => r.canvas.toBlob(res, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      const back = await navigator.clipboard.read();
      return { size: r.size.width + 'x' + r.size.height, png: blob.size, clipboardTypes: back[0]?.types || [] };
    });
    console.log('screenshot', JSON.stringify(shot));

    // Game simulation overlay: one food per spawn slot of the map (its trimmed food total).
    const sim = await evaluate(async () => {
      const { totalFood } = await import('./engine/dpm.js');
      mmp.sim.show.terrainFoods = false;
      mmp.commands.run('view.sim');
      const r = {
        expected: totalFood(mmp.doc),
        foods: mmp.sim.foods.length,
        npcs: mmp.sim.npcs.length,
        hud: getComputedStyle(document.querySelector('.sim-hud')).display
      };
      mmp.commands.run('view.sim');
      return r;
    });
    console.log('simulation', JSON.stringify(sim));
    if (!sim.foods || sim.foods !== sim.expected || sim.hud === 'none') throw new Error('simulation overlay mismatch');
    if (!shot.clipboardTypes.includes('image/png')) throw new Error('screenshot did not reach the clipboard');

    // edit + save through the main process (no dialog: path given)
    const saved = await evaluate(async target => {
      const { serializeDpm } = await import('./engine/dpm.js');
      mmp.edit('Smoke edit', () => { const o = mmp.doc.layers.terrains[0]; mmp.doc.touch(o); o.points[0].x += 1; });
      return await window.mmpHost.save({ path: target, text: serializeDpm(mmp.doc) });
    }, out);
    const reread = JSON.parse(fs.readFileSync(out, 'utf8'));
    console.log('saved', saved.name, reread.screenObjects.length, 'objects');
    const recent = await evaluate(() => window.mmpHost.recent());
    console.log('recent files', recent.length);
    if (errors.length) throw new Error('renderer errors: ' + errors.join(' | '));
    console.log('Electron smoke test passed');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
