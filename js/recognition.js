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
  onResult: null,       // (finalText, sessionFinalText, interim) => void
  onResetSilence: null, // () => void
  onError: null,        // (msg) => void
  onFatalAbort: null,   // () => void — called on fatal error (mic denied, audio-capture)
};

let _rec = null;
let _restartPending = false;
let _sessionId = 0;
let _errCount = 0;

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
  _lastEndError = null;
  _sessionStartTime = Date.now();
  // Capture the confirmed transcript before this session starts.
  // onresult rebuilds from e.results and prepends this — never appends to it.
  const committedText = state.finalText;
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

    // Rebuild the full session transcript from e.results on every event.
    // With continuous=true Chrome accumulates results in e.results — treating
    // it as the authoritative source for this session eliminates within-session
    // duplication that arose from incremental append + _finalCount tracking.
    let sessionFinal = '';
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      const t = r[0].transcript;
      if (r.isFinal) sessionFinal += t + ' ';
      else interim += t;
    }

    // Prepend committedText, deduping the boundary to handle Chrome Android's
    // inter-session text replay. The start of sessionFinal is stable across
    // calls (Chrome only appends to e.results), so the overlap is detected
    // consistently — equivalent to checking only on the first result.
    state.finalText = sessionFinal
      ? dedupeAppend(committedText, sessionFinal)
      : committedText;
    state.sessionFinalText = sessionFinal;

    diagLog('result', {
      id,
      resultIndex: e.resultIndex,
      resultsLen: e.results.length,
      results: Array.from({ length: e.results.length }, (_, i) => ({
        i,
        isFinal: e.results[i].isFinal,
        t: e.results[i][0].transcript.slice(0, 40),
      })),
      displayLen: (state.finalText + interim).length,
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
