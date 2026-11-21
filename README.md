# Mapmaker Pro

A standalone Windows map editor for [Deeeep.io](https://deeeep.io). It reads and writes the same `.dpm` files as the official Mapmaker, works offline, and adds tools the official editor does not have: booleans, live symmetry, smart guides, a sculpt brush, a contour-snap pen, a knife and vertex bevel, a palette studio, a foliage brush, compatibility checks with one-click fixes, a game simulation overlay and screenshots up to 16K.

> **Unofficial.** Mapmaker Pro is a fan-made tool. It is not made, endorsed or supported by Deeeep.io or its developers.


## Download

Get the latest installer from the [Releases](https://github.com/hadallab/mapmaker-pro/releases/latest) page (`Mapmaker-Pro-Setup-x.y.z.exe`). The app checks this page when it starts and offers new versions; every download is verified against its SHA-512 before it installs.

## Building from source

Requirements: Node.js 20 or newer and Windows.

```
npm install
npm start          # run the editor
npm test           # engine tests
npm run dist       # build the installer into dist/
```

### Game art

The game's textures, animal sprites, foods and props belong to Deeeep.io and are **not** in this repository. The installers on the Releases page include them so the app works out of the box. To build from source, put the official Mapmaker assets in `assets/` (same layout as `src/data/catalog.json` expects: `assets/packs/...`, `assets/animals/...`, plus the Napoleon block sprites in `assets/img/sandblock.png` and `assets/img/sandblock_solid.png`). Without them the textures and sprites are missing.

### Browser-driven tests

`test:native`, `test:electron`, `test:features` and the other browser-driven tests use [patchright](https://www.npmjs.com/package/patchright). Install it, or set `PATCHRIGHT_PATH` to an existing copy. `test:native` also needs a folder of reference maps next to the project.

## Releasing an update

1. Raise `version` in `package.json`.
2. `npm run dist`
3. Create a GitHub release tagged `v<version>` and upload `dist/Mapmaker-Pro-Setup-<version>.exe`, its `.blockmap` and `dist/latest.yml`.

Installed copies find the new release on their next start.

## Licence

[MIT](LICENSE) for the source code. Deeeep.io's game art is excluded.
