// POST /api/submit-property-lead
// Lead from the property-loan simulator (src/components/PropertySim.astro, page /loans/neged-nechas/).
// Same flow as submit-lead.mjs: validate → forward to the lead server (LEAD_WEBHOOK_URL, signed) → CAPI Lead.
// Simulation assumptions — keep in sync with PropertySim.astro: cap 85% of value incl. existing mortgage,
// assumed rate 4.8%, term 10–40 years, loan ₪200K–₪10M.
import { env, json, checkOrigin, hmac, sendCapi } from "../lib/shared.mjs";

const CAP = 0.85, RATE = 0.048, MIN_LOAN = 200_000, MAX_LOAN = 10_000_000, MIN_VALUE = 300_000, MAX_VALUE = 30_000_000;
const ROUTE_YEARS = [40, 25, 15];
const monthly = (P, years) => { const r = RATE / 12, n = years * 12; return Math.round((P * r) / (1 - Math.pow(1 + r, -n))); };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v) => (Number.isFinite(+v) ? Math.round(+v) : NaN);
const ref = (id) => "ZB-" + id.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase();
const ils = (n) => "₪" + n.toLocaleString("he-IL");

export default async (req) => {
  const { ok: originOk, origin } = checkOrigin(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" } });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" }, origin);
  if (!originOk) return json(403, { ok: false, error: "forbidden_origin" });

  const raw = await req.text();
  if (raw.length > 8000) return json(413, { ok: false, error: "too_large" }, origin);
  let b; try { b = JSON.parse(raw); } catch { return json(400, { ok: false, error: "bad_json" }, origin); }

  const leadId = str(b.lead_id, 64);
  if (str(b.company)) return json(200, { ok: true, ref: ref(leadId || "000000") }, origin);   // honeypot

  const fullName = str(b.full_name, 80);
  const email = str(b.email, 100).toLowerCase();
  const phone = String(b.phone || "").replace(/\D/g, "");
  const value = num(b.property_value), mortgage = num(b.existing_mortgage), amount = num(b.requested_amount), years = num(b.term_years);

  const errors = [];
  if (!/^[\w-]{8,64}$/.test(leadId)) errors.push("lead_id");
  if (fullName.length < 2) errors.push("full_name");
  if (!EMAIL_RE.test(email)) errors.push("email");
  if (!/^05\d{8}$/.test(phone)) errors.push("phone");
  if (!(value >= MIN_VALUE && value <= MAX_VALUE)) errors.push("property_value");
  if (!(mortgage >= 0 && mortgage <= value)) errors.push("existing_mortgage");
  if (!(amount >= MIN_LOAN && amount <= MAX_LOAN)) errors.push("requested_amount");
  if (!(years >= 10 && years <= 40)) errors.push("term_years");
  if (b.consent !== true) errors.push("consent");
  if (errors.length) return json(422, { ok: false, error: "validation", fields: errors }, origin);

  // recompute server-side — never trust the browser's numbers
  const equity = Math.max(0, value - mortgage);
  const maxLoan = Math.max(0, Math.min(MAX_LOAN, Math.round(CAP * value - mortgage)));
  const ltv = Math.round(((mortgage + amount) / value) * 1000) / 10;   // %
  const pay = monthly(amount, years);
  const routes = ROUTE_YEARS.map((y) => ({ years: y, monthly: monthly(amount, y) }));
  const now = new Date();

  const lead = {
    lead_id: leadId,
    reference: ref(leadId),
    source: "property_check",
    source_label: "סימולטור הלוואה כנגד נכס (אתר)",
    full_name: fullName,
    email,
    phone,
    property_value: value,
    existing_mortgage: mortgage,
    estimated_equity: equity,
    requested_amount: amount,
    max_loan_estimate: maxLoan,
    total_ltv_percent: ltv,
    requested_exceeds_estimate: amount > maxLoan,
    term_years: years,
    term_months: years * 12,
    monthly_estimate: pay,
    loan_routes: routes,
    loan_routes_text: routes.map((r) => `${r.years} שנה: החזר חודשי משוער ${ils(r.monthly)}`).join(" | "),
    simulation_basis: `סימולציה: ריבית שנתית ${RATE * 100}% (שפיצר), תקרה ${CAP * 100}% משווי הנכס כולל משכנתא קיימת`,
    submitted_at: now.toISOString(),
    submitted_at_il: now.toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" }),
    consent: true,
    consent_text: str(b.consent_text, 300),
    utm_source: str(b.utm_source), utm_medium: str(b.utm_medium), utm_campaign: str(b.utm_campaign),
    utm_content: str(b.utm_content), utm_term: str(b.utm_term), fbclid: str(b.fbclid, 300),
    landing_page: str(b.landing_page, 500), referrer: str(b.referrer, 500),
  };

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

  // Meta CAPI Lead — identity/context only, no financial data
  const meta = b.meta || {};
  const [firstName, ...rest] = fullName.split(/\s+/);
  try {
    await sendCapi({
      eventName: "Lead", eventId: str(meta.event_id, 100) || "lead-" + leadId,
      eventSourceUrl: str(meta.event_source_url, 500) || lead.landing_page,
      req, fbp: str(meta.fbp, 200), fbc: str(meta.fbc, 400),
      user: { phone, email, firstName, lastName: rest.join(" "), externalId: leadId },
      contentName: "property_check",
    });
  } catch (e) { console.error("CAPI Lead failed", e?.message); }

  return json(200, { ok: true, ref: lead.reference }, origin);
};
