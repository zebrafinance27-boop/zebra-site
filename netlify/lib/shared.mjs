// Shared helpers for the car-equity check functions.
// All secrets come from Netlify environment variables — never from the frontend.
import { createHash, createHmac } from "node:crypto";

export const env = (k, d = "") => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? d);

export function json(status, body, origin) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (origin) { headers["Access-Control-Allow-Origin"] = origin; headers["Vary"] = "Origin"; }
  return new Response(JSON.stringify(body), { status, headers });
}

// Only accept calls from our own site(s). ALLOWED_ORIGINS="https://zebra-finance.co.il,https://www.zebra-finance.co.il"
export function checkOrigin(req) {
  const allowed = env("ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") || "";
  if (!allowed.length) return { ok: true, origin: "" };          // not configured → same-origin only in practice
  return { ok: allowed.includes(origin), origin: allowed.includes(origin) ? origin : "" };
}

export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
export const hmac = (secret, body) => createHmac("sha256", secret).update(body).digest("hex");

export const clientIp = (req) =>
  req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || undefined;

// Israeli mobile 05XXXXXXXX → E.164 digits 9725XXXXXXXX (Meta normalisation)
export const phoneE164 = (p) => (/^05\d{8}$/.test(p) ? "972" + p.slice(1) : p);

/**
 * Send one event to Meta Conversions API.
 * Only identity/context fields are sent (hashed) — NEVER amounts, lien status or loan data.
 */
export async function sendCapi({ eventName, eventId, eventSourceUrl, req, fbp, fbc, user = {}, contentName = "car_equity_check" }) {
  const pixel = env("META_PIXEL_ID"), token = env("META_CAPI_TOKEN");
  if (!pixel || !token) return { skipped: true };
  const user_data = {
    client_ip_address: clientIp(req),
    client_user_agent: req.headers.get("user-agent") || undefined,
    fbp: fbp || undefined,
    fbc: fbc || undefined,
  };
  if (user.phone) user_data.ph = [sha256(phoneE164(user.phone))];
  if (user.email) user_data.em = [sha256(user.email.trim().toLowerCase())];
  if (user.firstName) user_data.fn = [sha256(user.firstName.toLowerCase())];
  if (user.lastName) user_data.ln = [sha256(user.lastName.toLowerCase())];
  if (user.externalId) user_data.external_id = [sha256(user.externalId)];
  user_data.country = [sha256("il")];

  const body = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,                 // same id as the browser Pixel → Meta deduplicates
      action_source: "website",
      event_source_url: eventSourceUrl,
      user_data,
      custom_data: { content_name: contentName },
    }],
  };
  const testCode = env("META_TEST_EVENT_CODE");
  if (testCode) body.test_event_code = testCode;

  const ver = env("META_GRAPH_VERSION", "v21.0");
  const res = await fetch(`https://graph.facebook.com/${ver}/${pixel}/events?access_token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) console.error("CAPI error", res.status, await res.text().catch(() => ""));
  return { ok: res.ok };
}
