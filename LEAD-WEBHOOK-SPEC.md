# Lead webhook: integration spec for Zebra's automation agent

> **בעברית, בקצרה:** דף "בדיקת מימון כנגד רכב" (`zebra-finance.co.il/check`) שולח כל ליד בבקשת POST אחת לכתובת שהסוכן יחשוף.
> הסוכן צריך: (1) לאמת את החתימה, (2) לשמור את הליד ב-monday פעם אחת בלבד לפי `lead_id`, (3) להחזיר 200 תוך פחות מ-8 שניות.
> כתובת הסוכן נכנסת ב-Netlify למשתנה `LEAD_WEBHOOK_URL`, ואותה מחרוזת סודית נכנסת גם ל-`WEBHOOK_SECRET` וגם להגדרות הסוכן.

---

## 1. What the agent must expose

| | |
|---|---|
| Method | `POST` |
| URL | Any HTTPS URL on the agent's server, e.g. `https://<agent-host>/webhooks/zebra-check-lead`. Treat it as a secret. |
| Body | `application/json`, UTF-8 (Hebrew text included), max ~8 KB |
| Caller | Netlify Function `netlify/functions/submit-lead.mjs` on zebra-finance.co.il (server-to-server, never the browser) |

## 2. Request headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Idempotency-Key` | same as `lead_id` in the body |
| `X-Zebra-Token` | the shared secret (`WEBHOOK_SECRET`) in plain text |
| `X-Zebra-Signature` | lowercase hex `HMAC-SHA256(WEBHOOK_SECRET, raw_request_body)` |

**Verify before doing anything else.** Compute the HMAC over the **raw body bytes exactly as received** (before JSON parsing) and compare it to `X-Zebra-Signature` using a constant-time comparison. Reject with `401` on mismatch. Checking `X-Zebra-Token` alone is acceptable, but the signature check is stronger.

## 3. Response contract

| Situation | Respond |
|---|---|
| Stored (or already stored earlier) | `200`, any body, e.g. `{"ok":true}` |
| Bad signature | `401` |
| Malformed body | `400` |
| Temporary failure (monday down etc.) | `5xx` |

* **Respond within 8 seconds.** The sender aborts after 8 s and retries **once**. If both attempts fail, the customer sees an error screen (with a WhatsApp fallback) and **no `Lead` event is sent to Meta**.
* Recommended: verify, persist the raw lead to your own store/queue, return `200` immediately, then create the monday item asynchronously.
* **Idempotency:** because of the retry, the same `lead_id` can arrive twice. Create the monday item only once per `lead_id` (keep a processed-IDs table or search monday by a `lead_id` column first). The second delivery must still return `200`.

## 4. Payload

All fields are always present. `null` means "not applicable / unknown". Amounts are integers in ILS (₪).

```json
{
  "lead_id": "1d4b5ce0-9d52-46ff-addd-e1f51de7400c",
  "reference": "ZB-E7400C",
  "full_name": "דנה כהן",
  "email": "dana@gmail.com",
  "phone": "0521234567",
  "vehicle_year": "2020",
  "vehicle_value": 50000,
  "lien_status": "free",
  "lien_status_label": "הרכב בבעלותי וללא שעבוד",
  "existing_loan_balance": null,
  "requested_amount": 50000,
  "estimated_equity": 50000,
  "financing_option_estimate": 50000,
  "max_term_months": 60,
  "loan_routes": [
    { "term": 60, "monthly": 1050 },
    { "term": 36, "monthly": 1602 }
  ],
  "loan_routes_text": "מסלול 1: 60 תשלומים, החזר חודשי משוער ₪1,050 | מסלול 2: 36 תשלומים, החזר חודשי משוער ₪1,602",
  "estimate_basis": "no_lien",
  "requested_exceeds_estimate": false,
  "submitted_at": "2026-11-19T07:30:00.000Z",
  "submitted_at_il": "19.11.2026, 9:30:00",
  "consent": true,
  "consent_text": "אישור העברת פרטים לצורך בדיקת הבקשה ויצירת קשר, בהתאם למדיניות הפרטיות",
  "utm_source": "facebook",
  "utm_medium": "paid",
  "utm_campaign": "car-equity",
  "utm_content": "video-a",
  "utm_term": "",
  "fbclid": "IwAR...",
  "landing_page": "https://zebra-finance.co.il/check/",
  "referrer": "",
  "source": "car_equity_check"
}
```

### Field reference

| Field | Type | Notes |
|---|---|---|
| `lead_id` | string (UUID) | Unique per lead. **Use as the dedup key.** |
| `reference` | string | Short ref shown to the customer on screen (`ZB-XXXXXX`). Agents should quote it when talking to the customer. |
| `full_name` | string | Hebrew or Latin |
| `email` | string | Lowercased; typo-checked (e.g. `gm.com` is rejected upstream) |
| `phone` | string | Israeli mobile, 10 digits, starts with `05`. For WhatsApp/E.164: `972` + digits without the leading `0`. |
| `vehicle_year` | string | `"2011"`…current year |
| `vehicle_value` | integer | Customer's own estimate |
| `lien_status` | `free` \| `loan` \| `unsure` | `lien_status_label` is the Hebrew text the customer saw |
| `existing_loan_balance` | integer \| null | Only when `lien_status = loan`; `null` if the customer chose "don't know" |
| `requested_amount` | integer | Capped at `vehicle_value` |
| `estimated_equity` | integer \| null | `vehicle_value − existing_loan_balance` (min 0). `null` when the balance is unknown. Recomputed server-side. |
| `estimate_basis` | string | `no_lien` · `assumes_no_lien` (customer unsure) · `value_minus_balance` · `balance_unknown` |
| `financing_option_estimate` | integer | `min(requested_amount, estimated_equity)`, or `requested_amount` when equity is unknown |
| `requested_exceeds_estimate` | boolean \| null | `true` means the customer asked for more than the estimated free equity. Worth flagging for the rep. |
| `max_term_months` | integer | Max number of payments by vehicle year (2023+: 100, 2022: 84, 2021: 72, 2019–20: 60, 2017–18: 48, 2014–16: 36, 2012–13: 24, 2011: 12) |
| `loan_routes` | array | The 1–2 example routes shown to the customer: `term` (payments) and `monthly` (₪, illustrative) |
| `loan_routes_text` | string | Same routes as one Hebrew line, ready for a monday text column |
| `submitted_at` / `submitted_at_il` | string | ISO UTC / Israel local time |
| `consent` | `true` | Always true (the form can't be sent without it). `consent_text` is the wording the customer approved. |
| `utm_*`, `fbclid` | string | Campaign attribution, `""` when absent |
| `landing_page`, `referrer` | string | |
| `source` | `"car_equity_check"` | Distinguishes this funnel from the site's older contact form |

> The monthly amounts are illustrative only and were shown to the customer as such; they are not an approval or an offer. Reps should present final terms only after a lender approves.

## 5. Suggested monday.com columns

| Column | From |
|---|---|
| Name (item name) | `full_name` |
| Phone | `phone` (country IL) |
| Email | `email` |
| Lead ID (text, used for dedup) | `lead_id` |
| Reference | `reference` |
| Car year | `vehicle_year` |
| Car value (₪) | `vehicle_value` |
| Lien (status) | `lien_status_label` |
| Existing loan balance (₪) | `existing_loan_balance` |
| Requested (₪) | `requested_amount` |
| Free equity estimate (₪) | `estimated_equity` |
| Asked more than equity (checkbox) | `requested_exceeds_estimate` |
| Max payments | `max_term_months` |
| Routes shown | `loan_routes_text` |
| Submitted | `submitted_at` |
| UTM source / medium / campaign / content / term | `utm_*` |
| FBCLID | `fbclid` |
| Source | `source` |

## 6. Testing the endpoint

**Signature check in Node.js (Express, raw body):**

```js
import crypto from "node:crypto";
app.post("/webhooks/zebra-check-lead", express.raw({ type: "application/json" }), (req, res) => {
  const expected = crypto.createHmac("sha256", process.env.WEBHOOK_SECRET).update(req.body).digest("hex");
  const got = String(req.get("X-Zebra-Signature") || "");
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    return res.status(401).end();
  }
  const lead = JSON.parse(req.body.toString("utf8"));
  // persist / enqueue by lead.lead_id, then:
  res.json({ ok: true });
});
```

**Signature check in Python (FastAPI):**

```python
import hmac, hashlib, json, os
from fastapi import Request, HTTPException

@app.post("/webhooks/zebra-check-lead")
async def zebra_lead(request: Request):
    raw = await request.body()
    expected = hmac.new(os.environ["WEBHOOK_SECRET"].encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, request.headers.get("X-Zebra-Signature", "")):
        raise HTTPException(401)
    lead = json.loads(raw)
    # persist / enqueue by lead["lead_id"], then:
    return {"ok": True}
```

**Send a signed test lead from a terminal** (replace the URL and secret; uses `openssl`):

```bash
URL='https://<agent-host>/webhooks/zebra-check-lead'
SECRET='<the WEBHOOK_SECRET>'
BODY='{"lead_id":"test-0001-0001","reference":"ZB-TEST01","full_name":"בדיקה בדיקה","email":"test@gmail.com","phone":"0500000000","vehicle_year":"2020","vehicle_value":50000,"lien_status":"free","lien_status_label":"הרכב בבעלותי וללא שעבוד","existing_loan_balance":null,"requested_amount":50000,"estimated_equity":50000,"financing_option_estimate":50000,"max_term_months":60,"loan_routes":[{"term":60,"monthly":1050},{"term":36,"monthly":1602}],"loan_routes_text":"מסלול 1: 60 תשלומים, החזר חודשי משוער ₪1,050 | מסלול 2: 36 תשלומים, החזר חודשי משוער ₪1,602","estimate_basis":"no_lien","requested_exceeds_estimate":false,"submitted_at":"2026-11-19T07:30:00.000Z","submitted_at_il":"19.11.2026, 9:30:00","consent":true,"consent_text":"test","utm_source":"","utm_medium":"","utm_campaign":"","utm_content":"","utm_term":"","fbclid":"","landing_page":"https://zebra-finance.co.il/check/","referrer":"","source":"car_equity_check"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //')
curl -sS -X POST "$URL" -H 'Content-Type: application/json' -H "Idempotency-Key: test-0001-0001" \
  -H "X-Zebra-Token: $SECRET" -H "X-Zebra-Signature: $SIG" --data-binary "$BODY" -w '\nHTTP %{http_code}\n'
```

Expected: `HTTP 200`, and a monday item named "בדיקה בדיקה". Sending the exact same command again must return `200` **without** creating a second item. Delete the test item afterwards.

## 7. Wiring it up (Netlify, done by the site owner)

1. Netlify → project `enchanting-bienenstitch-363450` → Project configuration → Environment variables:
   * `LEAD_WEBHOOK_URL` = the agent's URL (mark **Contains secret values**, Production)
   * `WEBHOOK_SECRET` = a long random string, the **same** value configured on the agent (mark secret, Production)
2. Deploy the site. Until `LEAD_WEBHOOK_URL` is set, the funnel answers `503 not_configured` and the customer sees the error screen.
