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

// Throws StorageError on quota / write failure so callers can surface it.
function _lsSave(arr) {
  try {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(arr));
  } catch (e) {
    throw new StorageError('שגיאה בשמירה — אחסון מלא?', e);
  }
}

export async function loadSessions() {
  if (_degraded || !_db) return _lsLoad().sort((a, b) => b.id - a.id);
  return new Promise((resolve) => {
    const req = _db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.id - a.id));
    req.onerror = () => resolve(_lsLoad()); // read failure: degrade gracefully
  });
}

// Throws StorageError on write failure so callers know not to clear the draft.
export async function upsertSession(session) {
  if (_degraded || !_db) {
    const all = _lsLoad();
    const i = all.findIndex(s => s.id === session.id);
    if (i >= 0) all[i] = session; else all.unshift(session);
    _lsSave(all); // throws on localStorage failure
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(session);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(new StorageError('שגיאת אחסון — לא ניתן לשמור', tx.error));
  });
}

// Throws StorageError on write failure.
export async function removeSession(id) {
  if (_degraded || !_db) {
    const all = _lsLoad().filter(s => s.id !== id);
    _lsSave(all); // throws on localStorage failure
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(new StorageError('שגיאת אחסון — לא ניתן למחוק', tx.error));
  });
}

// saveDraft accepts { finalText, interimText?, activeSessionId? } or a legacy
// plain string.  savedAt is always stamped here.
// Returns true on success, false on storage failure — caller must check.
export function saveDraft(draft) {
  const d = typeof draft === 'string'
    ? { finalText: draft, interimText: '', activeSessionId: null, savedAt: Date.now() }
    : { interimText: '', activeSessionId: null, ...draft, savedAt: Date.now() };
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    return true;
  } catch (e) {
    console.warn('[storage] saveDraft failed:', e);
    return false;
  }
}

// Returns null when no draft exists.
// Always returns { finalText, interimText, activeSessionId, savedAt, legacyCombinedText }.
// legacyCombinedText: true — confirmed and unconfirmed speech were stored combined and
// cannot be separated; the UI must warn the user before treating finalText as confirmed.
export function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        // Current format: { finalText, interimText, ... }
        if (typeof obj.finalText === 'string') {
          return {
            finalText: obj.finalText,
            interimText: obj.interimText || '',
            activeSessionId: obj.activeSessionId ?? null,
            savedAt: obj.savedAt ?? null,
            legacyCombinedText: false,
          };
        }
        // Previous format: { text, activeSessionId, includesInterim }
        // includesInterim: true means text = finalText + interim combined; can't separate.
        if (typeof obj.text === 'string') {
          return {
            finalText: obj.text,
            interimText: '',
            activeSessionId: obj.activeSessionId ?? null,
            savedAt: obj.savedAt ?? null,
            legacyCombinedText: !!obj.includesInterim,
          };
        }
      }
    } catch {}
    // Oldest format: plain string
    return { finalText: raw, interimText: '', activeSessionId: null, savedAt: null, legacyCombinedText: true };
  } catch { return null; }
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

// Typed error so callers can distinguish storage failures from logic errors.
export class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
  }
}
