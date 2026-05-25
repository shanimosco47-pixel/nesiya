import { diagLog } from './diagnostics.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const MAX_CONSECUTIVE_ERRORS = 5;
// Longer restart delay when Chrome ends the session due to silence (no-speech).
// A 150 ms restart would immediately play another start cue; 3 s is inaudible.
const BACKOFF_NO_SPEECH_MS = 3000;
// If this many auto-restarts occur within 60 s without any final speech, stop
// restarting and ask the user to resume manually via a toast.
const MAX_RESTARTS_BEFORE_TOAST = 2;

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
  onFatalAbort: null,   // () => void — fatal error (mic denied, audio-capture)
  onSilencePause: null, // () => void — restart guard fired; too many silent restarts
  onBeforeRestart: null,// () => void — called before each automatic restart (sync opportunity)
};

let _rec = null;
let _restartPending = false;
let _sessionId = 0;
let _finalCount = 0;
let _errCount = 0;
let _sessionStartTime = 0;
// True from _init() until the first onresult fires — the window where Chrome
// Android may replay previous-session text at the start of a new session.
let _atSessionStart = false;
// Error code from the most recent onerror — read by onend to pick backoff delay.
// Reset to null at the start of each new _init() call.
let _lastEndError = null;
// Timestamps (ms) of recent auto-restarts that had no intervening final speech.
// Used by the restart guard: if this fills up beyond MAX_RESTARTS_BEFORE_TOAST
// within the last 60 s, recognition pauses and the user is asked to resume.
let _restartTimestamps = [];
// SR class override for unit tests — null in production (uses real SR).
let _srOverride = null;

export function isSupported() { return !!(SR || _srOverride); }

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
  const SRClass = _srOverride || SR;
  if (!SRClass) { handlers.onError?.('הדפדפן לא תומך בזיהוי דיבור'); return false; }
  const id = ++_sessionId;
  _finalCount = 0;
  _lastEndError = null;
  _sessionStartTime = Date.now();
  _atSessionStart = true; // Chrome Android may replay prev-session text in first onresult
  diagLog('session_start', { id });
  _rec = new SRClass();
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
      // Speech received — reset the restart guard so silence after this point
      // starts a fresh 60-second window.
      _restartTimestamps = [];
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
    // Track the error so onend can pick the right backoff delay.
    _lastEndError = e.error;
    console.log('[recognition] error:', e.error, '(session', id, ')');
    diagLog('error', { id, error: e.error });
    if (e.error === 'no-speech') return; // normal silence; onend handles restart

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
      id, endError,
      isRecording: state.isRecording,
      isPaused: state.isPaused,
      msSinceStart: Date.now() - _sessionStartTime,
    });

    if (!state.isRecording || state.isPaused || _restartPending) {
      diagLog('restart_skipped', {
        reason: !state.isRecording ? 'stopped' : state.isPaused ? 'paused' : 'already_pending',
      });
      return;
    }

    const now = Date.now();
    const recentRestarts = _restartTimestamps.filter(t => now - t < 60000);

    // Guard: too many silent restarts in the last 60 s without any final speech.
    // Rather than loop forever (producing continuous Chrome start/stop sounds),
    // pause and ask the user to resume manually.
    if (recentRestarts.length >= MAX_RESTARTS_BEFORE_TOAST) {
      diagLog('restart_guard_triggered', { count: recentRestarts.length });
      state.isPaused = true;
      _restartTimestamps = [];
      handlers.onSilencePause?.();
      return;
    }

    // Use a longer delay after a silence/no-speech end so Chrome's start cue is
    // not heard in rapid succession. For other unexpected closes (network, OS kill)
    // keep the short 150 ms to recover quickly.
    const delay = endError === 'no-speech' ? BACKOFF_NO_SPEECH_MS : 150;
    _restartPending = true;
    _restartTimestamps.push(now);
    diagLog('restart_scheduled', {
      id, delay,
      reason: endError ?? 'unexpectedEnd',
      recentRestartCount: recentRestarts.length + 1,
      msSinceStart: Date.now() - _sessionStartTime,
    });
    setTimeout(() => {
      _restartPending = false;
      if (state.isRecording && !state.isPaused) _restart();
    }, delay);
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
  // Give app.js a chance to sync textarea → rec.finalText before the new session
  // starts so the resumed session appends to the correct base text.
  handlers.onBeforeRestart?.();
  diagLog('restart');
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
  _restartTimestamps = []; // fresh start — reset guard
  _lastEndError = null;
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
  _restartTimestamps = []; // user explicitly chose to resume — reset guard
  _restart();
}

// ── Test-only exports ──────────────────────────────────────────────────────────
// These are used exclusively by tests.html. Do not use in app code.
export function _setSRClassForTesting(cls) { _srOverride = cls; }
export function _triggerOnEndForTesting() { _rec?.onend?.(); }
export const _testHooks = {
  get restartTimestamps() { return [..._restartTimestamps]; },
  set restartTimestamps(v) { _restartTimestamps = [...v]; },
  get lastEndError() { return _lastEndError; },
  set lastEndError(v) { _lastEndError = v; },
  // Returns true if the restart guard would fire right now.
  checkGuard() {
    const now = Date.now();
    return _restartTimestamps.filter(t => now - t < 60000).length >= MAX_RESTARTS_BEFORE_TOAST;
  },
};
