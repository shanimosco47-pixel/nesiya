export const els = {
  transcript:     document.getElementById('transcript-edit'),
  interim:        document.getElementById('interim-display'),
  statusPill:     document.getElementById('status-pill'),
  statusText:     document.getElementById('status-text'),
  btnStart:       document.getElementById('btn-start'),
  btnContinue:    document.getElementById('btn-continue'),
  btnPause:       document.getElementById('btn-pause'),
  btnStop:        document.getElementById('btn-stop'),
  btnGdocs:       document.getElementById('btn-gdocs'),
  silenceWrap:    document.getElementById('silence-bar-wrap'),
  silenceBar:     document.getElementById('silence-bar'),
  sessionsPanel:  document.getElementById('sessions-panel'),
  sessionsList:   document.getElementById('sessions-list'),
  sessionViewer:  document.getElementById('session-viewer'),
  viewerTitle:    document.getElementById('viewer-title'),
  viewerContent:  document.getElementById('session-viewer-content'),
  searchBar:      document.getElementById('search-bar'),
  searchInput:    document.getElementById('search-input'),
  searchCount:    document.getElementById('search-count'),
};

export function setStatus(cls, label) {
  els.statusPill.className = 'status-pill ' + cls;
  els.statusText.textContent = label;
}

export function showRecordingUI() {
  els.btnStart.style.display = 'none';
  els.btnContinue.style.display = 'none';
  els.btnPause.style.display = 'flex';
  els.btnPause.textContent = '⏸ השהה';
  els.btnStop.style.display = 'flex';
  setStatus('recording', 'מקליט');
}

export function showPausedUI() {
  els.btnPause.textContent = '▶️ המשך';
  setStatus('paused', 'מושהה');
}

export function showIdleUI() {
  els.btnStart.style.display = 'flex';
  els.btnContinue.style.display = els.transcript.value.trim() ? 'flex' : 'none';
  els.btnPause.style.display = 'none';
  els.btnStop.style.display = 'none';
  setStatus('', 'מוכן');
  els.interim.textContent = '';
  stopSilenceBar();
}

let _toastTimer;
export function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// Callbacks wired by app.js
export const uiCallbacks = {
  onViewSession:   null, // (id) => void
  onLoadSession:   null, // (id) => void
  onDeleteSession: null, // (id) => void
};

export function renderSessions(sessions) {
  els.sessionsList.textContent = '';
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'אין הקלטות שמורות עדיין';
    els.sessionsList.appendChild(empty);
    return;
  }
  for (const s of sessions) {
    const card = document.createElement('div');
    card.className = 'session-card';

    const date = document.createElement('div');
    date.className = 'session-date';
    date.textContent = s.date;

    const preview = document.createElement('div');
    preview.className = 'session-preview';
    preview.textContent = s.text.slice(0, 200);

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    const btnView = document.createElement('button');
    btnView.className = 'session-btn primary';
    btnView.textContent = 'צפה';
    btnView.addEventListener('click', () => uiCallbacks.onViewSession?.(s.id));

    const btnLoad = document.createElement('button');
    btnLoad.className = 'session-btn success';
    btnLoad.textContent = 'טען לעריכה';
    btnLoad.addEventListener('click', () => uiCallbacks.onLoadSession?.(s.id));

    const btnDel = document.createElement('button');
    btnDel.className = 'session-btn danger';
    btnDel.textContent = 'מחק';
    btnDel.addEventListener('click', () => uiCallbacks.onDeleteSession?.(s.id));

    actions.append(btnView, btnLoad, btnDel);
    card.append(date, preview, actions);
    els.sessionsList.appendChild(card);
  }
}

// ── Silence bar ──────────────────────────────────────────────────────────────
let _silenceInterval = null;
let _silenceStart = null;

export function startSilenceBar(duration) {
  els.silenceWrap.classList.add('visible');
  els.silenceBar.style.transition = 'none';
  els.silenceBar.style.width = '100%';
  clearInterval(_silenceInterval);
  _silenceStart = Date.now();
  _silenceInterval = setInterval(() => {
    if (!_silenceStart) return;
    const pct = Math.max(0, 100 - ((Date.now() - _silenceStart) / duration) * 100);
    els.silenceBar.style.transition = 'width 1s linear';
    els.silenceBar.style.width = pct + '%';
  }, 1000);
}

export function resetSilenceBar() {
  _silenceStart = Date.now();
  els.silenceBar.style.transition = 'none';
  els.silenceBar.style.width = '100%';
}

export function stopSilenceBar() {
  els.silenceWrap.classList.remove('visible');
  clearInterval(_silenceInterval);
  _silenceStart = null;
}
