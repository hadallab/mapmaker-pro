'use strict';
// Renders the same maps with the official engine (Pixi/WebGL, cached app.a86e76d3.js) and
// with the Mapmaker Pro canvas engine at identical size, then measures the pixel difference.
// Output: tests/artifacts/visual/<map>-{official,mmp,diff}.png and visual-report.json.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PATCHRIGHT = process.env.PATCHRIGHT_PATH || 'patchright'; // set PATCHRIGHT_PATH if patchright is installed globally
const { PNG } = require(path.join(root, 'node_modules', 'pngjs'));
const pixelmatch = require(path.join(root, 'node_modules', 'pixelmatch'));

const MAPS = [
  ['worldoffish', path.join(__dirname, 'fixtures', 'worldoffish.dpm')],
  ['1v1', path.join(root, '1v1', 'favorites-study-2026-10-22', 'sources', 'tsukuyomi_shrine_1v1.dpm')],
  ['1v1-coast', path.join(root, '1v1', 'favorites-study-2026-10-22', 'sources', 'coast_1v1.dpm')],
  ['pd', path.join(root, 'pd', 'favorites-study-2026-10-23', 'sources', 'lush_marble_pd.dpm')],
  ['ffa', path.join(root, 'ffa', 'favorites-study-2026-10-23', 'sources', 'grants_ffa.dpm')]
];
const HIDDEN = ['habitats', 'npc-spawns', 'food-spawns', 'currents', 'triggers', 'animals'];

async function main() {
  process.env.PORT = '8798';
  const refServer = require(path.join(root, 'reference-study-2026-10-02', 'server.cjs'));
  const http = require('node:http');
  const appRoot = path.resolve(__dirname, '..');
  const appServer = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.resolve(appRoot, '.' + (p === '/' ? '/src/index.html' : p));
    if (!file.startsWith(appRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    const ext = path.extname(file);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(8798, '127.0.0.1');

  const { chromium } = require(PATCHRIGHT);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-swiftshader'] });
  const outDir = path.join(__dirname, 'artifacts', 'visual');
  fs.mkdirSync(outDir, { recursive: true });
  const report = [];
  try {
    const mainWorld = async page => {
      const cdp = await page.context().newCDPSession(page);
      return async (fn, arg) => {
        const expr = '(' + fn.toString() + ')(' + JSON.stringify(arg ?? null) + ')';
        const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
        return r.result.value;
      };
    };
    const official = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const evalOfficial = await mainWorld(official);
    await official.goto('http://127.0.0.1:8795/', { waitUntil: 'load' });
    for (let i = 0; i < 120; i++) {
      const ready = await evalOfficial(() => !!(window.app && app.fromJsonObject && app.layers?.length >= 16 && !app.loading));
      if (ready) break;
      await new Promise(r => setTimeout(r, 500));
    }

    const mine = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const evalMine = await mainWorld(mine);
    await mine.goto('http://127.0.0.1:8798/src/index.html', { waitUntil: 'load' });
    for (let i = 0; i < 60 && !(await evalMine(() => !!window.mmp)); i++) await new Promise(r => setTimeout(r, 250));

    for (const [name, file] of MAPS) {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const W = Number(json.worldSize.width) * 10, H = Number(json.worldSize.height) * 10;
      const width = 1600, height = Math.round(width * H / W);
      const a = await evalOfficial(async ({ m, width, height, W, H, hidden }) => {
        await app.fromJsonObject(m);
        vueData.selectLayer(null); app.deselectAll();
        for (const id of hidden) { const l = app.getLayerById(id); if (l) l.visible = false; }
        if (app.minimap) app.minimap.visible = false;
        for (const o of Object.values(app.screenObjects)) if (o.ceilingIcon) o.ceilingIcon.visible = false;
        await new Promise(r => setTimeout(r, 1500));
        const r = app.app.renderer; r.resolution = 1; r.resize(width, height);
        app.viewport.resize(width, height, W, H); app.viewport.fit(false, W, H); app.viewport.moveCenter(W / 2, H / 2);
        r.render(app.app.stage);
        return app.app.view.toDataURL('image/png').split(',')[1];
      }, { m: json, width, height, W, H, hidden: HIDDEN });
      const b = await evalMine(async ({ text, width, height, W, H }) => {
        mmp.loadText(text, { name: 'x.dpm' });
        document.querySelectorAll('.modal-backdrop').forEach(x => x.remove());
        const canvas = document.createElement('canvas');
        const R = mmp.renderer.constructor;
        const r = new R(canvas, { catalog: mmp.catalog, assets: mmp.assets });
        r.gameView = true; r.dpr = 1; r.width = width; r.height = height; canvas.width = width; canvas.height = height;
        r.view = { cx: W / 2, cy: H / 2, zoom: width / W };
        for (let i = 0; i < 40; i++) { // wait for lazily loaded sprites
          const missing = [...mmp.doc.objects()].some(
            o => (o.type === 'H' || o.type === 'P') && !mmp.assets.spriteFor(o)
          );
          if (!missing) break;
          await new Promise(res => setTimeout(res, 100));
        }
        const visible = new Set([
          'ceilings', 'terrains', 'islands', 'props', 'platforms',
          'hide-spaces', 'air-pockets', 'background-terrains', 'water', 'sky'
        ]);
        r.renderScene({ doc: mmp.doc, visible, layerAlpha: () => 1, outline: false, backdrop: '#000' });
        return canvas.toDataURL('image/png').split(',')[1];
      }, { text: JSON.stringify(json), width, height, W, H });

      const A = PNG.sync.read(Buffer.from(a, 'base64')), B = PNG.sync.read(Buffer.from(b, 'base64'));
      const w = Math.min(A.width, B.width), hh = Math.min(A.height, B.height);
      const crop = img => { const o = new PNG({ width: w, height: hh }); PNG.bitblt(img, o, 0, 0, w, hh, 0, 0); return o; };
      const ca = crop(A), cb = crop(B), diff = new PNG({ width: w, height: hh });
      const bad = pixelmatch(ca.data, cb.data, diff.data, w, hh, { threshold: 0.18, includeAA: false });
      const ratio = bad / (w * hh);
      fs.writeFileSync(path.join(outDir, name + '-official.png'), PNG.sync.write(ca));
      fs.writeFileSync(path.join(outDir, name + '-mmp.png'), PNG.sync.write(cb));
      fs.writeFileSync(path.join(outDir, name + '-diff.png'), PNG.sync.write(diff));
      report.push({ map: path.basename(file), size: `${w}x${hh}`, differingPixels: bad, ratio: +(ratio * 100).toFixed(3) + '%' });
      console.log(name, path.basename(file), `${w}x${hh}`, 'differing pixels', bad, (ratio * 100).toFixed(3) + '%');
    }
  } finally {
    await browser.close();
    refServer.close(); appServer.close();
  }
  const summary = { checked: new Date().toISOString(), threshold: 0.18, maps: report };
  fs.writeFileSync(path.join(__dirname, 'artifacts', 'visual', 'visual-report.json'), JSON.stringify(summary, null, 2));
}

main().catch(e => { console.error(e); process.exitCode = 1; });
