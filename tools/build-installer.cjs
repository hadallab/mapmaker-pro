'use strict';
// Builds dist/Mapmaker-Pro-Setup-<version>.exe (NSIS, per-user, .dpm association) plus the
// latest.yml that the in-app updater reads.
//
// Code signing: set CSC_LINK (path to a .pfx issued to "hadallab") and CSC_KEY_PASSWORD before
// running; electron-builder then signs the app and installer with SHA-256 and a timestamp.
// Without them the build is unsigned.
//
// Update feed: set MMP_UPDATE_URL to the address where dist/ files will be uploaded; it is
// written into latest.yml. The app's own check address is set in Preferences > Updates.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const builder = require('electron-builder');

const appDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
const config = JSON.parse(JSON.stringify(pkg.build));
if (process.env.MMP_UPDATE_URL) config.publish = { provider: 'generic', url: process.env.MMP_UPDATE_URL };
// Test builds: MMP_VERSION overrides the version, MMP_OUT the output folder.
if (process.env.MMP_VERSION) config.extraMetadata = { version: process.env.MMP_VERSION };
if (process.env.MMP_OUT) config.directories = { ...config.directories, output: process.env.MMP_OUT };

const signed = !!(process.env.CSC_LINK || process.env.WIN_CSC_LINK);
console.log(signed ? 'Signing with the certificate in CSC_LINK (publisher: hadallab)' : 'No certificate set (CSC_LINK): building unsigned');
// The publisher name is written into the app's update config, after which the updater only
// installs updates signed by that publisher. Unsigned builds leave it out so their updates
// are verified by SHA-512 alone; the first signed build switches signature checks on.
if (!signed) {
  if (config.win?.signtoolOptions) delete config.win.signtoolOptions.publisherName;
  config.win.verifyUpdateCodeSignature = false;
}

builder.build({ projectDir: appDir, config, publish: 'never', targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64) })
  .then(files => {
    for (const f of files.filter(f => /\.(exe|yml)$/i.test(f))) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      console.log(`${path.relative(appDir, f)}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB  sha256 ${hash.slice(0, 16)}...`);
    }
  })
  .catch(e => { console.error(e); process.exitCode = 1; });
