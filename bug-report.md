# באג: כפל טקסט ב-Web Speech API על Chrome Android

## תיאור הבעיה

אפליקציית תמלול (קובץ `index.html` בודד, ללא backend) משתמשת ב-`webkitSpeechRecognition` עם `continuous: true` ו-`interimResults: true`.
המשתמש מדווח על כפל מסיבי של טקסט — אותו ביטוי מופיע עשרות פעמים בתמליל.

ראה דוגמה מהשטח: המשפט "בדיקה אני רוצה להגיד משהו" הופיע כ-30+ פעמים ברצף בתוך הקלטה אחת.

---

## מה ניסיתי — ולמה לא פתר

### ניסיון 1: הסרת קריאה כפולה ל-`restartRecognition()`
`onerror` ו-`onend` שניהם קראו ל-restart — גרם ל-double-start. הסרתי את הקריאה מ-`onerror`.
**תוצאה:** פתר את לולאת הניתוק הראשונית, אך הכפל נמשך.

### ניסיון 2: יצירת אובייקט `SpeechRecognition` חדש בכל restart
במקום `recognition.start()` על אובייקט קיים — קריאה ל-`initRecognition()` שיוצרת אובייקט חדש לגמרי.
**ההנחה:** אובייקט ישן עם buffer מלא גורם לעיבוד כפול של `e.results`.
**תוצאה:** ללא שינוי.

### ניסיון 3: Session ID
כל `initRecognition()` מקבל `sessionId` ייחודי. כל handler מתעלם מאירועים אם `currentSessionId !== sessionId`.
**ההנחה:** אובייקט ישן שירה `onresult` מאוחר (אחרי `onend`) וכתב ל-`finalText` פעמיים.
**תוצאה:** ללא שינוי.

### ניסיון 4: `finalResultsCount`
במקום להסתמך על `e.resultIndex` (שיכול להיות לא אמין), אני מנהל מונה משלי שעוקב אחרי כמה תוצאות סופיות כבר עיבדתי. הלולאה מתחילה ממנו ולא מ-`e.resultIndex`.

```javascript
for (let i = finalResultsCount; i < e.results.length; i++) {
  if (e.results[i].isFinal) {
    newFinal += e.results[i][0].transcript + ' ';
    finalResultsCount = i + 1;
  } else {
    interim += e.results[i][0].transcript;
  }
}
```

**ההנחה:** Chrome Android מאפס את `e.resultIndex` ל-0 אחרי pause, ובלולאה הרגילה `for (i = e.resultIndex)` כל התוצאות הקודמות מעובדות מחדש.
**תוצאה:** טרם נבדק בשטח — זו הגרסה הנוכחית.

---

## מה אני לא בטוח בו — שאלות לעמית

### שאלה 1 (הכי חשובה): מה בדיוק קורה עם `e.resultIndex` על Chrome Android?

האם אכן ידוע ש-Chrome Android מאפס `e.resultIndex = 0` לא ברצף הנכון?  
או שהבעיה היא אחרת לגמרי — למשל:
- `onresult` נקרא כפול עבור אותה תוצאה?
- יש race condition שגורם לאותו handler להריץ פעמיים?
- `continuous: true` עם Android יוצר behavior שונה לחלוטין ממה שמתועד?

**מה אני רוצה:** תיאור מדויק של ה-invariant הנכון של `e.resultIndex` ו-`e.results` בין אירועים ברצף על Chrome Android.

---

### שאלה 2: האם `finalResultsCount` הוא הפתרון הנכון, או שהוא מסתיר את הבעיה?

`finalResultsCount` מניח שתוצאות סופיות מגיעות לפי סדר עולה ושלא יהיו "חורים" (תוצאה N מסמן final לפני N-1). האם זה תמיד נכון ב-Web Speech API?

אם לא — `finalResultsCount` יחמיץ תוצאות לגיטימיות.

---

### שאלה 3: האם `continuous: true` הוא הגישה הנכונה לתמלול ארוך על אנדרואיד?

כל הבעיות שנתקלתי בהן (restart, כפל, `e.resultIndex` לא אמין) קשורות ל-restart שמתרחש גם עם `continuous: true`.

אולי הגישה הנכונה היא `continuous: false` עם restart ידני וניהול מדויק של `finalText` בין sessions? האם יש pattern מוכר לזה?

---

### שאלה 4: האם יש דרך לדיבאג את זה?

אין לי גישה לאנדרואיד של המשתמש. המשתמש רואה תוצאות בשטח אבל אני לא יכול לראות:
- מה בדיוק הערכים של `e.resultIndex`, `e.results.length` בכל אירוע
- כמה פעמים `onresult` נקרא
- האם `onend` מקדים `onresult` או להיפך

**בקשה:** אם יש instrumentation pattern מוכר לדיבאג Web Speech API בשטח (למשל log לשרת, שמירת history של events) — מה מומלץ?

---

## הקוד הנוכחי הרלוונטי

```javascript
let currentSessionId = 0;
let finalResultsCount = 0;
let finalText = '';

function initRecognition() {
  const sessionId = ++currentSessionId;
  finalResultsCount = 0;
  recognition = new SR();
  recognition.lang = 'he-IL';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (e) => {
    if (currentSessionId !== sessionId) return;
    let interim = '', newFinal = '';
    for (let i = finalResultsCount; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) { newFinal += t + ' '; finalResultsCount = i + 1; }
      else { interim += t; }
    }
    if (newFinal) finalText += newFinal;
    transcriptEl.value = finalText + interim;
  };

  recognition.onend = () => {
    if (currentSessionId !== sessionId) return;
    if (!isPaused && isRecording && !restartScheduled) {
      restartScheduled = true;
      setTimeout(() => {
        restartScheduled = false;
        if (isRecording && !isPaused) restartRecognition();
      }, 400);
    }
  };
}

function restartRecognition() {
  initRecognition(); // fresh object + reset finalResultsCount
  try { recognition.start(); } catch(e) { ... }
}
```

---

## סביבה

- דפדפן: Chrome על Android
- שפת זיהוי: עברית (`he-IL`)
- שימוש: תמלול נסיעות, כמה דקות ברצף
- אין backend — הכל client-side
