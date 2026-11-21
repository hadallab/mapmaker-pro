'use strict';
// Renders build/icon.svg to PNG sizes with headless Chrome and writes build/icon.png and a
// multi-size build/icon.ico (PNG-compressed entries, supported since Windows Vista).

const fs = require('node:fs');
const path = require('node:path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PATCHRIGHT = process.env.PATCHRIGHT_PATH || 'patchright'; // set PATCHRIGHT_PATH if patchright is installed globally

async function main() {
  const dir = path.join(__dirname, '..', 'build');
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const { chromium } = require(PATCHRIGHT);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
  const pngs = {};
  try {
    for (const s of sizes) {
      const page = await browser.newPage({ viewport: { width: s, height: s }, deviceScaleFactor: 1 });
      await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="256" height="256"', `width="${s}" height="${s}"`)}</body></html>`);
      pngs[s] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(dir, 'icon.png'), pngs[512]);
  const entries = [16, 24, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((s, i) => {
    const b = 6 + i * 16;
    header.writeUInt8(s >= 256 ? 0 : s, b); header.writeUInt8(s >= 256 ? 0 : s, b + 1);
    header.writeUInt8(0, b + 2); header.writeUInt8(0, b + 3);
    header.writeUInt16LE(1, b + 4); header.writeUInt16LE(32, b + 6);
    header.writeUInt32LE(pngs[s].length, b + 8); header.writeUInt32LE(offset, b + 12);
    offset += pngs[s].length;
  });
  fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, ...entries.map(s => pngs[s])]));
  console.log('icon.png and icon.ico written');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
