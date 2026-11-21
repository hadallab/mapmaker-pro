'use strict';
// Proof of compatibility against the real engine: every map exported by Mapmaker Pro is
// opened in the cached official Mapmaker bundle (app.a86e76d3.js, served by
// reference-study-2026-10-02/server.cjs) and exported again by that engine. The two exports
// must agree field-for-field, apart from ids that the official editor renumbers.
//
// Requires: Google Chrome and patchright (set PATCHRIGHT_PATH if it is installed elsewhere).

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..', '..', '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PATCHRIGHT = process.env.PATCHRIGHT_PATH || 'patchright'; // set PATCHRIGHT_PATH if patchright is installed globally

async function main() {
  const engine = p => import(pathToFileURL(path.join(__dirname, '..', 'src', 'engine', p)).href);
  const { MapDocument } = await engine('document.js');
  const dpm = await engine('dpm.js');
  const { limitDecimals } = await engine('geometry.js');

  const cases = [];
  const dirs = [['ffa', 'favorites-study-2026-10-23'], ['pd', 'favorites-study-2026-10-23'], ['1v1', 'favorites-study-2026-10-22']];
  for (const [mode, study] of dirs) {
    const dir = path.join(root, mode, study, 'sources');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.dpm'))) cases.push({ name: mode + '/' + f, file: path.join(dir, f) });
  }
  const only = process.argv.slice(2);
  const selected = only.length ? cases.filter(c => only.some(o => c.name.includes(o))) : cases;

  // A synthetic map built only with Mapmaker Pro factories and operations: every type,
  // every layer, rotated sprites, multi-stop gradients, triggers and spawns.
  const synthetic = () => {
    const doc = new MapDocument({ width: 60, height: 40 });
    const tx = doc.begin('build');
    const box = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    const ring = (cx, cy, r, n) => Array.from(
      { length: n },
      (_, i) => ({ x: cx + Math.cos(i / n * 6.283) * r * 1.3, y: cy + Math.sin(i / n * 6.283) * r })
    );
    doc.add(dpm.createObject('Sky', 'sky', { points: box(0, 0, 600, 120), colors: ['#102030', '#a0c0e0', '#ffffff'] }));
    doc.add(dpm.createObject('Wat', 'water', { points: box(0, 120, 600, 280) }));
    doc.add(dpm.createObject('Bg', 'background-terrains', { points: ring(300, 300, 60, 23), texture: 19, opacity: 0.35 }));
    doc.add(dpm.createObject('Air', 'air-pockets', { points: ring(100, 250, 30, 9), texture: 4, borderColor: '#336699' }));
    doc.add(dpm.createObject('Ter', 'terrains', { points: ring(300, 380, 120, 31), texture: 5 }));
    doc.add(dpm.createObject('Ter', 'islands', { points: ring(500, 360, 40, 7), texture: 9 }));
    doc.add(dpm.createObject('Ter', 'platforms', { points: box(40, 200, 80, 6), texture: 17 }));
    doc.add(dpm.createObject('C', 'ceilings', { points: ring(450, 250, 20, 6), texture: 3 }));
    doc.add(dpm.createObject('Cu', 'currents', { points: ring(200, 160, 40, 8), settings: { angle: -45, strength: 35 } }));
    doc.add(dpm.createObject('Hab', 'habitats', { position: { x: 0, y: 0 }, size: { width: 300, height: 400 }, settings: { area: 37 } }));
    doc.add(dpm.createObject('Hab', 'habitats', { position: { x: 300, y: 0 }, size: { width: 300.12345, height: 400 }, settings: { area: 42 } }));
    doc.add(dpm.createObject('Food', 'food-spawns', {
      position: { x: 50, y: 130 }, size: { width: 120.5, height: 60.25 }, settings: { foodIds: [1, 16], count: 30 }
    }));
    doc.add(dpm.createObject('NPC', 'npc-spawns', {
      position: { x: 320, y: 140 }, size: { width: 90, height: 70 }, settings: { fishLevels: [18, 25], animalCount: 4, npcType: 3 }
    }));
    doc.add(dpm.createObject('Tr', 'triggers', {
      position: { x: 0, y: 150 },
      size: { width: 10, height: 40 },
      triggers: [
        { actions: [{ type: 1, data: { pos: { x: 590, y: 170 } } }], delay: 0, when: 1 },
        { actions: [{ type: 2 }], delay: 0, when: 3 }
      ]
    }));
    doc.add(dpm.createObject('H', 'hide-spaces', { x: 260.1234, y: 300.5, rotation: 33.333, hSType: 28 }));
    doc.add(dpm.createObject('H', 'hide-spaces', { x: 280, y: 300, rotation: -120, hSType: 36, opacity: 0.45 }));
    doc.add(dpm.createObject('A', 'animals', { x: 150, y: 180, rotation: 90, fLevel: 25 }));
    doc.add(dpm.createObject('P', 'props', { x: 420, y: 330, rotation: 12.5, pType: 1, params: { text: 'Mapmaker Pro\nround-trip' } }));
    doc.add(dpm.createObject('P', 'props', { x: 460, y: 330, pType: 3 }));
    tx.commit();
    return dpm.exportMap(doc);
  };

  const canonical = o => {
    const c = JSON.parse(JSON.stringify(o));
    delete c.id;
    const walk = x => Array.isArray(x)
      ? x.map(walk)
      : (x && typeof x === 'object')
        ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]))
        : typeof x === 'number' ? limitDecimals(x, 3) : x;
    return walk(c);
  };

  const server = require(path.join(root, 'reference-study-2026-10-02', 'server.cjs'));
  const { chromium } = require(PATCHRIGHT);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-swiftshader'] });
  const report = { engine: 'app.a86e76d3.js v0.1.8', checked: new Date().toISOString(), maps: [] };
  let failures = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    // Patchright evaluates in an isolated world; the engine globals live in the main world.
    const cdp = await page.context().newCDPSession(page);
    const evaluate = async (fn, arg) => {
      const expr = '(' + fn.toString() + ')(' + JSON.stringify(arg ?? null) + ')';
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    await page.goto('http://127.0.0.1:8795/', { waitUntil: 'load', timeout: 60000 });
    for (let i = 0; i < 120; i++) {
      const ready = await evaluate(() => !!(
        window.app && window.app.fromJsonObject && window.vueData && app.layers?.length >= 16 && !app.loading
      ));
      if (ready) break;
      await new Promise(r => setTimeout(r, 500));
    }

    const run = async (name, ours) => {
      pageErrors.length = 0;
      const native = await evaluate(async m => {
        await app.fromJsonObject(JSON.parse(JSON.stringify(m)));
        await new Promise(r => setTimeout(r, 400));
        return app.toJsonObject();
      }, ours);
      const diffs = [];
      if (native.screenObjects.length !== ours.screenObjects.length) diffs.push(`count ours ${ours.screenObjects.length} native ${native.screenObjects.length}`);
      const n = Math.min(native.screenObjects.length, ours.screenObjects.length);
      for (let i = 0; i < n && diffs.length < 8; i++) {
        const a = canonical(ours.screenObjects[i]), b = canonical(native.screenObjects[i]);
        const ka = Object.keys(a).join(), kb = Object.keys(b).join();
        if (ka !== kb) diffs.push(`#${i} ${a.type} keys ours [${ka}] native [${kb}]`);
        else if (JSON.stringify(a) !== JSON.stringify(b)) {
          for (const k of Object.keys(a)) {
            if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
              diffs.push(`#${i} ${a.type}.${k} ours ${JSON.stringify(a[k]).slice(0, 160)} native ${JSON.stringify(b[k]).slice(0, 160)}`);
            }
          }
        }
      }
      const sameSize = Number(native.worldSize.width) === Number(ours.worldSize.width) &&
        Number(native.worldSize.height) === Number(ours.worldSize.height);
      if (!sameSize) diffs.push('worldSize differs');
      if (JSON.stringify(native.settings) !== JSON.stringify(ours.settings)) diffs.push('settings differ ' + JSON.stringify(native.settings));
      if (pageErrors.length) diffs.push('page errors: ' + pageErrors.slice(0, 3).join(' | '));
      const ok = diffs.length === 0;
      if (!ok) failures++;
      report.maps.push({ name, objects: ours.screenObjects.length, ok, diffs });
      console.log((ok ? 'PASS ' : 'FAIL ') + name + ' (' + ours.screenObjects.length + ' objects)' + (ok ? '' : '\n  ' + diffs.join('\n  ')));
    };

    await run('synthetic: every type and layer', synthetic());
    for (const c of selected) {
      const json = dpm.parseDpm(fs.readFileSync(c.file, 'utf8'));
      const imported = dpm.importMap(json);
      const doc = new MapDocument();
      doc.load(imported);
      await run(c.name, dpm.exportMap(doc));
    }
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
  }
  report.passed = failures === 0;
  fs.writeFileSync(path.join(__dirname, 'native-roundtrip-report.json'), JSON.stringify(report, null, 2));
  console.log(failures ? `${failures} map(s) differ from the official engine` : 'All maps match the official engine export');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
