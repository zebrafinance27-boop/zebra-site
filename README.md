# אתר זברה — Astro + מערכת ניהול תוכן

אתר תדמית + בלוג, בנוי ב-Astro. שומר על העיצוב של דף הנחיתה, ומאפשר לפרסם מאמרים דרך ממשק נוח (Decap CMS) בלי לגעת בקוד.

## מבנה
- `src/pages/` — העמודים: בית (`index.astro`), הלוואות (`loans/`), אודות, צור קשר, בלוג.
- `src/content/blog/` — המאמרים (קובצי Markdown). כל מאמר חדש = קובץ כאן (או דרך ה-CMS).
- `src/components/` — רכיבים משותפים (Header, Footer, טופס הלידים, סקריפט).
- `src/styles/global.css` — כל העיצוב.
- `public/images/` — תמונות (לוגו, זברה, ותמונות שמעלים מה-CMS).
- `public/admin/` — מערכת ניהול התוכן (Decap CMS).

## הרצה מקומית (לא חובה)
```
npm install
npm run dev
```

## העלאה לאוויר (פעם אחת)
1. **GitHub** — פתחו חשבון (חינם) והעלו את כל התיקייה לריפו חדש.
2. **Netlify** — New site → Import from GitHub → בחרו את הריפו. Netlify מזהה Astro אוטומטית (Build: `npm run build`, Publish: `dist`).
3. עדכנו את הכתובת ב-`astro.config.mjs` וב-`public/robots.txt` לדומיין הסופי שלכם (חשוב ל-SEO).

## מערכת ניהול התוכן (כתיבת מאמרים)
ההתחברות מוגדרת דרך **DecapBridge** (חינמי). אחרי ההרשמה אצלם, מוסיפים ל-`public/admin/config.yml`:
```
backend:
  name: git-gateway
  branch: main
  repo: USERNAME/REPO
  identity_url: https://auth.decapbridge.com/....
```
ואז נכנסים לכתובת `כתובת-האתר/admin` כדי לכתוב מאמרים. כל פרסום מתעדכן באתר אוטומטית.

## מה כבר מובנה ל-SEO
כותרת ותיאור ייחודיים לכל עמוד, `sitemap.xml` אוטומטי, `robots.txt`, נתונים מובנים (Organization / Article / FAQ), ותגי Open Graph לשיתוף ברשתות.

## פרטי קשר וטופס
מספרי הטלפון/וובהוקים מוגדרים ב-`src/components/SiteScript.astro` בתוך `CONFIG`.
