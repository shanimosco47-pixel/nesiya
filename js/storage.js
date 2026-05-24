const DB_NAME = 'nesiya';
const DB_VERSION = 1;
const STORE = 'sessions';
const LEGACY_KEY = 'nesiya_sessions';
const DRAFT_KEY = 'nesiya_draft';

let _db = null;
let _degraded = false; // fall back to localStorage when IDB is unavailable

function _open() {
  return new Promise((resolve) => {
    if (_db) { resolve(_db); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) =>
      e.target.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = () => {
      _degraded = true;
      console.warn('[storage] IDB unavailable, using localStorage');
      resolve(null);
    };
  });
}

async function _migrate() {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw || !_db) return;
  try {
    const sessions = JSON.parse(raw);
    if (!sessions.length) { localStorage.removeItem(LEGACY_KEY); return; }
    const tx = _db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const s of sessions) store.put(s);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    localStorage.removeItem(LEGACY_KEY);
    console.log('[storage] migrated', sessions.length, 'sessions to IndexedDB');
  } catch (e) {
    console.warn('[storage] migration failed:', e);
  }
}

export async function initStorage() {
  await _open();
  await _migrate();
}

function _lsLoad() {
  try { return JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]'); } catch { return []; }
}
function _lsSave(arr) {
  try { localStorage.setItem(LEGACY_KEY, JSON.stringify(arr)); } catch {}
}

export async function loadSessions() {
  if (_degraded || !_db) return _lsLoad().sort((a, b) => b.id - a.id);
  return new Promise((resolve) => {
    const req = _db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.id - a.id));
    req.onerror = () => resolve(_lsLoad());
  });
}

export async function upsertSession(session) {
  if (_degraded || !_db) {
    const all = _lsLoad();
    const i = all.findIndex(s => s.id === session.id);
    if (i >= 0) all[i] = session; else all.unshift(session);
    _lsSave(all);
    return;
  }
  return new Promise((resolve) => {
    const tx = _db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(session);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

export async function removeSession(id) {
  if (_degraded || !_db) {
    _lsSave(_lsLoad().filter(s => s.id !== id));
    return;
  }
  return new Promise((resolve) => {
    const tx = _db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

export function saveDraft(text) {
  try { localStorage.setItem(DRAFT_KEY, text); } catch {}
}
export function loadDraft() {
  try { return localStorage.getItem(DRAFT_KEY) || ''; } catch { return ''; }
}
export function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}

export function formatDate(d) {
  return d.toLocaleDateString('he-IL', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}
