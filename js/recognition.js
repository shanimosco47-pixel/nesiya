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
  onSilencePause: null,    // () => void — called when auto-paused due to sustained silence
  onVADResume: null,       // () => void — called when VAD detects voice; caller should resumeRecognition()
  onVADInitFailed: null,   // () => void — VAD init failed while paused; SR resumes with beep fallback
  onVADInitTimeout: null,  // () => void — pending VAD init blocked resume/start too long
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
let _transitionGeneration = 0;   // incremented by resume/stop to cancel all pending async ops
let _vadInitPromise = null;       // single-flight guard: at most one _initVAD in progress
let _vadInitGeneration = -1;      // generation of _vadInitPromise; stale promise never reused
let _resumePending = false;       // true while async VAD release + SR restart is in progress
let _startPending = false;        // true while async startRecognition is in progress
let _getUserMediaOverride = null; // test injection only; null in production
let _SROverride = null;           // test injection only; null in production
let _vadInitTimeoutMs = 5000;     // ms to wait for pending VAD init before declaring timeout

export function isSupported() { return !!SR; }

// Minimum word overlap required to consider a repetition as Chrome's inter-session
// replay rather than legitimate repeated phrasing (e.g. a name used twice).
const MIN_OVERLAP_WORDS = 3;

export function dedupeAppend(existing, addition) {
  if (!addition.trim()) return existing;
  if (!existing.trim()) return addition.trim() + ' ';
  const leadNL = addition.startsWith('\n') ? '\n' : '';
  const sep = leadNL || ' ';
  const a = existing.trimEnd().split(/\s+/);
  const b = addition.trim().split(/\s+/);
  for (let len = Math.min(a.length, b.length, 20); len >= MIN_OVERLAP_WORDS; len--) {
    if (a.slice(-len).join(' ') === b.slice(0, len).join(' ')) {
      const rest = b.slice(len).join(' ');
      return a.join(' ') + (rest ? sep + rest : '') + ' ';
    }
  }
  return existing.trimEnd() + sep + addition.trim() + ' ';
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
    const raw = results[i][0].transcript;
    const leadNL = raw.startsWith('\n') ? '\n' : '';
    const t = raw.trim();
    if (!t) continue;
    const tNorm = _norm(t);
    if (!tNorm) continue; // skip punctuation-only slots in this pass

    if (!collapsedNorm) {
      collapsed = leadNL + t + ' ';
      collapsedNorm = tNorm;
      continue;
    }

    // Expansion: tNorm starts with all of collapsedNorm at a word boundary
    // → replace accumulated with the longer version.
    if (tNorm.length >= collapsedNorm.length &&
        tNorm.startsWith(collapsedNorm) &&
        (tNorm.length === collapsedNorm.length || tNorm[collapsedNorm.length] === ' ')) {
      collapsed = leadNL + t + ' ';
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
    const sep = leadNL || ' ';
    if (overlapLen >= MIN_OVERLAP_WORDS) {
      const rawWords = t.split(/\s+/);
      const rest = rawWords.slice(overlapLen).join(' ');
      collapsed = collapsed.trimEnd() + (rest ? sep + rest : '') + ' ';
    } else {
      // No significant overlap — treat as a new distinct segment.
      collapsed = collapsed.trimEnd() + sep + t + ' ';
    }
    collapsedNorm = _norm(collapsed.trim());
  }
  return collapsed;
}

// Return a trailing punctuation or newline suffix from the last isFinal result.
// When the session has no word content but committedText exists (e.g. user says
// "נקודה" after a prior sentence), the punct is still returned so the caller can
// attach it to committedText directly.  Both empty → return '' to prevent spurious
// punctuation from Chrome noise-only sessions corrupting a blank transcript.
function _trailingPunct(results, sessionFinal, committedText = '') {
  if (!sessionFinal.trim() && !committedText.trim()) return '';
  const refText = sessionFinal.trim() ? sessionFinal : committedText;
  for (let i = results.length - 1; i >= 0; i--) {
    if (!results[i].isFinal) continue;
    const raw = results[i][0].transcript;
    const t = raw.trim();
    if (!t) {
      // Whitespace-only (e.g. "\n" newline command)
      return (raw && !refText.endsWith(raw)) ? raw : '';
    }
    if (!_norm(t)) {
      // Punctuation-only (e.g. "." period command)
      return !refText.trimEnd().endsWith(t) ? t : '';
    }
    break; // last isFinal was a word result — no trailing punctuation
  }
  return '';
}

// ─── VAD HELPERS ─────────────────────────────────────────────────────────────

async function _initVAD() {
  if (_vadContext) return;
  const gen = _transitionGeneration;
  diagLog('vad_init_start');
  let localStream = null;
  let localContext = null;
  try {
    const gum = _getUserMediaOverride
      ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    localStream = await gum({ audio: true, video: false });

    if (_transitionGeneration !== gen || !state.isRecording || !state.isPaused || _vadContext) {
      localStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      if (_transitionGeneration !== gen) diagLog('vad_init_superseded');
      return;
    }

    localContext = new (window.AudioContext || window.webkitAudioContext)();
    const localAnalyser = localContext.createAnalyser();
    localContext.createMediaStreamSource(localStream).connect(localAnalyser);
    localAnalyser.fftSize = 512;

    if (_transitionGeneration !== gen || !state.isRecording || !state.isPaused) {
      localStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      try { await localContext.close(); } catch {}
      diagLog('vad_init_superseded');
      return;
    }

    _vadStream = localStream;
    _vadContext = localContext;
    _vadAnalyser = localAnalyser;
    diagLog('vad_init_ok');
  } catch (e) {
    if (localStream) localStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
    if (localContext) { try { await localContext.close(); } catch {} }
    if (_transitionGeneration !== gen) return;
    diagLog('vad_init_failed', { error: String(e) });
  }
}

function _ensureVADInitialized() {
  if (_vadInitPromise && _vadInitGeneration === _transitionGeneration) return _vadInitPromise;
  const gen = _transitionGeneration;
  _vadInitGeneration = gen;
  _vadInitPromise = _initVAD().finally(() => {
    if (_vadInitGeneration === gen) { _vadInitPromise = null; _vadInitGeneration = -1; }
  });
  return _vadInitPromise;
}

async function _waitForVADInit() {
  if (!_vadInitPromise) return true;
  const settled = await Promise.race([
    _vadInitPromise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), _vadInitTimeoutMs)),
  ]);
  if (!settled) {
    diagLog('vad_init_timeout');
    handlers.onVADInitTimeout?.();
  }
  return settled;
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
        diagLog('vad_voice_detected', { rms: +rms.toFixed(4) });
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

async function _releaseVAD() {
  const hadResources = !!(_vadStream || _vadContext);
  if (hadResources) diagLog('vad_release_start');
  _stopVAD();
  try { _vadStream?.getTracks().forEach(t => t.stop()); } catch {}
  _vadStream = null;
  try { if (_vadContext) await _vadContext.close(); } catch {}
  _vadContext = null;
  _vadAnalyser = null;
  if (hadResources) diagLog('vad_release_complete');
}

// ─── RECOGNITION SESSION ─────────────────────────────────────────────────────

function _init() {
  const SR_ = _SROverride || SR;
  if (!SR_) { handlers.onError?.('הדפדפן לא תומך בזיהוי דיבור'); return false; }
  const id = ++_sessionId;
  _lastEndError = null;
  _sessionStartTime = Date.now();
  _sessionHadSpeech = false;
  // Snapshot of confirmed transcript before this session — never mutated within the session.
  const committedText = state.finalText;
  diagLog('session_start', { id });
  _rec = new SR_();
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

    // Append trailing punctuation/newline voice command from the last isFinal slot.
    // Passing committedText allows punct commands (e.g. "נקודה") fired in a
    // word-free session to still be applied when prior text exists.
    const punct = _trailingPunct(e.results, sessionFinal, committedText);

    let collapsedFinal;
    if (sessionFinal.trim()) {
      // Session had word content — attach any trailing punct to session words.
      const sfwp = punct ? sessionFinal.trimEnd() + punct + ' ' : sessionFinal;
      if (sfwp.trim()) _sessionHadSpeech = true;
      state.finalText = dedupeAppend(committedText, sfwp);
      state.sessionFinalText = sfwp;
      collapsedFinal = sfwp;
    } else if (punct) {
      // Punct/newline-only session — attach directly to avoid dedupeAppend eating
      // the "\n" (which trims to '') or inserting a space before ".".
      _sessionHadSpeech = true;
      const isNL = !punct.trim(); // "\n".trim() === ''
      state.finalText = committedText.trimEnd() + punct + (isNL ? '' : ' ');
      state.sessionFinalText = punct;
      collapsedFinal = punct;
    } else {
      state.finalText = committedText;
      state.sessionFinalText = '';
      collapsedFinal = '';
    }

    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      if (!e.results[i].isFinal) interim += e.results[i][0].transcript;
    }

    diagLog('result', {
      id,
      resultIndex: e.resultIndex,
      resultsLen: e.results.length,
      results: Array.from({ length: e.results.length }, (_, i) => ({
        i,
        isFinal: e.results[i].isFinal,
        t: e.results[i][0].transcript.slice(0, 40),
      })),
      collapsedFinal: collapsedFinal.trim().slice(0, 80),
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
    if (_silentStreak >= SILENT_STREAK_LIMIT) {
      diagLog('vad_auto_pause', { streak: _silentStreak });
      _silentStreak = 0;
      state.isPaused = true;
      handlers.onSilencePause?.();
      // Initialize VAD only now (first time it's needed) to avoid holding a
      // simultaneous getUserMedia stream alongside SR during active recording.
      if (_vadAnalyser) {
        _startVAD();
      } else {
        const initGen = _transitionGeneration;
        _ensureVADInitialized().then(() => {
          if (_transitionGeneration !== initGen || !state.isRecording || !state.isPaused) return;
          if (_vadAnalyser) { _startVAD(); }
          else { diagLog('vad_init_failed_in_pause'); handlers.onVADInitFailed?.(); }
        });
      }
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
  _transitionGeneration++;
  _resumePending = false;
  _startPending = false;
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
  if (!_init()) return false;
  try {
    _rec.start();
    return true;
  } catch (e) {
    console.warn('[recognition] start failed, retry in 500 ms');
    setTimeout(() => {
      if (state.isRecording && !state.isPaused) {
        try { _rec.start(); } catch (e2) { console.error('[recognition] retry failed', e2); }
      }
    }, 500);
    return false;
  }
}

export async function startRecognition(existingText = '') {
  if (_startPending) return false;
  _startPending = true;
  const myGen = ++_transitionGeneration;
  try {
    if (_vadInitPromise) {
      const settled = await _waitForVADInit();
      if (!settled) return false;
    }
    await _releaseVAD();
    // Re-check after awaits: stop() or another start() may have superseded this call.
    if (_transitionGeneration !== myGen) return false;
    state.finalText = existingText;
    state.sessionFinalText = '';
    state.isRecording = true;
    state.isPaused = false;
    _restartPending = false;
    _errCount = 0;
    _silentStreak = 0;
    if (!_init()) { state.isRecording = false; return false; }
    try {
      _rec.start();
      return true;
    } catch (e) {
      console.error('[recognition] initial start failed', e);
      state.isRecording = false;
      return false;
    }
  } finally {
    if (_transitionGeneration === myGen) _startPending = false;
  }
}

export function stopRecognition() {
  _transitionGeneration++;
  _resumePending = false;
  _startPending = false;
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

export async function resumeRecognition() {
  if (!state.isRecording || !state.isPaused || _resumePending) return false;
  _resumePending = true;
  const myGen = ++_transitionGeneration;
  const wasVAD = !!(_vadStream || _vadContext || _vadTimer);
  try {
    if (_vadInitPromise) {
      const settled = await _waitForVADInit();
      if (!settled) return false;
    }
    await _releaseVAD();
    if (!state.isRecording || _transitionGeneration !== myGen) {
      diagLog('resume_aborted', { reason: !state.isRecording ? 'stopped' : 'superseded' });
      return false;
    }
    state.isPaused = false;
    _silentStreak = 0;
    if (wasVAD) diagLog('sr_resume_after_vad');
    return _restart();
  } finally {
    if (_transitionGeneration === myGen) _resumePending = false;
  }
}

export const _forTesting = {
  reset() {
    _resumePending = false; _startPending = false; _transitionGeneration = 0; _vadInitPromise = null;
    _vadInitGeneration = -1; _getUserMediaOverride = null; _SROverride = null;
    _vadStream = null; _vadContext = null; _vadAnalyser = null; _vadTimer = null;
    _restartPending = false; _errCount = 0; _silentStreak = 0;
    _sessionHadSpeech = false; _lastEndError = null; _sessionStartTime = 0; _rec = null;
    state.isRecording = false; state.isPaused = false;
    state.finalText = ''; state.sessionFinalText = '';
  },
  getInternalState() {
    return { vadStream: _vadStream, vadContext: _vadContext, vadAnalyser: _vadAnalyser,
             vadTimer: _vadTimer, resumePending: _resumePending, startPending: _startPending,
             transitionGeneration: _transitionGeneration };
  },
  ensureVADInitialized: () => _ensureVADInitialized(),
  setVADResources(stream, context, analyser) {
    _vadStream = stream; _vadContext = context; _vadAnalyser = analyser;
  },
  setGetUserMedia(fn)     { _getUserMediaOverride = fn; },
  clearGetUserMedia()     { _getUserMediaOverride = null; },
  setSR(mock)             { _SROverride = mock; },
  clearSR()               { _SROverride = null; },
  setVADInitTimeoutMs(ms) { _vadInitTimeoutMs = ms; },
  resetVADInitTimeoutMs() { _vadInitTimeoutMs = 5000; },
};
