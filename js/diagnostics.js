// Bounded diagnostic log — max 200 entries in memory, last 50 persisted to
// localStorage so logs survive a crash/reload for post-mortem analysis.
const MAX_MEM = 200;
const MAX_LS  = 50;
const LS_KEY  = 'nesiya_diag';

const _log = [];

// Restore entries from previous session (e.g. to inspect a crash)
try {
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  _log.push(...saved.slice(-MAX_LS));
} catch {}

export function diagLog(type, detail = {}) {
  const entry = { t: new Date().toISOString(), type, ...detail };
  _log.push(entry);
  if (_log.length > MAX_MEM) _log.shift(); // bounded — never grows unbounded
  _persist();
}

function _persist() {
  try {
    // Store only the most recent MAX_LS entries so localStorage stays tiny
    localStorage.setItem(LS_KEY, JSON.stringify(_log.slice(-MAX_LS)));
  } catch {} // best-effort; never throw from a diagnostic path
}

export function getDiagLog() { return [..._log]; }

export function formatDiagLog() {
  return _log.map(({ t, type, ...rest }) => {
    const detail = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
    return `${t} [${type}]${detail}`;
  }).join('\n');
}

export async function copyDiagLog() {
  const text = formatDiagLog();
  await navigator.clipboard.writeText(text || '(empty log)');
}

export function clearDiagLog() {
  _log.length = 0;
  try { localStorage.removeItem(LS_KEY); } catch {}
}
