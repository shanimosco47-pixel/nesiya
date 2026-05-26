import { diagLog } from './diagnostics.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const MAX_CONSECUTIVE_ERRORS = 5;
const SILENT_STREAK_LIMIT = 3; // consecutive sessions with no speech → auto-pause + VAD
const VAD_THRESHOLD = 0.01;    // RMS amplitude threshold for voice detection
const VAD_POLL_MS = 200;       // AudioContext polling interval (ms)
const VAD_HIT_COUNT = 3;       // consecutive hits above threshold to trigger resume (600ms)

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
  onSilencePause: null, // () => void — called when auto-paused due to sustained silence
  onVADResume: null,    // () => void — called when VAD detects voice; caller should resumeRecognition()
};

let _rec = null;
let _restartPending = false;
let _sessionId = 0;
let _errCount = 0;
let _sessionHadSpeech = false; // true if current session produced any real transcript
let _silentStreak = 0;         // consecutive sessions with no speech

// AudioContext voice-activity detection (VAD) — runs silently when SR is paused,
// auto-resumes when voice is detected. Eliminates beeping during silence.
let _vadStream = null;
let _vadContext = null;
let _vadAnalyser = null;
let _vadTimer = null;

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

// Strip invisible Unicode bidirectional control characters and normalize to NFC.
// Chrome Android embeds RTL marks (U+200F), LTR marks (U+200E), embedding
// controls (U+202A–U+202E), BOM (U+FEFF), and zero-width chars (U+200B–U+200D)
// in Hebrew transcripts. These are invisible in logs but cause === to return
// false even on visually identical strings.
const _norm = (s) => s.normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, '');

// Collapse a SpeechRecognitionResultList into a single de-duplicated string.
//
// Chrome Android with continuous=true emits multiple isFinal results that are
// superseding expansions of the same utterance rather than distinct segments:
//   e.results[0] = "אני"
//   e.results[1] = "אני עושה"
//   e.results[2] = "אני עושה ניסיון"  ← each is a superset of the prior
//
// Naïve concatenation produces "אני אני עושה אני עושה ניסיון …".
// This function collapses the list instead:
//   • If a new final is a word-level expansion of the accumulated text
//     (its words start with all of the accumulated words), replace the
//     accumulated text with the longer version.
//   • If a new final is a strict prefix/subset of the accumulated text,
//     discard it (older, shorter version already superseded).
//   • Otherwise apply the same ≥3-word boundary overlap check as
//     dedupeAppend before appending, so legitimate distinct segments
//     are appended correctly and 1–2-word legitimate repeats are preserved.
//
// All comparisons use _norm() to handle invisible Unicode chars in Chrome
// Android Hebrew transcripts that make === fail on visually identical strings.
//
// Punctuation and newline voice commands (e.g. saying "נקודה" → Chrome emits ".")
// are handled separately in the onresult handler after this function returns,
// to avoid appending spurious punctuation from noise-only sessions.
export function collapseSessionFinals(results) {
  let collapsed = '';
  let collapsedNorm = '';
  for (let i = 0; i < results.length; i++) {
    if (!results[i].isFinal) continue;
    const t = results[i][0].transcript.trim();
    if (!t) continue;
    const tNorm = _norm(t);
    if (!tNorm) continue; // skip punctuation-only slots in this pass

    if (!collapsedNorm) {
      collapsed = t + ' ';
      collapsedNorm = tNorm;
      continue;
    }

    // Expansion: tNorm starts with all of collapsedNorm at a word boundary
    // → replace accumulated with the longer version.
    if (tNorm.length >= collapsedNorm.length &&
        tNorm.startsWith(collapsedNorm) &&
        (tNorm.length === collapsedNorm.length || tNorm[collapsedNorm.length] === ' ')) {
      collapsed = t + ' ';
      collapsedNorm = tNorm;
      continue;
    }

    // Subset: collapsedNorm starts with tNorm at a word boundary
    // → already have this content, discard.
    if (tNorm.length < collapsedNorm.length &&
        collapsedNorm.startsWith(tNorm) &&
        collapsedNorm[tNorm.length] === ' ') {
      continue;
    }

    // Check for word-level boundary overlap (≥ MIN_OVERLAP_WORDS) between the
    // end of collapsed and the start of the new result — same logic as dedupeAppend.
    // Use normalized words so invisible Unicode chars don't break word matching.
    const cWords = collapsedNorm.split(/\s+/);
    const nWords = tNorm.split(/\s+/);
    let overlapLen = 0;
    for (let len = Math.min(cWords.length, nWords.length, 20); len >= MIN_OVERLAP_WORDS; len--) {
      if (cWords.slice(-len).join(' ') === nWords.slice(0, len).join(' ')) {
        overlapLen = len;
        break;
      }
    }
    if (overlapLen >= MIN_OVERLAP_WORDS) {
      const rawWords = t.split(/\s+/);
      const rest = rawWords.slice(overlapLen).join(' ');
      collapsed = collapsed.trimEnd() + (rest ? ' ' + rest : '') + ' ';
    } else {
      // No significant overlap — treat as a new distinct segment.
      collapsed = collapsed + t + ' ';
    }
    collapsedNorm = _norm(collapsed.trim());
  }
  return collapsed;
}

// Return a trailing punctuation or newline suffix from the last isFinal result,
// but only when the session has real word content (sessionFinal non-empty) — this
// prevents Chrome's spurious "." or "\n" noise results in silent sessions from
// corrupting the transcript.
function _trailingPunct(results, sessionFinal) {
  if (!sessionFinal.trim()) return '';
  for (let i = results.length - 1; i >= 0; i--) {
    if (!results[i].isFinal) continue;
    const raw = results[i][0].transcript;
    const t = raw.trim();
    if (!t) {
      // Whitespace-only (e.g. "\n" newline command)
      return (raw && !sessionFinal.endsWith(raw)) ? raw : '';
    }
    if (!_norm(t)) {
      // Punctuation-only (e.g. "." period command)
      return !sessionFinal.trimEnd().endsWith(t) ? t : '';
    }
    break; // last isFinal was a word result — no trailing punctuation
  }
  return '';
}

// ─── VAD HELPERS ─────────────────────────────────────────────────────────────

async function _initVAD() {
  if (_vadContext) return; // already set up
  try {
    _vadStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    _vadContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = _vadContext.createMediaStreamSource(_vadStream);
    _vadAnalyser = _vadContext.createAnalyser();
    _vadAnalyser.fftSize = 512;
    source.connect(_vadAnalyser);
    diagLog('vad_init', { ok: true });
  } catch (e) {
    _vadStream = null; _vadContext = null; _vadAnalyser = null;
    diagLog('vad_init', { ok: false, error: String(e) });
  }
}

function _startVAD() {
  if (!_vadAnalyser || _vadTimer) return;
  const buf = new Float32Array(_vadAnalyser.fftSize);
  let hitCount = 0;
  _vadTimer = setInterval(() => {
    if (_vadContext.state === 'suspended') { _vadContext.resume(); return; }
    _vadAnalyser.getFloatTimeDomainData(buf);
    const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
    if (rms > VAD_THRESHOLD) {
      if (++hitCount >= VAD_HIT_COUNT) {
        diagLog('vad_resume', { rms: +rms.toFixed(4) });
        _stopVAD();
        handlers.onVADResume?.();
      }
    } else {
      hitCount = 0;
    }
  }, VAD_POLL_MS);
  diagLog('vad_started');
}

function _stopVAD() {
  if (_vadTimer) { clearInterval(_vadTimer); _vadTimer = null; }
}

function _releaseVAD() {
  _stopVAD();
  try { _vadStream?.getTracks().forEach(t => t.stop()); } catch {}
  _vadStream = null;
  try { _vadContext?.close(); } catch {}
  _vadContext = null;
  _vadAnalyser = null;
}

// ─── RECOGNITION SESSION ─────────────────────────────────────────────────────

function _init() {
  if (!SR) { handlers.onError?.('הדפדפן לא תומך בזיהוי דיבור'); return false; }
  const id = ++_sessionId;
  _lastEndError = null;
  _sessionStartTime = Date.now();
  _sessionHadSpeech = false;
  // Snapshot of confirmed transcript before this session — never mutated within the session.
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

    // Collapse all isFinal word results into a single de-duplicated string.
    const sessionFinal = collapseSessionFinals(e.results);

    // Append trailing punctuation/newline voice command from the last isFinal slot,
    // but only when the session has real words — prevents spurious punctuation from
    // Chrome's noise-only sessions (silent sessions where Chrome emits "." or "\n").
    const punct = _trailingPunct(e.results, sessionFinal);
    const sessionFinalWithPunct = punct
      ? sessionFinal.trimEnd() + punct + ' '
      : sessionFinal;

    if (sessionFinalWithPunct.trim()) _sessionHadSpeech = true;

    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      if (!e.results[i].isFinal) interim += e.results[i][0].transcript;
    }

    // Combine with committedText, deduping the inter-session boundary to handle
    // Chrome Android's session-replay behaviour.
    state.finalText = sessionFinalWithPunct
      ? dedupeAppend(committedText, sessionFinalWithPunct)
      : committedText;
    state.sessionFinalText = sessionFinalWithPunct;

    diagLog('result', {
      id,
      resultIndex: e.resultIndex,
      resultsLen: e.results.length,
      results: Array.from({ length: e.results.length }, (_, i) => ({
        i,
        isFinal: e.results[i].isFinal,
        t: e.results[i][0].transcript.slice(0, 40),
      })),
      collapsedFinal: sessionFinalWithPunct.trim().slice(0, 80),
      displayLen: (state.finalText + interim).length,
    });

    handlers.onResult?.(state.finalText, state.sessionFinalText, interim);
  };

  _rec.onerror = (e) => {
    if (_sessionId !== id) return;
    _lastEndError = e.error;
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
    const hadSpeech = _sessionHadSpeech;
    _sessionHadSpeech = false;

    diagLog('recognition_end', {
      id,
      endError,
      hadSpeech,
      silentStreak: _silentStreak,
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

    if (hadSpeech) {
      _silentStreak = 0;
    } else {
      _silentStreak++;
    }

    // After SILENT_STREAK_LIMIT consecutive sessions with no speech, stop the
    // restart loop and hand off to the AudioContext VAD, which monitors amplitude
    // silently (no beeps). When voice is detected, onVADResume fires so app.js
    // can call resumeRecognition() — one beep as the user starts speaking.
    if (_silentStreak >= SILENT_STREAK_LIMIT && _vadAnalyser) {
      diagLog('vad_auto_pause', { streak: _silentStreak });
      _silentStreak = 0;
      state.isPaused = true;
      _startVAD();
      handlers.onSilencePause?.();
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
  _silentStreak = 0;
  try { _rec?.stop(); _rec = null; } catch {}
  _releaseVAD();
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
  _silentStreak = 0;
  _initVAD(); // fire-and-forget; sets up AudioContext for silence detection
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
  _silentStreak = 0;
  try { _rec?.stop(); _rec = null; } catch {}
  _releaseVAD();
}

// Promote arbitrary text to rec.finalText — call before pause or resume so
// the textarea (source of truth) is always what the next session starts from.
export function promoteFinalText(text) {
  state.finalText = text.trim() ? text.trim() + ' ' : '';
}

export function pauseRecognition() {
  if (!state.isRecording || state.isPaused) return;
  state.isPaused = true;
  _stopVAD();
  try { _rec?.stop(); } catch {}
}

export function resumeRecognition() {
  if (!state.isRecording || !state.isPaused) return;
  state.isPaused = false;
  _silentStreak = 0; // fresh streak after any resume (user-initiated or VAD)
  _stopVAD();
  _restart();
}
