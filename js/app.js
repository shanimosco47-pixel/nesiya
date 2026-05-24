import {
  initStorage, loadSessions, upsertSession, removeSession,
  saveDraft, loadDraft, clearDraft, formatDate, StorageError
} from './storage.js';

import { diagLog, copyDiagLog } from './diagnostics.js';

import {
  state as rec, handlers as recHandlers,
  startRecognition, stopRecognition, pauseRecognition, resumeRecognition,
  isSupported, dedupeAppend
} from './recognition.js';

import {
  els, showRecordingUI, showPausedUI, showIdleUI, showToast,
  renderSessions, startSilenceBar, resetSilenceBar, stopSilenceBar, uiCallbacks
} from './ui.js';

// ─── AUDIO BEEPS ─────────────────────────────────────────────────────────────
let ctx = null;

async function ensureAudioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();
}

function beep(freq = 880, dur = 0.12, type = 'sine', vol = 0.18) {
  if (!ctx || ctx.state !== 'running') return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq; osc.type = type;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur);
  } catch {}
}

function beepStart()  { beep(660, 0.1); setTimeout(() => beep(880, 0.12), 120); }
function beepStop()   { beep(880, 0.1); setTimeout(() => beep(550, 0.15), 100); }
function beepPause()  { beep(700, 0.1); }
function beepResume() { beep(550, 0.1); setTimeout(() => beep(750, 0.1), 100); }

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
    const ok = saveDraft({ text, activeSessionId, includesInterim: false });
    if (!ok && !_draftWarnSent) {
      _draftWarnSent = true;
      showToast('אחסון מלא — לא ניתן לשמור טיוטה');
    }
  }, 1500);
}

// ─── RECORDING FLOW ──────────────────────────────────────────────────────────
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
  await ensureAudioCtx();
  if (!startRecognition(existingText)) { showIdleUI(); return; }
  beepStart();
  showRecordingUI();
  resetSilenceTimer();
  startSilenceBar(SILENCE_DURATION);
  els.btnGdocs.disabled = false;
  acquireWakeLock();
}

async function pause() {
  if (!rec.isRecording) return;
  await ensureAudioCtx();
  if (!rec.isPaused) {
    diagLog('record_pause');
    pauseRecognition();
    beepPause();
    showPausedUI();
    clearSilenceTimer();
    stopSilenceBar();
    releaseWakeLock();
  } else {
    diagLog('record_resume');
    resumeRecognition();
    beepResume();
    showRecordingUI();
    resetSilenceTimer();
    startSilenceBar(SILENCE_DURATION);
    acquireWakeLock();
  }
}

async function stopAndSave(autoStop = false) {
  diagLog('record_stop', { autoStop, textLen: els.transcript.value.trim().length });
  stopRecognition();
  await ensureAudioCtx();
  beepStop();
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
  // Persist immediately on new final text so the most recent confirmed speech
  // is in the draft even if the app crashes between utterances.  Interim text
  // is included so recovery is as complete as possible — the recovery UI warns
  // the user it may contain unconfirmed speech.
  if (finalText.trim()) {
    const ok = saveDraft({ text: finalText + interim, activeSessionId, includesInterim: !!interim.trim() });
    if (!ok && !_draftWarnSent) {
      _draftWarnSent = true;
      showToast('אחסון מלא — לא ניתן לשמור טיוטה');
    }
  } else {
    scheduleDraftSave();
  }
};

recHandlers.onResetSilence = resetSilenceTimer;

recHandlers.onError = (msg) => showToast(msg);

recHandlers.onForceStopped = () => stopAndSave(false);

// ─── VISIBILITY CHANGE ────────────────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && rec.isRecording && !rec.isPaused) {
    pauseRecognition();
    clearSilenceTimer();
    stopSilenceBar();
    releaseWakeLock();
    return;
  }
  if (document.visibilityState === 'visible' && rec.isRecording && rec.isPaused) {
    setTimeout(() => {
      if (rec.isRecording && rec.isPaused) {
        resumeRecognition();
        showRecordingUI();
        resetSilenceTimer();
        startSilenceBar(SILENCE_DURATION);
        showToast('ממשיך הקלטה אוטומטית');
        acquireWakeLock();
      }
    }, 800);
  }
});

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
const recoveryModal   = document.getElementById('recovery-modal');
const recoveryPreview = document.getElementById('recovery-preview');

function showRecoveryModal(draft) {
  const text = draft.text;
  recoveryPreview.textContent = text.length > 400
    ? text.slice(0, 400) + '…'
    : text;
  recoveryModal.style.display = 'flex';
}

document.getElementById('btn-recovery-continue').addEventListener('click', () => {
  const draft = loadDraft();
  if (!draft) return;
  recoveryModal.style.display = 'none';
  if (draft.activeSessionId) activeSessionId = draft.activeSessionId;
  els.transcript.value = draft.text;
  rec.finalText = draft.text;
  els.btnGdocs.disabled = false;
  showIdleUI();
  showToast('טיוטה שוחזרה');
  beginRecording(draft.text);
});

document.getElementById('btn-recovery-save').addEventListener('click', async () => {
  const draft = loadDraft();
  if (!draft) return;
  recoveryModal.style.display = 'none';
  if (draft.activeSessionId) activeSessionId = draft.activeSessionId;
  els.transcript.value = draft.text;
  rec.finalText = draft.text;
  try {
    await persistCurrentSession(draft.text);
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
  // Exact-text match: draft was already saved before the crash
  if (sessions.some(s => s.text === draft.text)) { clearDraft(); return; }
  showRecoveryModal(draft);
}

(async function init() {
  await initStorage();
  await checkRecovery();
  showIdleUI();
})();
