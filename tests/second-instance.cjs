'use strict';
// Clicking the shortcut while Mapmaker Pro already runs must bring its window to the front,
// even when that window is hidden or minimised (the second process only signals the first).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const PATCHRIGHT = process.env.PATCHRIGHT_PATH || 'patchright'; // set PATCHRIGHT_PATH if patchright is installed globally

async function main() {
  const exe = process.env.MMP_EXE || path.resolve(__dirname, '..', 'dist', 'win-unpacked', 'Mapmaker Pro.exe');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mmp-second-'));
  const { _electron } = require(PATCHRIGHT);
  const app = await _electron.launch({ executablePath: exe, args: ['--user-data-dir=' + userData] });
  try {
    await app.firstWindow();
    const state = () => app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find(x => x.getTitle().includes('Mapmaker Pro'));
      return { visible: w.isVisible(), minimized: w.isMinimized() };
    });
    for (const how of ['hide', 'minimize']) {
      await app.evaluate(({ BrowserWindow }, h) => BrowserWindow.getAllWindows()[0][h](), how);
      await new Promise(r => setTimeout(r, 500));
      const before = await state();
      const second = spawn(exe, ['--user-data-dir=' + userData], { stdio: 'ignore' });
      const code = await new Promise(r => second.on('exit', r));
      await new Promise(r => setTimeout(r, 800));
      const after = await state();
      console.log(how, 'before', JSON.stringify(before), 'second instance exit', code, 'after', JSON.stringify(after));
      assert.equal(after.visible, true);
      assert.equal(after.minimized, false);
    }
    console.log('Second-instance test passed');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
