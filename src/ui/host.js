// File-system bridge. Inside the Electron app this is preload.cjs; in a plain browser
// (development preview) it falls back to file inputs, downloads and localStorage.

function browserHost() {
  const pick = () => new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.dpm,.json';
    input.onchange = async () => {
      const f = input.files[0];
      resolve(f ? { path: null, name: f.name, text: await f.text() } : null);
    };
    input.click();
  });
  const download = (name, href) => {
    const a = document.createElement('a');
    a.href = href; a.download = name;
    document.body.append(a); a.click(); a.remove();
  };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('mmp:' + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('mmp:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
  };
  return {
    kind: 'browser',
    openDialog: pick,
    openPath: async () => ({ error: 'Opening by path needs the desktop app' }),
    async save({ text, defaultName, path }) {
      const name = defaultName || 'map.dpm';
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      download(name, url);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return { path: path || null, name };
    },
    async exportPng({ bytes, dataUrl, defaultName }) {
      const url = bytes ? URL.createObjectURL(new Blob([bytes], { type: 'image/png' })) : dataUrl;
      download(defaultName || 'map.png', url);
      if (bytes) setTimeout(() => URL.revokeObjectURL(url), 5000);
      return { path: null };
    },
    async reveal() {},
    async recent() { return []; },
    async clearRecent() {},
    async storeGet(name) { return store.get(name); },
    async storeSet(name, value) { store.set(name, value); },
    async writeRecovery(text) { try { localStorage.setItem('mmp:recovery', text); } catch { /* too large or blocked */ } },
    async readRecovery() { try { return localStorage.getItem('mmp:recovery'); } catch { return null; } },
    async clearRecovery() { try { localStorage.removeItem('mmp:recovery'); } catch { /* blocked */ } },
    async pendingOpen() { return null; },
    async version() { return 'browser preview'; },
    async confirmClose() {},
    onRequestClose() {},
    onOpenPath() {}
  };
}

export const host = window.mmpHost || browserHost();
