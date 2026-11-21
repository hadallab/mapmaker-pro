// Preferences: keyboard shortcuts and updates. Stored with host.storeSet('prefs').

import { TOOL_DEFS } from './tools.js';
import { keyString } from './commands.js';
import { h, clear, toggle } from './dom.js';
import { modal, confirm, alert } from './dialogs.js';
import { host } from './host.js';

const DEFAULT_TOOL_KEYS = Object.fromEntries(Object.entries(TOOL_DEFS).map(([k, d]) => [k, d.key]));

export async function loadPreferences(ed) {
  ed.prefs = { keys: {}, updateUrl: '', autoCheck: true, ...((await host.storeGet('prefs')) || {}) };
  applyKeymap(ed);
  if (ed.prefs.autoCheck && host.updateCheck) setTimeout(() => checkUpdates(ed, false), 4000);
}

async function savePreferences(ed) {
  await host.storeSet('prefs', ed.prefs);
}

// Overrides: { 'cmd:<id>': 'Ctrl+K' | '', 'tool:<name>': 'B' | '' } ('' removes the key).
export function applyKeymap(ed) {
  const k = ed.prefs?.keys || {};
  for (const c of ed.commands.list) {
    if (!('defaultKeys' in c)) { c.defaultKeys = c.keys || ''; c.defaultAlt = c.alt || []; }
    const o = k['cmd:' + c.id];
    c.keys = o !== undefined ? o : c.defaultKeys;
    c.alt = o !== undefined ? [] : c.defaultAlt;
  }
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    const o = k['tool:' + name];
    def.key = o !== undefined ? o : DEFAULT_TOOL_KEYS[name];
  }
  ed.commands.rebuildKeys();
  ed.emit('keymap');
}

function bindings(ed) {
  const rows = [];
  for (const [name, def] of Object.entries(TOOL_DEFS)) rows.push({ id: 'tool:' + name, group: 'Tools', label: def.title, key: def.key || '' });
  for (const c of ed.commands.list) rows.push({ id: 'cmd:' + c.id, group: groupOf(c.id), label: ed.commands.label(c), key: c.keys || '' });
  return rows;
}

function groupOf(id) {
  const p = id.split('.')[0];
  return { file: 'File', edit: 'Edit', obj: 'Object', shape: 'Shape', view: 'View', sym: 'View', mm: 'Mapmaker', help: 'Help' }[p] || 'Other';
}

export function openPreferences(ed) {
  let tab = 'keys', capture = null, filter = '';
  const body = h('div');
  const draw = () => {
    clear(body);
    const seg = h('div', { class: 'seg', style: { marginBottom: '12px' } });
    for (const [id, label] of [['keys', 'Shortcuts'], ['updates', 'Updates']]) {
      const b = h('button', { class: tab === id ? 'on' : '' }, label);
      b.addEventListener('click', () => { tab = id; capture = null; draw(); });
      seg.append(b);
    }
    body.append(seg);
    if (tab === 'keys') drawKeys(); else drawUpdates();
  };

  const drawKeys = () => {
    const search = h('input', { placeholder: 'Search commands', value: filter });
    search.addEventListener('input', () => { filter = search.value.toLowerCase(); fillList(); });
    search.addEventListener('keydown', e => e.stopPropagation());
    const reset = h('button', { class: 'btn small' }, 'Reset all');
    reset.addEventListener('click', async () => { ed.prefs.keys = {}; applyKeymap(ed); await savePreferences(ed); fillList(); });
    const list = h('div', { class: 'keys', style: { maxHeight: '360px', overflow: 'auto', paddingRight: '6px' } });
    const note = h('p', { class: 'muted', style: { margin: '8px 0 0' } }, 'Click a shortcut, then press the new keys. Backspace removes it, Esc cancels.');
    body.append(h('div', { class: 'row' }, h('div', { class: 'search' }, search), reset), list, note);
    const fillList = () => {
      clear(list);
      let group = null;
      for (const r of bindings(ed)) {
        if (filter && !r.label.toLowerCase().includes(filter) && !r.key.toLowerCase().includes(filter)) continue;
        if (r.group !== group) { group = r.group; list.append(h('h4', {}, group)); }
        const chip = h('button', {
          class: 'btn small' + (capture === r.id ? ' on' : ''),
          style: { minWidth: '110px', justifyContent: 'center' }
        }, capture === r.id ? 'Press keys...' : (r.key || 'none'));
        chip.addEventListener('click', () => { capture = r.id; fillList(); });
        list.append(h('span', {}, r.label), chip);
      }
    };
    fillList();
    onCapture = async e => {
      if (!capture) return false;
      e.preventDefault(); e.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return true;
      if (e.key === 'Escape') { capture = null; fillList(); return true; }
      const id = capture;
      let key = e.key === 'Backspace' ? '' : keyString(e);
      if (id.startsWith('tool:') && key && /^(Ctrl|Alt)\+/.test(key)) {
        note.textContent = 'Tool shortcuts are single keys without Ctrl or Alt.';
        return true;
      }
      const clash = key && bindings(ed).find(r => r.key === key && r.id !== id);
      if (clash) { note.textContent = `${key} is already used by "${clash.label}". Change that one first.`; return true; }
      ed.prefs.keys[id] = key;
      capture = null;
      applyKeymap(ed);
      await savePreferences(ed);
      note.textContent = key ? `Saved: ${key}` : 'Shortcut removed';
      fillList();
      return true;
    };
  };

  const drawUpdates = () => {
    const url = h('input', {
      type: 'text',
      class: 'text',
      value: ed.prefs.updateUrl || '',
      placeholder: 'Empty: GitHub Releases (hadallab/mapmaker-pro)'
    });
    url.addEventListener('keydown', e => e.stopPropagation());
    url.addEventListener('change', async () => { ed.prefs.updateUrl = url.value.trim(); await savePreferences(ed); });
    const check = h('button', { class: 'btn primary' }, 'Check now');
    check.addEventListener('click', async () => { ed.prefs.updateUrl = url.value.trim(); await savePreferences(ed); checkUpdates(ed, true); });
    body.append(
      h('p', {},
        'Mapmaker Pro gets new versions from its GitHub Releases page and installs them only after checking the SHA-512 of the download. ' +
        'Leave the address empty for GitHub, or enter another address that serves latest.yml.'),
      h('div', { class: 'row' }, h('span', { class: 'k' }, 'Update address'), url),
      h('div', { class: 'row' }, toggle({
        checked: !!ed.prefs.autoCheck,
        label: 'Check when Mapmaker Pro starts',
        onChange: async v => { ed.prefs.autoCheck = v; await savePreferences(ed); }
      })),
      h('div', { class: 'row', style: { marginTop: '8px' } }, check));
  };

  let onCapture = async () => false;
  draw();
  return modal({
    title: 'Preferences', wide: true, body,
    buttons: [{ label: 'Close', primary: true, value: true }],
    onKey: e => { if (capture) onCapture(e); },
    captureKeys: () => !!capture
  });
}

let updateBusy = false;
export async function checkUpdates(ed, manual) {
  if (!host.updateCheck) { if (manual) alert('Updates', 'Updates are available in the installed desktop app.'); return; }
  if (updateBusy) return;
  updateBusy = true;
  try {
    const r = await host.updateCheck(ed.prefs?.updateUrl || '');
    if (r.error) { if (manual) alert('Update check failed', r.error); return; }
    if (!r.available) { if (manual) alert('Up to date', `Mapmaker Pro ${r.current} is the latest version.`); return; }
    const dl = await confirm(
      'Update available',
      `Mapmaker Pro ${r.latest} is available (you have ${r.current}). Download it now?`,
      'Download'
    );
    if (!dl) return;
    ed.toast('Downloading update...');
    const d = await host.updateDownload();
    if (d.error) { alert('Download failed', d.error); return; }
    const restart = await confirm(
      'Update ready',
      `Version ${r.latest} has been downloaded and verified. Restart and install now? Unsaved changes are asked about first.`,
      'Restart'
    );
    if (restart) {
      if (await ed.confirmDiscard()) host.updateInstall();
    } else ed.toast('The update installs when you quit Mapmaker Pro', 'ok');
  } finally { updateBusy = false; }
}

let lastStep = -1;
export function bindUpdateEvents(ed) {
  host.onUpdateEvent?.(e => {
    if (e.type === 'progress') {
      const step = Math.floor(e.percent / 25);
      if (step !== lastStep) { lastStep = step; ed.toast(`Downloading update ${Math.round(e.percent)}%`); }
    }
    if (e.type === 'error') ed.toast('Update error: ' + e.message, 'err');
  });
}
