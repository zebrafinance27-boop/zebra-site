// POST /api/submit-lead
// Validates the car-equity check, forwards it to the lead webhook (Zebra's own automation agent → monday.com),
// then — only after the webhook accepted it — reports a deduplicated `Lead` to Meta CAPI.
// Receiver contract: see LEAD-WEBHOOK-SPEC.md
//
// Env vars (Netlify → Site configuration → Environment variables):
//   LEAD_WEBHOOK_URL      required  receiver URL (never exposed to the browser). No Make fallback, on purpose.
//   WEBHOOK_SECRET        recommended  shared secret; sent as X-Zebra-Token + X-Zebra-Signature (HMAC-SHA256 of body)
//   ALLOWED_ORIGINS       recommended  e.g. https://zebra-finance.co.il,https://www.zebra-finance.co.il
//   META_PIXEL_ID / META_CAPI_TOKEN / META_TEST_EVENT_CODE (optional)
import { env, json, checkOrigin, hmac, sendCapi } from "../lib/shared.mjs";

const LIEN = { free: "הרכב בבעלותי וללא שעבוד", loan: "קיימת הלוואה או שעבוד על הרכב", unsure: "לא בטוח/ה" };
const MIN_YEAR = 2011;
// Max monthly payments by vehicle year — keep in sync with TERM_BY_YEAR in public/check/index.html
const TERM_BY_YEAR = { 2011: 12, 2012: 24, 2013: 24, 2014: 36, 2015: 36, 2016: 36, 2017: 48, 2018: 48, 2019: 60, 2020: 60, 2021: 72, 2022: 84 };
const maxTerm = (y) => (y >= 2023 ? 100 : TERM_BY_YEAR[y] || null);
// Example loan routes shown to the customer (rate used for the illustration only) — keep in sync with loanRoutes() in index.html
const ROUTE_RATE = 0.095;
const monthlyPayment = (principal, n) => { const r = ROUTE_RATE / 12; return (principal * r) / (1 - Math.pow(1 + r, -n)); };
// Up to 3 routes: low monthly (max term) · balanced · short — keep in sync with routeTerms() in index.html
const STD_TERMS = [84, 72, 60, 48, 36, 24, 12];
function routeTerms(max) {
  if (!max) return [];
  const lower = STD_TERMS.filter((t) => t < max);
  const bal = max > 60 ? 60 : lower[0];
  const sh = bal > 36 ? 36 : lower.filter((t) => t < bal)[0];
  return [max, bal, sh].filter(Boolean);
}
const loanRoutes = (amount, max) => (!amount || !max ? [] : routeTerms(max).map((term) => ({ term, monthly: Math.round(monthlyPayment(amount, term)) })));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Email typo detection — keep in sync with emailSuggestion() in public/check/index.html
const MAIL_PROVIDERS = { gmail: "gmail.com", walla: "walla.co.il", hotmail: "hotmail.com", yahoo: "yahoo.com", outlook: "outlook.com", icloud: "icloud.com" };
const MAIL_VALID = new Set(["gmail.com", "googlemail.com", "walla.co.il", "walla.com", "hotmail.com", "hotmail.co.il", "yahoo.com", "yahoo.co.il",
  "outlook.com", "outlook.co.il", "icloud.com", "me.com", "live.com", "msn.com", "mail.com", "gmx.com", "aol.com", "protonmail.com", "proton.me",
  "netvision.net.il", "bezeqint.net", "012.net.il", "zahav.net.il", "inter.net.il", "smile.net.il", "hot.net.il", "013net.net"]);
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
function emailLooksMistyped(email) {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (!domain || MAIL_VALID.has(domain)) return false;
  const name = domain.split(".")[0];
  return Object.keys(MAIL_PROVIDERS).some((p) => name === p || (name.length >= 2 && p.startsWith(name)) || (name.length >= 4 && lev(name, p) <= 1));
}

const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const money = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(+v) && +v >= 0 && +v <= 10_000_000 ? Math.round(+v) : NaN);

function ref(leadId) {
  return "ZB-" + leadId.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase();
}

export default async (req) => {
  const { ok: originOk, origin } = checkOrigin(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" } });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" }, origin);
  if (!originOk) return json(403, { ok: false, error: "forbidden_origin" });

  const raw = await req.text();
  if (raw.length > 8000) return json(413, { ok: false, error: "too_large" }, origin);
  let b; try { b = JSON.parse(raw); } catch { return json(400, { ok: false, error: "bad_json" }, origin); }

  const leadId = str(b.lead_id, 64);
  // Honeypot: bots fill the hidden "company" field. Pretend success, forward nothing.
  if (str(b.company)) return json(200, { ok: true, ref: ref(leadId || "000000") }, origin);

  // ---- validation (server is the source of truth) ----
  const errors = [];
  const fullName = str(b.full_name, 80);
  const email = str(b.email, 100).toLowerCase();
  const phone = String(b.phone || "").replace(/\D/g, "");
  const yearNum = Number(b.vehicle_year);
  const year = Number.isInteger(yearNum) && yearNum >= MIN_YEAR && yearNum <= new Date().getFullYear() + 1 ? String(yearNum) : "";
  const lien = LIEN[b.lien_status] ? b.lien_status : "";
  const value = money(b.vehicle_value);
  const balance = lien === "loan" ? money(b.existing_loan_balance) : null;
  const amount = money(b.requested_amount);

  if (!/^[\w-]{8,64}$/.test(leadId)) errors.push("lead_id");
  if (fullName.length < 2) errors.push("full_name");
  if (!EMAIL_RE.test(email) || emailLooksMistyped(email)) errors.push("email");
  if (!/^05\d{8}$/.test(phone)) errors.push("phone");
  if (!year) errors.push("vehicle_year");
  if (!lien) errors.push("lien_status");
  if (value == null || Number.isNaN(value) || Number.isNaN(balance) || amount === null || Number.isNaN(amount)) errors.push("amounts");
  else if (amount > value) errors.push("requested_amount_exceeds_vehicle_value");
  if (b.consent !== true) errors.push("consent");
  if (errors.length) return json(422, { ok: false, error: "validation", fields: errors }, origin);

  // Recompute the estimate server-side — never trust the browser's number.
  let equity = null, basis = "incomplete";
  if (lien === "free") { equity = value; basis = "no_lien"; }
  else if (lien === "unsure") { equity = value; basis = "assumes_no_lien"; }
  else if (balance == null) basis = "balance_unknown";
  else { equity = Math.max(0, value - balance); basis = "value_minus_balance"; }

  const now = new Date();
  const lead = {
    lead_id: leadId,
    reference: ref(leadId),
    full_name: fullName,
    email,
    phone,
    vehicle_year: year,
    vehicle_value: value,
    lien_status: lien,
    lien_status_label: LIEN[lien],
    existing_loan_balance: balance,
    requested_amount: amount,
    estimated_equity: equity,
    financing_option_estimate: equity != null ? Math.min(amount, equity) : amount,
    max_term_months: maxTerm(Number(year)),
    loan_routes: loanRoutes(amount, maxTerm(Number(year))),
    loan_routes_text: loanRoutes(amount, maxTerm(Number(year))).map((r, i) => `מסלול ${i + 1}: ${r.term} תשלומים, החזר חודשי משוער ₪${r.monthly.toLocaleString("he-IL")}`).join(" | "),
    estimate_basis: basis,
    requested_exceeds_estimate: equity != null ? amount > equity : null,
    submitted_at: now.toISOString(),
    submitted_at_il: now.toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" }),
    consent: true,
    consent_text: str(b.consent_text, 300),
    utm_source: str(b.utm_source), utm_medium: str(b.utm_medium), utm_campaign: str(b.utm_campaign),
    utm_content: str(b.utm_content), utm_term: str(b.utm_term), fbclid: str(b.fbclid, 300),
    landing_page: str(b.landing_page, 500), referrer: str(b.referrer, 500),
    source: "car_equity_check",
  };

  // ---- forward to the lead webhook (→ monday) ----
  // Only Zebra's own lead server — never Make (a second receiver would create a duplicate monday item).
  const hook = env("LEAD_WEBHOOK_URL");
  if (!hook) { console.error("LEAD_WEBHOOK_URL not set"); return json(503, { ok: false, error: "not_configured" }, origin); }
  const body = JSON.stringify(lead);
  const secret = env("WEBHOOK_SECRET");
  const headers = { "Content-Type": "application/json", "Idempotency-Key": leadId };
  if (secret) { headers["X-Zebra-Token"] = secret; headers["X-Zebra-Signature"] = hmac(secret, body); }

  let forwarded = false;
  for (let attempt = 0; attempt < 2 && !forwarded; attempt++) {
    try {
      const r = await fetch(hook, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
      forwarded = r.ok;
      if (!r.ok) console.error("Lead webhook responded", r.status);
    } catch (e) { console.error("Lead webhook request failed", e?.message); }
  }
  if (!forwarded) return json(502, { ok: false, error: "upstream" }, origin);

  // ---- Meta CAPI Lead (only after the lead is safely stored). No financial data. ----
  const meta = b.meta || {};
  const [firstName, ...rest] = fullName.split(/\s+/);
  try {
    await sendCapi({
      eventName: "Lead",
      eventId: str(meta.event_id, 100) || "lead-" + leadId,
      eventSourceUrl: str(meta.event_source_url, 500) || lead.landing_page,
      req, fbp: str(meta.fbp, 200), fbc: str(meta.fbc, 400),
      user: { phone, email, firstName, lastName: rest.join(" "), externalId: leadId },
    });
  } catch (e) { console.error("CAPI Lead failed", e?.message); }

  return json(200, { ok: true, ref: lead.reference }, origin);
};
