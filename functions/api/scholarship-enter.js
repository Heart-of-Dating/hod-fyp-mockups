// POST /api/scholarship-enter
// Body: { name: string, codeWords: [4 strings] }
// Validates all 4 code words match (case-insensitive), then writes entry to KV.
// Unique key per entry so 2K concurrent submissions don't race.

const REQUIRED = ["CROISSANT", "BONJOUR", "ESCARGOT", "BERET"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type"
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS }
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  if (!env.SCHOLARSHIP) return json({ ok: false, error: "KV not bound" }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }

  const name = String(body.name || "").trim().slice(0, 80);
  const words = Array.isArray(body.codeWords) ? body.codeWords.map(w => String(w || "").trim().toUpperCase()) : [];

  if (!name) return json({ ok: false, error: "name required" }, 400);
  if (words.length !== 4) return json({ ok: false, error: "need 4 code words" }, 400);

  const wrong = REQUIRED.filter((req, i) => words[i] !== req);
  if (wrong.length) {
    return json({
      ok: false,
      error: "one or more code words incorrect",
      hint: "double-check your spelling (hint: french food + accessory)"
    }, 422);
  }

  // Unique key prevents race on concurrent writes
  const ts = Date.now();
  const nano = Math.random().toString(36).slice(2, 8);
  const key = `schol:${ts}-${nano}`;

  await env.SCHOLARSHIP.put(key, JSON.stringify({
    name,
    enteredAt: new Date(ts).toISOString()
  }), {
    // 7-day TTL — auto-cleanup after the event
    expirationTtl: 60 * 60 * 24 * 7
  });

  return json({ ok: true, key, message: "You're in the pool! 🎉" });
}
