'use strict';
// Update pipeline test. A packaged build (dist/win-unpacked, version from package.json)
// checks a local feed that serves a newer build, downloads it and verifies the SHA-512
// from latest.yml. A second feed with a tampered checksum must be rejected.
// Nothing is installed.
//
//   MMP_NEXT=<folder with Mapmaker-Pro-Setup-x.y.z.exe and latest.yml> node tests/update.cjs

const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const PATCHRIGHT = process.env.PATCHRIGHT_PATH || 'patchright'; // set PATCHRIGHT_PATH if patchright is installed globally

async function main() {
  const appDir = path.resolve(__dirname, '..');
  const next = process.env.MMP_NEXT;
  if (!next || !fs.existsSync(path.join(next, 'latest.yml'))) throw new Error('Set MMP_NEXT to a folder built with a newer version');
  const latest = fs.readFileSync(path.join(next, 'latest.yml'), 'utf8');
  const tampered = latest.replace(/sha512: (\S+)/g, (_m, h) => 'sha512: ' + (h[0] === 'A' ? 'B' : 'A') + h.slice(1));
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const bad = url.startsWith('/bad/');
    const name = url.replace(/^\/(good|bad)\//, '');
    if (name === 'latest.yml') { res.writeHead(200, { 'Content-Type': 'text/yaml' }); return res.end(bad ? tampered : latest); }
    const file = path.join(next, path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  }).listen(8799, '127.0.0.1');

  const { _electron } = require(PATCHRIGHT);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mmp-update-'));
  const exe = path.join(appDir, 'dist', 'win-unpacked', 'Mapmaker Pro.exe');
  const app = await _electron.launch({ executablePath: exe, args: ['--user-data-dir=' + userData] });
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
    const good = await evaluate(async () => {
      const c = await window.mmpHost.updateCheck('http://127.0.0.1:8799/good/');
      const d = c.available ? await window.mmpHost.updateDownload() : null;
      return { check: c, download: d };
    });
    console.log('good feed', JSON.stringify(good));
    assert.equal(good.check.available, true);
    assert.ok(good.download?.ok, 'download verified');

    const bad = await evaluate(async () => {
      const c = await window.mmpHost.updateCheck('http://127.0.0.1:8799/bad/');
      const d = c.available ? await window.mmpHost.updateDownload() : null;
      return { check: c, download: d };
    });
    console.log('tampered feed', JSON.stringify(bad).slice(0, 300));
    assert.ok(bad.download?.error && /sha512|checksum/i.test(bad.download.error), 'tampered download rejected');
    console.log('Update test passed');
  } finally {
    await app.close().catch(() => {});
    server.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
