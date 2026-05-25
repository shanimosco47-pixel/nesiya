import {
  initStorage, loadSessions, upsertSession, removeSession,
  saveDraft, loadDraft, clearDraft, formatDate, StorageError
} from './storage.js';

import { diagLog, copyDiagLog } from './diagnostics.js';

import {
  state as rec, handlers as recHandlers,
  startRecognition, stopRecognition, pauseRecognition, resumeRecognition,
  isSupported, dedupeAppend, promoteFinalText
} from './recognition.js';

import {
  els, showRecordingUI, showPausedUI, showIdleUI, showToast,
  renderSessions, startSilenceBar, resetSilenceBar, stopSilenceBar, uiCallbacks
} from './ui.js';

// ─── WAKE LOCK ────────────────────────────────────────────────────────────────
let wakeLock = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    diagLog('wake_lock_acquired');
    wakeLock.addEventListener('release', () => {
      diagLog('wake_lock_released');
      if (rec.isRecording && !rec.isPaused && document.visibilityState === 'visible') {
        acquireWakeLock();
      }
    });
  } catch (e) {
    console.warn('[wakeLock] acquire failed:', e.name, e.message);
    diagLog('wake_lock_failed', { name: e.name, msg: e.message });
  }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

// ─── SILENCE TIMER ────────────────────────────────────────────────────────────
const SILENCE_DURATION = 5 * 60 * 1000;
let silenceTimer = null;

function resetSilenceTimer() {
  clearTimeout(silenceTimer);
  resetSilenceBar();
  if (rec.isRecording && !rec.isPaused) {
    silenceTimer = setTimeout(() => stopAndSave(true), SILENCE_DURATION);
  }
}

function clearSilenceTimer() {
  clearTimeout(silenceTimer);
  silenceTimer = null;
}

// ─── SESSION MANAGEMENT ──────────────────────────────────────────────────────
let activeSessionId = null;

function buildSession(text) {
  const now = new Date();
  return { id: now.getTime(), date: formatDate(now), timestamp: now.toISOString(), text: text.trim() };
}

async function persistCurrentSession(text) {
  if (!text.trim()) return;
  const sessions = await loadSessions();
  if (activeSessionId) {
    const existing = sessions.find(s => s.id === activeSessionId);
    if (existing) {
      existing.text = text.trim();
      existing.date = formatDate(new Date());
      await upsertSession(existing);
      return;
    }
  }
  const s = buildSession(text);
  activeSessionId = s.id;
  await upsertSession(s);
}

// ─── AUTOSAVE ─────────────────────────────────────────────────────────────────
let draftTimer = null;
let _draftWarnSent = false;

function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const text = els.transcript.value.trim();
    if (!text) { clearDraft(); return; }
    // Manual textarea edits are fully confirmed by the user — no interim.
    const ok = saveDraft({ finalText: text, interimText: '', activeSessionId });
    if (!ok && !_draftWarnSent) {
      _draftWarnSent = true;
      showToast('אחסון מלא — לא ניתן לשמור טיוטה');
    }
  }, 1500);
}

// ─── RECORDING FLOW ──────────────────────────────────────────────────────────
let _recordingStart = null;

async function startNew() {
  els.transcript.value = '';
  rec.finalText = '';
  activeSessionId = null;
  els.btnGdocs.disabled = true;
  await beginRecording('');
}

async function continueRecording() {
  await beginRecording(els.transcript.value);
}

async function beginRecording(existingText) {
  diagLog('record_start', { existingLen: existingText.trim().length });
  _draftWarnSent = false;
  els.btnStart.style.display = 'none';
  els.btnContinue.style.display = 'none';
  if (!startRecognition(existingText)) { showIdleUI(); return; }
  _recordingStart = new Date();
  showRecordingUI();
  els.statusText.textContent = 'מקליט • ' + _recordingStart.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  resetSilenceTimer();
  startSilenceBar(SILENCE_DURATION);
  els.btnGdocs.disabled = false;
  acquireWakeLock();
}

function pause() {
  if (!rec.isRecording) return;
  if (!rec.isPaused) {
    diagLog('record_pause');
    pauseRecognition();
    showPausedUI();
    clearSilenceTimer();
    stopSilenceBar();
    releaseWakeLock();
  } else {
    diagLog('record_resume');
    resumeRecognition();
    showRecordingUI();
    if (_recordingStart) {
      els.statusText.textContent = 'מקליט • ' + _recordingStart.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    }
    resetSilenceTimer();
    startSilenceBar(SILENCE_DURATION);
    acquireWakeLock();
  }
}

async function stopAndSave(autoStop = false) {
  diagLog('record_stop', { autoStop, textLen: els.transcript.value.trim().length });
  stopRecognition();
  releaseWakeLock();
  clearSilenceTimer();
  stopSilenceBar();
  showIdleUI();
  if (autoStop) showToast('הפסקת דיבור — ההקלטה נעצרה');
  const text = els.transcript.value.trim();
  if (text) {
    try {
      await persistCurrentSession(text);
      clearDraft(); // only clear after confirmed write
      showToast('נשמר בהצלחה ✓');
    } catch (e) {
      console.error('[app] save failed:', e);
      showToast(e instanceof StorageError ? e.message : 'שגיאה בשמירה');
      // draft is intentionally NOT cleared — user can retry or export manually
    }
  }
}

// ─── RECOGNITION CALLBACKS ────────────────────────────────────────────────────
recHandlers.onResult = (finalText, _sessionFinalText, interim) => {
  els.transcript.value = finalText + interim;
  els.transcript.scrollTop = els.transcript.scrollHeight;
  // Store finalText and interimText separately so recovery can present them
  // distinctly and let the user decide whether to include unconfirmed speech.
  if (finalText.trim() || interim.trim()) {
    const ok = saveDraft({ finalText, interimText: interim, activeSessionId });
    if (!ok && !_draftWarnSent) {
      _draftWarnSent = true;
      showToast('אחסון מלא — לא ניתן לשמור טיוטה');
    }
  }
};

recHandlers.onResetSilence = resetSilenceTimer;

recHandlers.onError = (msg) => showToast(msg);

// Fatal abort (mic denied, audio-capture): reset UI and resources.
// Draft is kept intentionally so the user can recover any text entered before
// the mic was denied.
recHandlers.onFatalAbort = () => {
  releaseWakeLock();
  clearSilenceTimer();
  stopSilenceBar();
  showIdleUI();
};

// ─── VISIBILITY CHANGE ────────────────────────────────────────────────────────

// Promote textarea value → rec.finalText before pause or resume.
// The textarea is the authoritative source of truth: it may show interim text
// that hasn't been finalised yet, and we want that text preserved if Chrome
// restarts recognition after the screen turns back on.
function _syncRecognitionState() {
  const txt = els.transcript.value;
  promoteFinalText(txt);
  diagLog('sync_state_from_textarea', { textareaLen: txt.length, finalTextLen: rec.finalText.length });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && rec.isRecording && !rec.isPaused) {
    // Promote visible text (incl. any interim) to rec.finalText so the resumed
    // session starts from exactly what the user saw, not just the finalised portion.
    _syncRecognitionState();
    // Immediately persist the full visible transcript — don't rely on debounced
    // autosave which may not have fired yet if the screen went off quickly.
    const txt = els.transcript.value.trim();
    const saved = txt ? saveDraft({ finalText: txt, interimText: '', activeSessionId }) : false;
    diagLog('visibility_hide', { textLen: txt.length, finalTextLen: rec.finalText.length, draftSaved: saved });
    pauseRecognition();
    clearSilenceTimer();
    stopSilenceBar();
    releaseWakeLock();
    return;
  }
  if (document.visibilityState === 'visible' && rec.isRecording && rec.isPaused) {
    setTimeout(() => {
      if (rec.isRecording && rec.isPaused) {
        // Re-sync before restarting recognition — textarea remains source of truth
        // even if some state drifted while the page was in the background.
        _syncRecognitionState();
        diagLog('visibility_show', { finalTextLen: rec.finalText.length });
        resumeRecognition();
        showRecordingUI();
        els.statusText.textContent = 'מקליט • ' + (_recordingStart ? _recordingStart.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '');
        resetSilenceTimer();
        startSilenceBar(SILENCE_DURATION);
        showToast('ממשיך הקלטה אוטומטית');
        acquireWakeLock();
      }
    }, 800);
  }
});

// ─── MAIN BUTTON LISTENERS ───────────────────────────────────────────────────
els.btnStart.addEventListener('click', startNew);
els.btnContinue.addEventListener('click', continueRecording);
els.btnPause.addEventListener('click', pause);
els.btnStop.addEventListener('click', () => stopAndSave(false));
els.btnGdocs.addEventListener('click', openInGoogleDocs);

// ─── GOOGLE DOCS ─────────────────────────────────────────────────────────────
function openInGoogleDocs() {
  const text = els.transcript.value.trim();
  if (!text) { showToast('אין טקסט לשמירה'); return; }
  const a = Object.assign(document.createElement('a'), {
    href: 'https://docs.google.com/document/create',
    target: '_blank', rel: 'noopener noreferrer'
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  navigator.clipboard.writeText(`${formatDate(new Date())}\n\n${text}`)
    .then(() => showToast('הטקסט הועתק — פסט ב-Google Docs'))
    .catch(() => {});
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────
let searchVisible = false;
document.getElementById('btn-search').addEventListener('click', () => {
  searchVisible = !searchVisible;
  els.searchBar.classList.toggle('visible', searchVisible);
  document.getElementById('btn-search').classList.toggle('active', searchVisible);
  if (searchVisible) els.searchInput.focus();
  else { els.searchInput.value = ''; els.searchCount.textContent = ''; }
});

els.searchInput.addEventListener('input', () => {
  const q = els.searchInput.value.trim();
  if (!q) { els.searchCount.textContent = ''; return; }
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const m = els.transcript.value.match(re);
  els.searchCount.textContent = m ? `${m.length} תוצאות` : 'לא נמצא';
});

// ─── HISTORY PANEL ────────────────────────────────────────────────────────────
uiCallbacks.onViewSession = async (id) => {
  const sessions = await loadSessions();
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  viewingSessionId = id;
  els.viewerTitle.textContent = s.date;
  els.viewerContent.textContent = s.text;
  els.sessionViewer.classList.add('open');
};

uiCallbacks.onLoadSession = async (id) => {
  const sessions = await loadSessions();
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  els.transcript.value = s.text;
  rec.finalText = s.text;
  activeSessionId = id;
  els.sessionsPanel.classList.remove('open');
  els.btnGdocs.disabled = false;
  showIdleUI();
  showToast('הקלטה נטענה לעריכה');
};

uiCallbacks.onDeleteSession = async (id) => {
  if (!confirm('למחוק הקלטה זו?')) return;
  try {
    await removeSession(id);
    const sessions = await loadSessions();
    renderSessions(sessions);
    showToast('נמחק');
  } catch (e) {
    showToast(e instanceof StorageError ? e.message : 'שגיאה במחיקה');
  }
};

document.getElementById('btn-history').addEventListener('click', async () => {
  const sessions = await loadSessions();
  renderSessions(sessions);
  els.sessionsPanel.classList.add('open');
});

document.getElementById('close-sessions').addEventListener('click', () =>
  els.sessionsPanel.classList.remove('open'));

document.getElementById('close-viewer').addEventListener('click', () =>
  els.sessionViewer.classList.remove('open'));

// ─── SESSION VIEWER BUTTONS ───────────────────────────────────────────────────
let viewingSessionId = null;

document.getElementById('btn-viewer-new').addEventListener('click', () => {
  els.sessionViewer.classList.remove('open');
  els.sessionsPanel.classList.remove('open');
  startNew();
});

document.getElementById('btn-viewer-continue').addEventListener('click', async () => {
  if (!viewingSessionId) return;
  const sessions = await loadSessions();
  const s = sessions.find(x => x.id === viewingSessionId);
  if (!s) return;
  els.sessionViewer.classList.remove('open');
  els.sessionsPanel.classList.remove('open');
  els.transcript.value = s.text;
  rec.finalText = s.text;
  activeSessionId = s.id;
  els.btnGdocs.disabled = false;
  await beginRecording(s.text);
});

// ─── EXPORT ───────────────────────────────────────────────────────────────────
function _download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dateStamp() { return new Date().toISOString().slice(0, 10); }

document.getElementById('btn-copy-diag').addEventListener('click', () => {
  copyDiagLog()
    .then(() => showToast('לוג אבחון הועתק ✓'))
    .catch(() => showToast('לא ניתן להעתיק — בדוק הרשאות'));
});

document.getElementById('btn-export-json').addEventListener('click', async () => {
  const sessions = await loadSessions();
  _download(
    new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' }),
    `nesiya-${dateStamp()}.json`
  );
});

document.getElementById('btn-export-md').addEventListener('click', async () => {
  const sessions = await loadSessions();
  const md = sessions.map(s => `# ${s.date}\n\n${s.text}\n`).join('\n---\n\n');
  _download(new Blob([md], { type: 'text/markdown' }), `nesiya-${dateStamp()}.md`);
});

// ─── MANUAL DRAFT SAVE ────────────────────────────────────────────────────────
els.transcript.addEventListener('input', scheduleDraftSave);

// ─── BROWSER SUPPORT GUARD ────────────────────────────────────────────────────
if (!isSupported()) {
  els.btnStart.disabled = true;
  els.btnStart.textContent = 'הדפדפן אינו נתמך - השתמש ב-Chrome';
}

// ─── SERVICE WORKER ───────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js');
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) document.getElementById('update-banner').style.display = 'block';
  });
}

// ─── BUILD STAMP ─────────────────────────────────────────────────────────────
(function() {
  const d = new Date(document.lastModified);
  const el = document.getElementById('build-stamp');
  if (el && d && !isNaN(d)) {
    el.textContent = 'עודכן ' +
      d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  }
})();

// ─── CRASH RECOVERY UI ───────────────────────────────────────────────────────
const recoveryModal          = document.getElementById('recovery-modal');
const recoveryFinalWrap      = document.getElementById('recovery-final-wrap');
const recoveryFinalEl        = document.getElementById('recovery-final');
const recoveryInterimSect    = document.getElementById('recovery-interim-section');
const recoveryInterimEl      = document.getElementById('recovery-interim');
const recoveryInclude        = document.getElementById('recovery-include-interim');
const recoveryLegacyWrap     = document.getElementById('recovery-legacy-wrap');
const recoveryLegacyEl       = document.getElementById('recovery-preview');
const recoveryIncludeLegacy  = document.getElementById('recovery-include-legacy');
const recoveryLegacyWarnEl   = document.getElementById('recovery-legacy-warn');

// Hide the legacy warning as soon as the user checks the box.
recoveryIncludeLegacy.addEventListener('change', () => {
  if (recoveryIncludeLegacy.checked) recoveryLegacyWarnEl.style.display = 'none';
});

function _trunc(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

function showRecoveryModal(draft) {
  recoveryInclude.checked = false;
  recoveryIncludeLegacy.checked = false;
  recoveryLegacyWarnEl.style.display = 'none';

  if (draft.legacyCombinedText) {
    // Old format: confirmed and interim were saved combined; can't separate.
    recoveryLegacyWrap.style.display = '';
    recoveryLegacyEl.textContent = _trunc(draft.finalText, 400);
    recoveryFinalWrap.style.display = 'none';
    recoveryInterimSect.style.display = 'none';
  } else {
    recoveryLegacyWrap.style.display = 'none';
    recoveryFinalWrap.style.display = draft.finalText ? '' : 'none';
    recoveryFinalEl.textContent = _trunc(draft.finalText, 300);
    if (draft.interimText) {
      recoveryInterimSect.style.display = '';
      recoveryInterimEl.textContent = _trunc(draft.interimText, 200);
    } else {
      recoveryInterimSect.style.display = 'none';
    }
  }

  recoveryModal.style.display = 'flex';
}

// Returns the text to use for continue/save based on checkbox state.
// New drafts: include interimText only when the user explicitly opts in.
// Legacy drafts: return the combined text (caller must have confirmed via _guardLegacy).
function _recoveryText(draft) {
  if (draft.legacyCombinedText) return draft.finalText;
  if (recoveryInclude.checked && draft.interimText) {
    return (draft.finalText + ' ' + draft.interimText).trim();
  }
  return draft.finalText;
}

// Returns true when the action may proceed.  For legacy drafts, the user
// must check the acknowledgement box; if not, shows the warning and returns
// false so the button handlers keep the modal open.
function _guardLegacy(draft) {
  if (!draft.legacyCombinedText) return true;
  if (recoveryIncludeLegacy.checked) return true;
  recoveryLegacyWarnEl.style.display = '';
  return false;
}

document.getElementById('btn-recovery-continue').addEventListener('click', () => {
  const draft = loadDraft();
  if (!draft) return;
  if (!_guardLegacy(draft)) return; // keep modal open until checkbox checked
  recoveryModal.style.display = 'none';
  if (draft.activeSessionId) activeSessionId = draft.activeSessionId;
  const text = _recoveryText(draft);
  els.transcript.value = text;
  rec.finalText = text;
  els.btnGdocs.disabled = false;
  showIdleUI();
  showToast('טיוטה שוחזרה');
  beginRecording(text);
});

document.getElementById('btn-recovery-save').addEventListener('click', async () => {
  const draft = loadDraft();
  if (!draft) return;
  if (!_guardLegacy(draft)) return; // keep modal open until checkbox checked
  recoveryModal.style.display = 'none';
  if (draft.activeSessionId) activeSessionId = draft.activeSessionId;
  const text = _recoveryText(draft);
  els.transcript.value = text;
  rec.finalText = text;
  try {
    await persistCurrentSession(text);
    clearDraft();
    showToast('נשמר כהקלטה ✓');
  } catch (e) {
    showToast(e instanceof StorageError ? e.message : 'שגיאה בשמירה');
  }
  showIdleUI();
});

document.getElementById('btn-recovery-discard').addEventListener('click', () => {
  clearDraft();
  recoveryModal.style.display = 'none';
  showToast('טיוטה נמחקה');
});

// ─── CRASH RECOVERY + INIT ────────────────────────────────────────────────────
async function checkRecovery() {
  const draft = loadDraft();
  if (!draft) return;
  const sessions = await loadSessions();
  // Auto-clear only when confirmed text is already saved and there is no
  // unconfirmed speech left for the user to review.
  if (!draft.interimText && !draft.legacyCombinedText
      && sessions.some(s => s.text === draft.finalText)) {
    clearDraft();
    return;
  }
  showRecoveryModal(draft);
}

(async function init() {
  await initStorage();
  await checkRecovery();
  showIdleUI();
})();
