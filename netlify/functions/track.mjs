// POST /api/track — mirrors browser Pixel funnel events to Meta CAPI with the same event_id (dedup).
// Accepts only whitelisted event names and carries no form data at all.
import { json, checkOrigin, sendCapi } from "../lib/shared.mjs";

const ALLOWED = new Set(["PageView", "StartApplication", "VehicleDetailsCompleted", "FinancingDetailsCompleted"]);
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

export default async (req) => {
  const { ok, origin } = checkOrigin(req);
  if (req.method !== "POST") return json(405, { ok: false }, origin);
  if (!ok) return json(403, { ok: false });
  const raw = await req.text();
  if (raw.length > 2000) return json(413, { ok: false }, origin);
  let b; try { b = JSON.parse(raw); } catch { return json(400, { ok: false }, origin); }
  if (!ALLOWED.has(b.event_name) || !str(b.event_id, 100)) return json(400, { ok: false }, origin);
  try {
    await sendCapi({
      eventName: b.event_name, eventId: str(b.event_id, 100), eventSourceUrl: str(b.event_source_url, 500),
      req, fbp: str(b.fbp, 200), fbc: str(b.fbc, 400),
    });
  } catch (e) { console.error("CAPI track failed", e?.message); }
  return json(200, { ok: true }, origin);
};
