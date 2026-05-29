// Shared helper for FYPN[1-4] + FYPVIP short-link redirects.
// Logs one Analytics Engine datapoint per click then 302s to the Zoom URL.
//
// Why the AE write is wrapped in try/catch: SMS short links are mission-critical
// during launch week. If AE write fails (binding missing, ingestion throttled,
// transient outage), the user MUST still get to Zoom. Logging is best-effort.
//
// blob1 = event label ("sms_click_n1", "sms_click_n2", ...) — co-exists with
// the LP A/B "v1"/"v2" labels in the same dataset (different label namespace,
// dashboard queries filter by exact match so no collision).

export function logAndRedirect(context, label, zoomUrl) {
  const { env, request } = context;
  try {
    env.AB_ANALYTICS?.writeDataPoint({
      blobs: [label],
      doubles: [1],
      indexes: [label],
    });
  } catch (_) { /* non-fatal — never block the redirect */ }

  // Pass through any tracking query string (e.g. ?c=<contact_id> if added later)
  // by appending it onto the Zoom URL. Zoom ignores unknown params.
  const incomingQs = new URL(request.url).search;
  const target = incomingQs ? `${zoomUrl}${zoomUrl.includes("?") ? "&" : "?"}${incomingQs.slice(1)}` : zoomUrl;

  return Response.redirect(target, 302);
}

// Static Zoom URLs — single recurring meeting (Meeting ID 985 247 6403) with
// per-event omn query param (Zoom uses this to bucket "session ID" inside
// the recurring room). Confirmed by JJ 2026-05-22.
export const ZOOM_FYP = "https://us02web.zoom.us/j/9852476403?pwd=Vc8ePcE59HBd75MAmVa58jg5GSQPte.1&omn=84007480572";
export const ZOOM_VIP = "https://us02web.zoom.us/j/9852476403?pwd=Vc8ePcE59HBd75MAmVa58jg5GSQPte.1&omn=89437962456";
