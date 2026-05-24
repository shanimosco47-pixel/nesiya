# נסיעה — Voice Transcription PWA

Speech-to-text app for use while driving. Single-file PWA on GitHub Pages.
Language: Hebrew (`he-IL`). No backend.

## Quick start

Open the GitHub Pages URL in Chrome on Android. Tap **🎙️ הקלטה חדשה** and start
speaking. Tap **⏹ סיים** to save. Sessions are stored in IndexedDB on-device.

Install as a home-screen app: Chrome menu → *Add to home screen*.

## Manual test checklist

Before merging or after changes to `js/recognition.js` or `js/app.js`:

- [ ] **Basic recording** — record a sentence, stop, verify it appears in history.
- [ ] **Continue session** — history → "טען לעריכה", record more, stop → existing entry
  updated in place (no duplicate in history).
- [ ] **Session viewer continue** — history → "צפה" → "המשך הקלטה זו" → stop → same entry updated.
- [ ] **Pause / resume** — tap ⏸, wait 10 s, tap ▶️, speech continues appending correctly.
- [ ] **Screen lock** — lock screen while recording → unlock → recording resumes automatically.
- [ ] **Wake Lock** — screen stays on during active recording (no auto-off).
- [ ] **Crash recovery** — start recording, force-close Chrome, reopen → recovery modal
  appears with 3 choices; each choice works correctly.
- [ ] **Interim text recovery** — crash mid-sentence (before final event) → recovery draft
  includes the partial words visible before the crash.
- [ ] **Duplicate dedup** — say "שלום עולם" in session 1, restart → session 2's first result
  should not repeat those words. Verify in textarea.
- [ ] **Legitimate repeat** — say "דיברתי עם מירב, מירב אמרה שכן" — both occurrences of "מירב"
  must appear in the transcript.
- [ ] **Export** — history panel → JSON ↓ and MD ↓ each download a file with the right content.
- [ ] **Docs button** — "📋 פתח Docs והעתק" opens a new Google Doc tab and copies text.
- [ ] **Diagnostic log** — history panel → 🐞 → pastes the log into clipboard (verify in notes).
- [ ] **Storage full** — simulate quota error (DevTools → Application → Storage → set quota to
  1 MB) → error toast shown, draft NOT cleared.
- [ ] **No microphone** — deny mic permission → Hebrew toast shown, app returns to idle.
- [ ] **Network error** — airplane mode during recording → "שגיאת רשת..." toast; recording
  continues when back online.
- [ ] **tests.html** — open `/tests.html` in Chrome; all tests pass green.

## Known limitations

- **Chrome / Chrome Android only** — uses `webkitSpeechRecognition` (non-standard).
  Firefox and Safari do not support it.
- **Hebrew only** — recognition is hardcoded to `he-IL`. Other languages need a `lang`
  setting UI.
- **Online required** — `webkitSpeechRecognition` sends audio to Google's servers.
  Offline mode is not possible.
- **Wake Lock denied in some environments** — Low-power mode, restricted battery
  settings, or some Android skins silently deny wake lock requests. The app logs
  the failure (🐞 log) but falls back gracefully — screen may still turn off.
- **Inter-session dedup heuristic** — `dedupeAppend` removes overlaps of ≥ 3 words on
  the first result of each recognition session to handle Chrome Android's replay bug.
  Very short sentences (< 3 words) replayed across sessions will not be deduped.
- **Google Docs integration** — no real OAuth integration; clicking "פתח Docs והעתק"
  opens a new document and copies the text to clipboard for manual paste.
- **Single-device** — sessions live in on-device IndexedDB; no sync across devices.
