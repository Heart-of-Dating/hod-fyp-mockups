// GET /api/scholarship-list
// Returns { ok: true, count: N, entries: [{name, enteredAt}, ...] }
// Polled by /n4-slides slide 32 every 3s to drive live count + scroll stream.

export async function onRequest({ env }) {
  if (!env.SCHOLARSHIP) {
    return json({ ok: false, error: "KV not bound" }, 500);
  }

  // List up to 1000 keys with prefix schol: (plenty for tonight's 2K attendees,
  // most won't enter and we only need to show recent + total)
  const list = await env.SCHOLARSHIP.list({ prefix: "schol:", limit: 1000 });

  // Batch read values
  const entries = await Promise.all(
    list.keys.map(async k => {
      try {
        const v = await env.SCHOLARSHIP.get(k.name);
        if (!v) return null;
        const parsed = JSON.parse(v);
        return { name: parsed.name, enteredAt: parsed.enteredAt };
      } catch { return null; }
    })
  );

  const valid = entries.filter(Boolean).sort((a, b) => (b.enteredAt || "").localeCompare(a.enteredAt || ""));

  return json({
    ok: true,
    count: valid.length,
    entries: valid,
    fetchedAt: new Date().toISOString()
  }, 200, {
    // Edge cache 2s so 2K viewers don't hammer KV
    "cache-control": "public, max-age=2"
  });
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extra
    }
  });
}
