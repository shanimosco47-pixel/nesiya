const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const MAX_CONSECUTIVE_ERRORS = 5;

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
  onForceStopped: null, // () => void — called when recognition stops itself (fatal error)
};

let _rec = null;
let _restartPending = false;
let _sessionId = 0;
let _finalCount = 0;
let _errCount = 0;

export function isSupported() { return !!SR; }

export function dedupeAppend(existing, addition) {
  if (!addition.trim()) return existing;
  if (!existing.trim()) return addition.trim() + ' ';
  const a = existing.trimEnd().split(/\s+/);
  const b = addition.trim().split(/\s+/);
  for (let len = Math.min(a.length, b.length, 20); len >= 1; len--) {
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
  _rec = new SR();
  _rec.lang = 'he-IL';
  _rec.continuous = false;
  _rec.interimResults = true;
  _rec.maxAlternatives = 1;

  _rec.onresult = (e) => {
    if (_sessionId !== id) return;
    _errCount = 0;
    handlers.onResetSilence?.();
    let interim = '', newFinal = '';
    for (let i = _finalCount; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) { newFinal += t + ' '; _finalCount = i + 1; }
      else interim += t;
    }
    if (newFinal) {
      state.finalText = dedupeAppend(state.finalText, newFinal);
      state.sessionFinalText += newFinal;
    }
    handlers.onResult?.(state.finalText, state.sessionFinalText, interim);
  };

  _rec.onerror = (e) => {
    if (_sessionId !== id) return;
    console.log('[recognition] error:', e.error, '(session', id, ')');
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
    if (state.isRecording && !state.isPaused && !_restartPending) {
      _restartPending = true;
      setTimeout(() => {
        _restartPending = false;
        if (state.isRecording && !state.isPaused) _restart();
      }, 150);
    }
  };

  return true;
}

function _kill() {
  state.isRecording = false;
  state.isPaused = false;
  _restartPending = false;
  try { _rec?.stop(); _rec = null; } catch {}
  handlers.onForceStopped?.();
}

function _restart() {
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
