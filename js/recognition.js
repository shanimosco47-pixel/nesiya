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

// Strip invisible Unicode bidirectional control characters and normalize to NFC.
// Chrome Android embeds RTL marks (U+200F), LTR marks (U+200E), embedding
// controls (U+202A–U+202E), BOM (U+FEFF), and zero-width chars (U+200B–U+200D)
// in Hebrew transcripts. These are invisible in logs but cause === to return
// false even on visually identical strings.
const _norm = (s) => s.normalize('NFC').replace(/[‎‏‪-‮﻿​-‍]/g, '');

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
export function collapseSessionFinals(results) {
  let collapsed = '';
  let collapsedNorm = '';
  for (let i = 0; i < results.length; i++) {
    if (!results[i].isFinal) continue;
    const t = results[i][0].transcript.trim();
    if (!t) continue;
    const tNorm = _norm(t);
    if (!tNorm) continue;

    if (!collapsed) {
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

function _init() {
  if (!SR) { handlers.onError?.('הדפדפן לא תומך בזיהוי דיבור'); return false; }
  const id = ++_sessionId;
  _lastEndError = null;
  _sessionStartTime = Date.now();
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

    // Collapse all isFinal results in e.results into a single de-duplicated string.
    // Chrome Android emits superseding expansions within a session (not distinct
    // segments), so collapseSessionFinals selects the longest coherent phrase
    // rather than concatenating every entry.
    const sessionFinal = collapseSessionFinals(e.results);

    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      if (!e.results[i].isFinal) interim += e.results[i][0].transcript;
    }

    // Combine with committedText, deduping the inter-session boundary to handle
    // Chrome Android's session-replay behaviour. committedText is stable for the
    // duration of this session, and the start of sessionFinal is stable (the
    // expansion check in collapseSessionFinals only grows the tail), so the
    // overlap check produces consistent results across successive calls.
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
      collapsedFinal: sessionFinal.trim().slice(0, 80),
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
