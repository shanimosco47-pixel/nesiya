import { diagLog } from './diagnostics.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const MAX_CONSECUTIVE_ERRORS = 5;

// Diagnostic-only state — not used for any behavioral decisions.
let _sessionStartTime = 0;
let _lastEndError = null; // error code from onerror before onend fires

export const state = {
  isRecording: false,
  isPaused: false,
  finalText: '',
  sessionFinalText: '',
};

// Callbacks wired by app.js
export const handlers = {
  onResult: null,      // (finalText, sessionFinalText, interim) => void
  onResetSilence: null, // () => void
  onError: null,        // (msg) => void
  onFatalAbort: null,  // () => void — called on fatal error (mic denied, audio-capture); no beep/save
};

let _rec = null;
let _restartPending = false;
let _sessionId = 0;
let _finalCount = 0;
let _errCount = 0;
// True from _init() until the first onresult fires — the window where Chrome
// Android may replay previous-session text at the start of a new session.
let _atSessionStart = false;

export function isSupported() { return !!SR; }

// Minimum word overlap required to consider a repetition as Chrome's inter-session
// replay rather than legitimate repeated phrasing (e.g. a name used twice).
const MIN_OVERLAP_WORDS = 3;

export function dedupeAppend(existing, addition) {
  if (!addition.trim()) return existing;
  if (!existing.trim()) return addition.trim() + ' ';
  const a = existing.trimEnd().split(/\s+/);
  const b = addition.trim().split(/\s+/);
  for (let len = Math.min(a.length, b.length, 20); len >= MIN_OVERLAP_WORDS; len--) {
    if (a.slice(-len).join(' ') === b.slice(0, len).join(' ')) {
      const rest = b.slice(len).join(' ');
      return a.join(' ') + (rest ? ' ' + rest : '') + ' ';
    }
  }
  return existing.trimEnd() + ' ' + addition.trim() + ' ';
}

function _init() {
  if (!SR) { handlers.onError?.('הדפדפן לא תומך בזיהוי דיבור'); return false; }
  const id = ++_sessionId;
  _finalCount = 0;
  _lastEndError = null;
  _sessionStartTime = Date.now();
  _atSessionStart = true; // Chrome Android may replay prev-session text in first onresult
  diagLog('session_start', { id });
  _rec = new SR();
  _rec.lang = 'he-IL';
  _rec.continuous = true;
  _rec.interimResults = true;
  _rec.maxAlternatives = 1;

  _rec.onresult = (e) => {
    if (_sessionId !== id) return;
    _errCount = 0;
    handlers.onResetSilence?.();
    // Capture and clear the flag before any await/callback so subsequent
    // results in the same session are treated as trusted mid-session text.
    const isFirstResult = _atSessionStart;
    _atSessionStart = false;
    let interim = '', newFinal = '';
    for (let i = _finalCount; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) { newFinal += t + ' '; _finalCount = i + 1; }
      else interim += t;
    }
    if (newFinal) {
      // Only deduplicate on the first result of a new session — the only moment
      // Chrome Android replays previously-spoken text. Mid-session results are
      // trusted directly to avoid removing legitimate repeated words/names.
      state.finalText = isFirstResult
        ? dedupeAppend(state.finalText, newFinal)
        : state.finalText + newFinal;
      state.sessionFinalText += newFinal;
    }
    diagLog('result', {
      id,
      final: newFinal.trim().slice(0, 60) || undefined,
      interim: interim.slice(0, 30) || undefined,
      firstResult: isFirstResult || undefined,
    });
    handlers.onResult?.(state.finalText, state.sessionFinalText, interim);
  };

  _rec.onerror = (e) => {
    if (_sessionId !== id) return;
    _lastEndError = e.error; // capture for onend diagnostic before it clears
    console.log('[recognition] error:', e.error, '(session', id, ')');
    diagLog('error', { id, error: e.error });
    if (e.error === 'no-speech') return;

    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      handlers.onError?.('הרשאת מיקרופון נדחתה — בדוק הגדרות');
      _kill();
      return;
    }
    if (e.error === 'audio-capture') {
      handlers.onError?.('מיקרופון לא נמצא');
      _kill();
      return;
    }

    _errCount++;
    if (e.error === 'network') {
      handlers.onError?.('שגיאת רשת...');
    } else {
      console.warn('[recognition] unhandled error:', e.error, 'streak:', _errCount);
    }
    if (_errCount >= MAX_CONSECUTIVE_ERRORS) {
      handlers.onError?.('שגיאות חוזרות — הפסקת הקלטה');
      _kill();
    }
  };

  _rec.onend = () => {
    if (_sessionId !== id) return;
    const endError = _lastEndError;
    diagLog('recognition_end', {
      id,
      endError,
      isRecording: state.isRecording,
      isPaused: state.isPaused,
      restartPending: _restartPending,
      msSinceStart: Date.now() - _sessionStartTime,
    });

    if (!state.isRecording || state.isPaused || _restartPending) {
      diagLog('restart_skipped', {
        reason: !state.isRecording ? 'stopped' : state.isPaused ? 'paused' : 'already_pending',
      });
      return;
    }

    diagLog('restart_scheduled', {
      id,
      delay: 150,
      reason: endError ?? 'unexpectedEnd',
      msSinceStart: Date.now() - _sessionStartTime,
    });
    _restartPending = true;
    setTimeout(() => {
      _restartPending = false;
      if (state.isRecording && !state.isPaused) _restart();
    }, 150);
  };

  return true;
}

function _kill() {
  state.isRecording = false;
  state.isPaused = false;
  _restartPending = false;
  try { _rec?.stop(); _rec = null; } catch {}
  handlers.onFatalAbort?.();
}

function _restart() {
  diagLog('restart_exec');
  if (!_init()) return;
  try {
    _rec.start();
  } catch (e) {
    console.warn('[recognition] start failed, retry in 500 ms');
    setTimeout(() => {
      if (state.isRecording && !state.isPaused) {
        try { _rec.start(); } catch (e2) { console.error('[recognition] retry failed', e2); }
      }
    }, 500);
  }
}

export function startRecognition(existingText = '') {
  state.finalText = existingText;
  state.sessionFinalText = '';
  state.isRecording = true;
  state.isPaused = false;
  _restartPending = false;
  _errCount = 0;
  if (!_init()) { state.isRecording = false; return false; }
  try {
    _rec.start();
  } catch (e) {
    console.error('[recognition] initial start failed', e);
    state.isRecording = false;
    return false;
  }
  return true;
}

export function stopRecognition() {
  state.isRecording = false;
  state.isPaused = false;
  _restartPending = false;
  try { _rec?.stop(); _rec = null; } catch {}
}

// Promote arbitrary text to rec.finalText — call before pause or resume so
// the textarea (source of truth) is always what the next session starts from.
export function promoteFinalText(text) {
  state.finalText = text.trim() ? text.trim() + ' ' : '';
}

export function pauseRecognition() {
  if (!state.isRecording || state.isPaused) return;
  state.isPaused = true;
  try { _rec?.stop(); } catch {}
}

export function resumeRecognition() {
  if (!state.isRecording || !state.isPaused) return;
  state.isPaused = false;
  _restart();
}
