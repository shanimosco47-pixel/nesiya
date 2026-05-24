# סקר עמיתים: שני באגים בעקבות PR #14

## הקשר כללי

אפליקציית תמלול נסיעות — קובץ `index.html` בודד, ללא backend, PWA על GitHub Pages.
זיהוי דיבור: `webkitSpeechRecognition`, `continuous=false`, `interimResults=true`.
שני הבאגים הופיעו לאחר PR #14 שהוסיף אינטגרציית Google Docs API + ספריית GIS.

---

## באג 1: צפצופים לא צפויים בזמן נהיגה

### תיאור

הצפצופים הם ה-start/stop beeps הרגילים (לא באג חדש בעצמם — הם נחוצים),
אך הם מתרחשים בתדירות ובתזמון לא צפויים מנקודת מבט המשתמש.

ה-AudioContext נוצר ב-load time:
```javascript
const ctx = new (window.AudioContext || window.webkitAudioContext)();
```
ב-Chrome Android, הוא מתחיל ב-`suspended` state.

### מה קורה בפועל

ב-`startRecording()`:
```javascript
if (ctx.state === 'suspended') ctx.resume(); // async — לא מחכה
if (!initRecognition()) return;
recognition.start();
beepStart(); // ← נקרא לפני שה-resume הסתיים
```

`ctx.resume()` הוא Promise שלא מחוכה. כשמתקרא `beepStart()` ומתוכנן oscillator
עם `osc.start(ctx.currentTime)` — הקשר עדיין suspended, `ctx.currentTime` קפוא.
כשהקשר מתחיל לרוץ, כל ה-oscillators שתוזמנו בזמן ה-freeze מתפוצצים בבת אחת.

### תרחיש שנוסף עם PR #14

ספריית GIS נטענת async ויכולה לרשום event listeners ברמת `document`.
אם GIS מנהל לכלוא touch/click events (capture phase), ייתכן שהכפתורים
של ה-pause/stop מקבלים מספר אירועים — כל אחד מפעיל `beepPause`/`beepResume`.
לא אישרתי זאת, אך זה הסבר אפשרי לכפל הצפצופים.

### שאלות לעמית

1. **האם ידוע ש-GIS רושם listeners גלובליים שיכולים לקלוע?**
   בפרט — האם `google.accounts.oauth2.initTokenClient` (שנקרא רק אם יש `GOOGLE_CLIENT_ID`)
   משפיע על events גם כשהוא לא מופעל?

2. **מה ה-invariant הנכון עבור `AudioContext.currentTime` ב-suspended state?**
   האם scheduleing לפני `resume()` בטוח, או שצריך לחכות ל-`ctx.resume().then(() => beep(...))`?

3. **האם הכי נכון להפריד לחלוטין את ה-AudioContext מ-`startRecording()` ולנהל resume ב-onClick?**

### הגישה שאני חושב עליה

```javascript
// startRecording: await the resume, then beep
async function startRecording() {
  if (ctx.state === 'suspended') await ctx.resume();
  if (!initRecognition()) return;
  recognition.start();
  beepStart();
  ...
}
```

**חיסרון:** `startRecording()` הופכת async — דורש עדכון כל הקוראים לה.

**חלופה:** בדיקת `ctx.state` בתוך `beep()` ו-skip אם suspended:
```javascript
function beep(freq, duration, type, vol) {
  if (ctx.state !== 'running') return; // Skip if context not ready
  ...
}
```
זה יוודא שלא נצטבר audio בזמן שהקשר עצור — אך יאבד צפצופים לגיטימיים.

**אני לא בטוח** איזו גישה נכונה יותר בהתחשב ב-UX (המשתמש צריך את הצפצוף לאישור הקלטה).

---

## באג 2: שמירה ב-Google Docs לא עובדת

### תיאור

לחיצה על "שמור ב-Google Docs" — בשתי הגרסאות (לפני ואחרי PR #15) — לא יוצרת
מסמך Google ולא פותחת חלון שימושי.

### שורש הבעיה

`GOOGLE_CLIENT_ID = ''` — הקוד מוגדר עם מחרוזת ריקה כ-placeholder.
ה-guard `if (!GOOGLE_CLIENT_ID) return` מונע כל אתחול OAuth.
`tokenClient` נשאר `null`, ולכן תמיד נכנסים ל-fallback.

ה-fallback הנוכחי (אחרי PR #15):
```javascript
window.open('https://docs.google.com/document/create', '_blank');
navigator.clipboard.writeText(...).then(...);
```

### למה ה-fallback לא עובד ב-PWA

כשהאפליקציה מותקנת כ-PWA (standalone mode) על Android,
`window.open` עם URL שמחוץ ל-scope של ה-PWA (`*.github.io/nesiya`)
מתנהג שונה:
- בחלק מגרסאות Android/Chrome: נפתח ב-Chrome הרגיל ✓
- בגרסאות אחרות: נחסם בשקט, או נפתח ב-Custom Tab בתוך ה-PWA ✗

ייתכן שזו הסיבה שהמשתמש לא רואה שום תגובה.

### שאלות לעמית

1. **האם `window.open` על external URL עובד ב-PWA standalone mode על Android?**
   אם לא — מה ה-pattern הנכון? האם `<a href target="_blank">` click נוצר programmatically עובד?
   ```javascript
   const a = document.createElement('a');
   a.href = url; a.target = '_blank'; a.rel = 'noopener';
   document.body.appendChild(a); a.click(); document.body.removeChild(a);
   ```

2. **מה הדרך הנכונה לאינטגרציה עם Google Docs כשאין backend?**
   - Google Docs API v1 דורשת OAuth 2.0 ו-Client ID — זה מחייב פרויקט Google Cloud
   - האם `data:` URI עם `text/plain` יכול לשמש כ-workaround?
   - האם יש API פשוט יותר (Google Keep? Workspace?) שעובד ללא הגדרת Cloud project?

3. **אם אין ברירה והמשתמש חייב להקים Client ID** — מה הדרך הפשוטה ביותר לדריכת יד?
   האם אפשר להשתמש ב-Google Apps Script כ-intermediary שלא דורש Cloud Console?

### הגישה שאני חושב עליה

#### Option A: Direct link pattern (PWA-safe fallback)
```javascript
const a = document.createElement('a');
a.href = 'https://docs.google.com/document/create';
a.target = '_blank'; a.rel = 'noopener noreferrer';
a.click();
```
+ clipboard copy של הטקסט. משתמש מדביק ידנית.
**חיסרון:** לא פתרון אמיתי, רק fallback משופר.

#### Option B: Google Apps Script webhook
יצירת Apps Script עם `doPost(e)` שמקבל טקסט ב-POST ויוצר Doc בחשבון Google ספציפי.
- ה-Script URL הוא constant ב-`index.html`
- לא דורש Client ID / Cloud Console
- רק `fetch(APPS_SCRIPT_URL, { method:'POST', body: text })`
**חיסרון:** דורש הגדרה חד-פעמית של Apps Script + הרשאות execution
**יתרון:** אין OAuth UI, אין Google Cloud project, עובד מ-PWA

#### Option C: OAuth 2.0 עם Client ID (כפי שמומש כבר)
עובד, אבל דורש הקמת פרויקט Google Cloud ממשתמש לא-טכני.

---

## סביבה

- Chrome על Android (PWA standalone mode)
- GitHub Pages, שפת תמלול: עברית
- קובץ בודד, ללא backend
- GIS: `https://accounts.google.com/gsi/client` — נטעון async בסוף body
