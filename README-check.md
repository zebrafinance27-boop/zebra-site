# בדיקת מימון כנגד רכב (`/check/`)

משפך דיגיטלי לקמפיין Meta. React 18 + Tailwind בקובץ יחיד, בלי שלב build.

| קובץ | תפקיד |
|---|---|
| `public/check/index.html` | כל האפליקציה (מסכים, חישובים, Pixel, מצב הדגמה) |
| `netlify/functions/submit-lead.mjs` | בודק את הליד בצד השרת, שולח לכתובת הלידים של הסוכן (→ monday), ואחר כך שולח Lead ל-CAPI |
| `netlify/functions/track.mjs` | שולח את אירועי המשפך ל-CAPI עם אותו `event_id` כמו ה-Pixel |
| `netlify/lib/shared.mjs` | פונקציות עזר (CAPI, hash, בדיקת Origin) |
| `public/_redirects` | `/api/*` → `/.netlify/functions/*` |

## מצב הדגמה
ב-`localhost` או עם `?demo=1` שום מידע לא יוצא מהדפדפן. מוצג פס צהוב, ובמסך התוצאות אפשר לפתוח את ה-Payload שהיה נשלח.
בכתובת האמיתית המערכת עובדת במצב Live. כדי לבדוק Live ב-localhost מוסיפים `?live=1`.

תצוגה מקומית: מגדרת התצוגה `zebra-check` (`_drafts/check-preview/serve.ps1`), בכתובת http://localhost:8766/check/

## משתני סביבה ב-Netlify (Site configuration → Environment variables)
| משתנה | חובה | הערה |
|---|---|---|
| `LEAD_WEBHOOK_URL` | ✅ | הכתובת של הסוכן שמקבל את הלידים. היא נשמרת רק בשרת. הדף שולח רק לכתובת הזו, אף פעם לא ל-Make |
| `WEBHOOK_SECRET` | ✅ | נשלח בכותרת `X-Zebra-Token`, ובנוסף `X-Zebra-Signature` = HMAC-SHA256 של ה-body. הסוכן בודק את החתימה. הפרטים ב-`LEAD-WEBHOOK-SPEC.md` |
| `ALLOWED_ORIGINS` | מומלץ | `https://zebra-finance.co.il,https://www.zebra-finance.co.il` |
| `META_PIXEL_ID` | ל-CAPI | אותו ID שמוגדר ב-`CONFIG.metaPixelId` ב-HTML |
| `META_CAPI_TOKEN` | ל-CAPI | Access token מ-Events Manager |
| `META_TEST_EVENT_CODE` | לבדיקות | למחוק אחרי הבדיקה |

בנוסף, ב-`public/check/index.html` ממלאים את `CONFIG.metaPixelId`. זה ID ציבורי, ולכן מותר שיופיע בדפדפן.

## אירועי Meta
`PageView` → `StartApplication` → `VehicleDetailsCompleted` → `FinancingDetailsCompleted` → `Lead`
* כל אירוע נשלח מה-Pixel ומ-CAPI עם אותו `event_id`, וכך Meta מסירה כפילויות. כל אירוע משפך נשלח פעם אחת בכל session.
* `Lead` נשלח רק אחרי שהסוכן החזיר תשובה 2xx. ה-`event_id` הוא `lead-<lead_id>`, ולכן גם ניסיון חוזר לא יוצר כפילות.
* ל-Meta לא נשלחים סכומים, שווי רכב, מצב שעבוד או יתרה. נשלחים רק טלפון, מייל ושם כ-hash, יחד עם fbp/fbc, IP ו-UA.

## שדות שמגיעים לסוכן (המפרט המלא ב-`LEAD-WEBHOOK-SPEC.md`)
`lead_id, reference, full_name, email, phone, vehicle_year, vehicle_value, lien_status, lien_status_label, existing_loan_balance, requested_amount, estimated_equity, financing_option_estimate, max_term_months, loan_routes, loan_routes_text, estimate_basis, requested_exceeds_estimate, submitted_at, submitted_at_il, consent, consent_text, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, landing_page, referrer, source`
השרת מחשב מחדש את `estimated_equity` (שווי פחות יתרה, ולא פחות מ-0) ולא סומך על הערך שמגיע מהדפדפן. אפשר להשתמש ב-`lead_id` כמפתח למניעת כפילויות ב-monday.

## לפני עלייה לאוויר
* להחליף את Tailwind CDN ב-CSS מקומפל: האתר כבר בנוי ב-Astro, ואפשר להוסיף `@astrojs/tailwind` או להריץ Tailwind CLI. CDN מתאים לאב-טיפוס, אבל מוסיף כ-100KB ומציג אזהרה בקונסול.
* בקמפיין להפנות אל `https://zebra-finance.co.il/check/?utm_source=...`

## כתובות לכל שלב (למעקב במטא)
לכל מסך יש כתובת משלו, ופרמטרי ה-UTM נשמרים בכל אחת מהן:

| כתובת | המסך |
|---|---|
| `/check/` | מסך הפתיחה |
| `/check/year` | שנת הרכב |
| `/check/value` | שווי הרכב |
| `/check/lien` | מצב השעבוד |
| `/check/amount` | סכום המימון |
| `/check/details` | השארת פרטים |
| `/check/offer` | מסך ההצעות. מגיעים אליו רק אחרי שהליד נשמר בהצלחה |

* בכל מעבר מסך נשלח PageView אחד, מה-Pixel ומ-CAPI עם אותו `event_id`. המעקב האוטומטי של ה-Pixel אחרי שינויי כתובת כבוי, כדי שלא ייווצרו כפילויות.
* מי שנכנס ישירות לכתובת של שלב בלי לעבור את השלבים הקודמים מוחזר ל-`/check/`.
* בהדגמה ב-claude.ai הכתובות מוצגות כ-`#year`, `#details` וכן הלאה, כי שם אין אפשרות להשתמש בנתיבים אמיתיים.

### קהלים מומלצים ב-Meta (Custom Audiences → Website)
* **נטשו בעמוד הראשון:** ביקרו בכתובת שמכילה `/check`, **ולא** ביקרו בכתובת שמכילה `/check/year`.
* **נטשו בשלב הפרטים:** ביקרו בכתובת שמכילה `/check/details`, **ולא** ביקרו בכתובת שמכילה `/check/offer`.
* **לידים:** ביקרו בכתובת שמכילה `/check/offer`. אפשר גם להשתמש באירוע `Lead`, שנספר בדיוק באותו רגע.

### המרות מותאמות (Custom Conversions)
URL contains `/check/details` → "הגיע לפרטים". URL contains `/check/offer` → "ליד".
