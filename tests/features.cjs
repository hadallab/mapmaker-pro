'use strict';
// End-to-end checks of the editor features in a hidden Electron instance:
// shape operations, live symmetry, groups/names saved to the .mmp.json sidecar and
// restored on open, shortcut capture with real key events, reference image rendering,
// measure tool and history jumps. Exported DPMs must stay free of compatibility errors.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const PATCHRIGHT = process.env.PATCHRIGHT_PATH || 'patchright'; // set PATCHRIGHT_PATH if patchright is installed globally

async function main() {
  const { _electron } = require(PATCHRIGHT);
  const appDir = path.resolve(__dirname, '..');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mmp-features-'));
  const mapFile = path.join(userData, 'features.dpm');
  const app = await _electron.launch({
    executablePath: process.env.MMP_EXE || require(path.join(appDir, 'node_modules', 'electron')),
    args: process.env.MMP_EXE ? ['--user-data-dir=' + userData] : [appDir, '--user-data-dir=' + userData]
  });
  const errors = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', e => errors.push(e.message));
    win.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const cdp = await win.context().newCDPSession(win);
    const evaluate = async (fn, arg) => {
      const expr = '(' + fn.toString() + ')(' + JSON.stringify(arg ?? null) + ')';
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const key = async (k, code, modifiers = 0) => {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: k,
        code,
        modifiers,
        windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : undefined
      });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers });
    };
    for (let i = 0; i < 60 && !(await evaluate(() => !!window.mmp)); i++) await new Promise(r => setTimeout(r, 300));

    // Shapes, symmetry, groups and names
    const r1 = await evaluate(async () => {
      const ed = window.mmp;
      const { createObject } = await import('./engine/dpm.js');
      const ops = await import('./engine/ops.js');
      const sq = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
      let a, b, c, d;
      ed.edit('seed', () => {
        a = ed.doc.add(createObject('Ter', 'terrains', { points: sq(20, 100, 60, 60), texture: 5 }));
        b = ed.doc.add(createObject('Ter', 'terrains', { points: sq(50, 120, 60, 60), texture: 5 }));
        c = ed.doc.add(createObject('Ter', 'terrains', { points: sq(30, 110, 10, 10), texture: 5 }));
        d = ed.doc.add(createObject('Ter', 'terrains', { points: sq(120, 120, 10, 10), texture: 5 }));
      });
      ed.select([a, b]); ed.commands.run('shape.union');
      const union = ed.selected().map(o => o.points.length);
      ed.select([ed.selected()[0], c]); ed.commands.run('shape.subtract');
      const subtract = ed.selected().length;
      ed.select([ed.selected()[0], d]); ed.commands.run('obj.group');
      ed.meta.setName(ed.selected()[0], 'Cut island');
      ed.meta.setSymmetry('p');
      ed.edit('Draw terrain', () => ed.doc.add(createObject('Ter', 'terrains', { points: sq(10, 20, 20, 20), texture: 3 })));
      const before = ed.doc.layers.terrains.length;
      const src = ed.doc.layers.terrains.at(-2);
      ed.edit('Move', () => ops.translate(ed.doc, [src], 4, 0));
      const twin = ed.doc.get(ed.meta.twins.get(src.uid));
      const offset = ed.edit('Offset', () => ops.offsetSelection(ed.doc, [src], 10, 'round', 'background-terrains'));
      const smoothed = ed.edit('Smooth', () => ops.smoothSelection(ed.doc, [src], 2, 0.25));
      return {
        union,
        subtract,
        terrains: before,
        twinX: Math.min(...twin.points.map(p => p.x)),
        srcX: Math.min(...src.points.map(p => p.x)),
        W: ed.doc.pixelWidth,
        offset: offset.length,
        smoothed
      };
    });
    console.log('shapes/symmetry', JSON.stringify(r1));
    assert.deepEqual(r1.union, [8]);
    assert.equal(r1.subtract, 1, 'hole bridged into single polygon');
    assert.equal(r1.twinX, r1.W - (r1.srcX + 20), 'point-symmetric twin follows the move');
    assert.equal(r1.offset, 1);

    // Save with sidecar, reopen, verify restored metadata
    const r2 = await evaluate(async file => {
      const ed = window.mmp;
      const { serializeDpm } = await import('./engine/dpm.js');
      const { validate } = await import('./engine/validate.js');
      const errs = validate(ed.doc, ed.catalog).filter(i => i.severity === 'error').length;
      await window.mmpHost.save({ path: file, text: serializeDpm(ed.doc), sidecar: ed.meta.toSidecar() });
      ed.state.dirty = false;
      const f = await window.mmpHost.openPath(file);
      ed.loadText(f.text, f);
      document.querySelectorAll('.modal-backdrop').forEach(b => b.remove());
      const names = [...ed.meta.names.values()];
      const groups = new Set(ed.meta.groupOf.values()).size;
      return { errs, hasSidecar: !!f.sidecar, names, groups, twins: ed.meta.twins.size, symmetry: ed.meta.symmetry };
    }, mapFile);
    console.log('sidecar', JSON.stringify(r2));
    assert.equal(r2.errs, 0);
    assert.ok(fs.existsSync(mapFile + '.mmp.json'));
    assert.deepEqual(r2.names, ['Cut island']);
    assert.equal(r2.groups, 1);
    assert.equal(r2.twins, 4, 'two twin pairs: the drawn terrain and its offset copy');
    assert.equal(r2.symmetry, 'p');
    const dpm = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    assert.ok(!JSON.stringify(dpm).includes('Cut island'), 'editor metadata never enters the DPM');

    // Shortcut capture with real key events
    await evaluate(() => window.mmp.commands.run('edit.preferences'));
    await new Promise(r => setTimeout(r, 300));
    await evaluate(() => {
      const chip = [...document.querySelectorAll('.modal .keys button')].find(b => b.previousSibling?.textContent === 'Group');
      chip.click();
    });
    await key('k', 'KeyK', 2 /* ctrl */);
    await new Promise(r => setTimeout(r, 200));
    const r3 = await evaluate(() => ({
      group: window.mmp.commands.byKey.get('Ctrl+K')?.id,
      old: window.mmp.commands.byKey.get('Ctrl+G')?.id || null,
      saved: window.mmp.prefs.keys['cmd:obj.group']
    }));
    console.log('shortcut', JSON.stringify(r3));
    assert.equal(r3.group, 'obj.group');
    assert.equal(r3.old, null);
    await evaluate(() => {
      const chip = [...document.querySelectorAll('.modal .keys button')].find(b => b.previousSibling?.textContent === 'Ungroup');
      chip.click();
    });
    await key('k', 'KeyK', 2);
    await new Promise(r => setTimeout(r, 200));
    const clash = await evaluate(() => document.querySelector('.modal p.muted')?.textContent || '');
    console.log('conflict message:', clash);
    assert.match(clash, /already used/);
    await key('Escape', 'Escape');
    await evaluate(() => [...document.querySelectorAll('.modal .btn')].find(b => b.textContent === 'Reset all').click());
    const prefsFile = JSON.parse(fs.readFileSync(path.join(userData, 'store-prefs.json'), 'utf8'));
    assert.deepEqual(prefsFile.keys, {});
    await evaluate(() => document.querySelector('.modal-backdrop .btn.primary').click());

    // Reference image, measure tool and history jump
    const r4 = await evaluate(async () => {
      const ed = window.mmp;
      const c = document.createElement('canvas'); c.width = 40; c.height = 40;
      const g = c.getContext('2d'); g.fillStyle = '#ff00ff'; g.fillRect(0, 0, 40, 40);
      ed.meta.setReference({
        src: c.toDataURL(), name: 'magenta.png', x: 0, y: 0,
        width: ed.doc.pixelWidth, height: ed.doc.pixelHeight, aspect: 1, opacity: 1, above: true, visible: true
      });
      await new Promise(r => setTimeout(r, 300));
      ed.render();
      const s = document.getElementById('scene'), d = s.getContext('2d').getImageData(s.width / 2, s.height / 2, 1, 1).data;
      const magenta = d[0] > 200 && d[1] < 60 && d[2] > 200;
      ed.meta.setReference(null);
      ed.state.snapPoints = false;
      ed.state.snapEdges = false;
      ed.setTool('measure');
      const R = ed.renderer, vr = ed.viewport.getBoundingClientRect();
      const fire = (type, w) => {
        const p = R.toScreen(w.x, w.y);
        ed.viewport.dispatchEvent(new PointerEvent(type, {
          clientX: vr.left + p.x,
          clientY: vr.top + p.y,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          bubbles: true,
          pointerId: 1
        }));
      };
      fire('pointerdown', { x: 10, y: 10 }); fire('pointermove', { x: 40, y: 50 }); fire('pointerup', { x: 40, y: 50 });
      ed.render();
      const measured = Math.hypot(ed.tool.b.x - ed.tool.a.x, ed.tool.b.y - ed.tool.a.y) / 10;
      ed.setTool('select');
      const hist = ed.doc.history;
      const ops = await import('./engine/ops.js');
      const t0 = ed.doc.layers.terrains[0];
      ed.edit('Nudge A', () => ops.translate(ed.doc, [t0], 1, 0));
      ed.edit('Nudge B', () => ops.translate(ed.doc, [t0], 1, 0));
      const n = hist.undoStack.length;
      await new Promise(r => setTimeout(r, 300));
      const rows = document.querySelectorAll('#dock-bottom .pane-body')[2].querySelectorAll('.obj-row');
      rows[1].click(); // jump back to the first edit
      const after = hist.undoStack.length;
      while (hist.canRedo) hist.redo();
      return { magenta, measured, historyBefore: n, historyAfterJump: after, historyRestored: hist.undoStack.length };
    });
    console.log('reference/measure/history', JSON.stringify(r4));
    assert.ok(r4.magenta, 'reference image drawn above the map');
    assert.equal(r4.measured, 5);
    assert.equal(r4.historyAfterJump, 1);
    assert.equal(r4.historyRestored, r4.historyBefore);

    if (errors.length) throw new Error('renderer errors: ' + errors.join(' | '));
    console.log('Feature test passed');
  } finally {
    // The map is left with unsaved changes, so closing can stop at the save prompt.
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
