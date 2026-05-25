# Claude Working Notes — נסיעה Project

Accumulated corrections and preferences from all prior sessions.
Load this at session start. Do not modify it without user instruction.

---

## Working Style — Process

**Commit discipline**
- One concern per commit, clear descriptive message. Never squash unrelated changes.
- Commit message explains *why*, not just what.

**PR lifecycle**
- Never auto-merge. Merge only on explicit "merge and deploy" instruction.
- Never push directly to main except for hotfixes the user has explicitly authorized.
- When PR review is done, stop touching code. Move to verification only.
- Report test results first; wait for user to say merge.

**Verification before shipping**
- This repo has no CI. Do not poll CI status. Run `tests.html` manually instead.
- Run `tests.html` via Puppeteer after every change to `js/recognition.js` or `js/storage.js`.
- For screen-off/resume bugs: write a Puppeteer simulation with a MockSR; be explicit that physical Android is required for final sign-off.

**Diagnosis before patching**
- When a bug persists after one fix attempt: stop iterating. Identify the root cause first, then fix.
- The user's escalation: "write a document describing the problem and your approach" → that's a signal to stop patching and think.
- Never continue with patches when you don't understand why the previous one failed.

**Deployment verification**
- The build stamp (`#build-stamp`) shows `document.lastModified` formatted in Hebrew. The user reads it to verify live status. It must be accurate.
- After pushing, confirm the stamp will update (i.e., the SW cache version was bumped).

---

## Platform

- **Target: Android Chrome only.** Never assume iOS. Never suggest iOS-specific fixes.
- `webkitSpeechRecognition` (standard `SpeechRecognition` also works in Chrome). No other browsers.
- Hebrew (`he-IL`). Online required — audio goes to Google servers.
- Installed as PWA (home-screen icon, manifest, service worker).

---

## Architecture

- Pure static GitHub Pages PWA. **No build step** (no webpack, vite, parcel, etc.).
- ES modules: `js/app.js`, `js/storage.js`, `js/recognition.js`, `js/ui.js`, `js/diagnostics.js`.
- `index.html` is the entry point. No server-side code.
- Service worker (`sw.js`) with network-first strategy. **Bump cache version on every change** that users need to pick up (currently `nesiya-v10`).

---

## Recognition Engine — Known Behaviors and Rules

**`continuous = true`**
- Must be set to `true`. With `continuous = false`, Chrome fires `onend` on every silence window and the `onend` → `_restart` loop plays Chrome's built-in start/stop audio cues continuously. `continuous = true` keeps one session alive; Chrome plays one start cue when recording begins.

**Deduplication (`dedupeAppend`)**
- `MIN_OVERLAP_WORDS = 3`. Do **not** remove 1- or 2-word overlaps — they are legitimate repeated words/names (e.g., "מירב ... מירב").
- Dedup is applied only on `_atSessionStart` (first `onresult` of each new `_init()` call), never mid-session.
- This handles Chrome Android's inter-session text replay.

**Fatal errors vs. intentional stop**
- `_kill()` (mic denied, audio-capture) → calls `onFatalAbort`, NOT `stopAndSave`. No success feedback, no phantom session created. Draft is kept.
- `stopAndSave()` is only for user-intentional stops.

**Restart loop**
- `onend` triggers `_restart()` after 150 ms if `isRecording && !isPaused && !_restartPending`.
- With `continuous = true` this fires only on unexpected session close (error/OS kill), not on normal silence.

---

## Draft / Crash Recovery — Data Model Rules

**Current draft format** (stored in `localStorage('nesiya_draft')`):
```json
{ "finalText": "...", "interimText": "...", "activeSessionId": 12345, "savedAt": 1716000000000 }
```
- `finalText`: confirmed speech only (from `onresult` final events).
- `interimText`: unconfirmed partial speech. Stored separately so recovery can display them distinctly.
- `legacyCombinedText`: NOT stored; added by `loadDraft()` normalization only.

**Backward compatibility** — `loadDraft()` normalizes all formats:
1. `{ finalText, interimText }` → `legacyCombinedText: false`
2. `{ text, includesInterim: false }` → `legacyCombinedText: false`
3. `{ text, includesInterim: true }` → `legacyCombinedText: true` (can't separate)
4. Plain string → `legacyCombinedText: true`
Never break any of these formats.

**Recovery UI rules**
- Legacy drafts (`legacyCombinedText: true`): gate "המשך הקלטה" and "שמור כהקלטה" behind an explicit acknowledgement checkbox. "מחק טיוטה" is always available without confirmation.
- New format drafts: show `finalText` and `interimText` separately. Interim is opt-in only.
- `activeSessionId` must round-trip through draft so that recovery → save updates the original session, not creates a duplicate.

**Immediate save on screen-off**
- On `visibilitychange → hidden`: call `saveDraft({ finalText: textarea.value, interimText: '' })` synchronously BEFORE `pauseRecognition()`. Do not rely on the 1500 ms debounced autosave.
- The textarea is the authoritative source of truth, not `rec.finalText`.

---

## Screen-Off / Visibility Handling

**Before pause (hidden)**:
1. `_syncRecognitionState()` — promotes `textarea.value` → `rec.finalText`
2. `saveDraft(...)` — immediate persist
3. `pauseRecognition()`

**Before resume (visible)**:
1. `_syncRecognitionState()` — re-sync in case state drifted
2. `resumeRecognition()`

**`promoteFinalText(text)`** (exported from `recognition.js`):
- `state.finalText = text.trim() ? text.trim() + ' ' : ''`
- Use `text.trim()` (both ends), NOT `text.trimEnd()`.

---

## Storage Rules

- `upsertSession` and `removeSession` throw `StorageError` on write failure. Callers must catch and show a Hebrew error toast.
- `saveDraft` returns `bool`. Show quota toast (once per recording session via `_draftWarnSent` flag) on `false`.
- Never show "saved successfully" or clear the draft when persistence actually failed.
- Never swallow storage errors silently.
- Primary storage: IndexedDB (`nesiya` db, `sessions` objectStore, `keyPath: 'id'`). Fallback: localStorage (migration runs on `initStorage()`).

---

## UI Rules

- **No `window.confirm()`.** All user-facing dialogs must be real modal UI with Hebrew-labeled buttons.
- **No build-time audio feedback removal without user consent.** If removing a feature the user values, ask first. The start/stop beeps were initially user-valued ("important for knowing if recording stopped while driving") before the user later decided to remove them.
- **Button labels must accurately describe behavior.** "פתח Docs והעתק" (not "שמור ב-Google Docs") because the action is open + copy, not real save.
- Transcript textarea must maximize screen real estate during active recording (full-height, large font).
- Main screen must simultaneously show both "הקלטה חדשה" and "המשך הקלטה" when there is existing text.
- Build stamp in footer: `document.lastModified` formatted as `עודכן DD.MM.YYYY · HH:MM` in Hebrew locale.

---

## Bugs I Introduced — Patterns to Avoid

| Bug | Root cause | Prevention |
|-----|-----------|-----------|
| Recording button did nothing after ES module refactor | Removed `onclick` HTML attributes, forgot to add `addEventListener` calls | After any refactor, verify all interactive controls still respond |
| `continuous = false` caused constant beep/click sounds on silence | Chrome plays built-in audio cues on SR start/stop; with `continuous = false` this cycles on every silence window | Always use `continuous = true` |
| Duplicate text in transcript | Stale `e.resultIndex` assumption; incorrect cumulative result handling | Track `_finalCount` per session, iterate from `_finalCount` to `e.results.length` |
| Previous sentence wiped during speech | Overwriting entire textarea on each interim result instead of appending | `textarea.value = finalText + interim`; `finalText` accumulates, only `interim` is transient |
| Interim text promoted as final in crash recovery | Draft stored `text: finalText + interim` as one field; recovery used it as confirmed | Store `finalText` and `interimText` as separate fields always |
| Duplicate session created on crash recovery | Draft didn't store `activeSessionId`; recovery couldn't find original session | Always include `activeSessionId` in draft |
| Fatal mic-denied error triggered success beep + phantom session | `_kill()` was wired to `stopAndSave()` | Separate `onFatalAbort` handler; never call `stopAndSave` on fatal errors |
| dedupeAppend too aggressive, removed legitimate "מירב ... מירב" | 1-word overlap threshold; dedup applied mid-session | `MIN_OVERLAP_WORDS = 3`; dedup only at `_atSessionStart` |
| Test claiming "3-word overlap" only had 2-word overlap | Didn't verify the test string matched the test description | Count the overlap words before writing the test |
| `promoteFinalText` kept leading whitespace | Used `text.trimEnd()` instead of `text.trim()` | Use `text.trim()` when normalizing for storage |
| Screen-off wiped transcript on resume | `rec.finalText` was behind `textarea.value`; new SR session started from stale state | Sync `textarea.value → rec.finalText` before every pause/resume |
| Build timestamp showed future time | Timezone computation error in `document.lastModified` formatting | Test the stamp immediately after deploy; check against current device time |

---

## Tests

- `tests.html` — 77 tests across 15 sections. All must pass before marking any PR ready.
- Tests import from `./js/recognition.js` and `./js/storage.js` directly.
- No DOM required for pure-logic tests (dedupeAppend, draft storage, backward compat).
- Recognition state tests: set `state.isRecording`, `state.isPaused`, `state.finalText` directly since `state` is exported.
- Run via Puppeteer (`/tmp/node_modules/puppeteer`, Chrome at `/root/.cache/puppeteer/chrome/linux-148.0.7778.167/chrome-linux64/chrome`) on port 8743.

---

## Feature Inventory (current)

- **Record new** / **Continue existing** session
- **Pause / Resume** (manual toggle)
- **Auto-pause on screen-off**, auto-resume on screen-on (800 ms delay)
- **Silence timer** (5 min → auto-stop)
- **Wake Lock** (screen stays on during active recording)
- **Crash recovery modal** (3 choices: continue / save / discard)
- **Session history** with view, load-for-edit, delete
- **Export**: JSON and Markdown
- **Google Docs shortcut**: opens new Doc + copies text to clipboard
- **Search** within current transcript
- **Diagnostic log** copy button (bounded 200-entry ring buffer)
- **Build stamp** in footer
- **Update banner** on SW controllerchange
- **IndexedDB** primary storage with localStorage migration + fallback
