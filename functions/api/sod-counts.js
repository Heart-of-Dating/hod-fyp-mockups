// Live SOD signup tracker — reads AC tag counts + recent signups.
// Polled by /sod/ page every ~8s. Edge cached 5s so 1K simultaneous viewers
// don't hammer AC.

const AC_URL = "https://kaitness.api-us1.com/api/3";
const TAG_SOD = 193;       // "School of Dating June 26" — STRICT cohort tag
const TAG_SOD_PRO = 194;   // "SOD PRO June 26"
const CAP_TOTAL = 200;

// Tonight's FAB (N4) = the LAST 72 SEATS in the cohort. Anyone who fills seats
// 129-200 gets tonight's two bonuses (Profile Diagnostic + Texting Scripts).
const CAP_FAB = 72;
const FAB_BASELINE = CAP_TOTAL - CAP_FAB; // = 128 → fabTaken = max(0, total - 128)

// Pre-event baseline (24 contacts had SOD tag before FYP funnel went live N1).
// Used for the "X new in last 24h" intro slide on N4.
const PRE_EXISTING = 24;

// Cart closes Fri 5/29 9 PM CT = 2026-05-30T02:00:00Z
const CART_CLOSE_UTC = "2026-05-30T02:00:00Z";

export async function onRequest({ env }) {
  const KEY = env.AC_API_KEY;
  if (!KEY) {
    return json({ error: "AC_API_KEY not set" }, 500);
  }

  async function ac(path) {
    const r = await fetch(`${AC_URL}${path}`, {
      headers: { "Api-Token": KEY },
      cf: { cacheTtl: 5 }
    });
    if (!r.ok) throw new Error(`AC ${r.status} on ${path}`);
    return r.json();
  }

  try {
    // 1. Total SOD signups
    const sodMeta = await ac(`/contacts?tagid=${TAG_SOD}&limit=1`);
    const sodTotal = parseInt(sodMeta.meta?.total || 0);

    // 2. SOD Pro signups
    const proMeta = await ac(`/contacts?tagid=${TAG_SOD_PRO}&limit=1`);
    const proTotal = parseInt(proMeta.meta?.total || 0);

    // 3. Welcome stream — STRICT SOD-tagged contacts only.
    // IMPORTANT: AC's /contactTags?filters[tag]=X is BROKEN (returns all tags).
    // Workaround: /contacts?tagid=X is properly filtered — gives us only contacts
    // who actually have tag 193. Sorted by contact-creation date so newest SOD
    // buyers appear first. No VIP-only leaks.
    const ctRes = await ac(
      `/contacts?tagid=${TAG_SOD}&orders%5Bcdate%5D=DESC&limit=250`
    );

    const recentSignups = (ctRes.contacts || []).map(c => ({
      firstName: c.firstName || "Friend",
      lastInitial: (c.lastName || "").slice(0, 1).toUpperCase(),
      state: null,
      addedAt: c.cdate
    }));

    const fabTaken = Math.max(0, sodTotal - FAB_BASELINE);
    const fabRemaining = Math.max(0, CAP_FAB - fabTaken);
    const totalRemaining = Math.max(0, CAP_TOTAL - sodTotal);

    const body = {
      ok: true,
      total: sodTotal,
      pro: proTotal,
      capTotal: CAP_TOTAL,
      capFab: CAP_FAB,
      fabTaken,
      fabRemaining,
      totalRemaining,
      preExisting: PRE_EXISTING,
      recentSignups,
      cartCloseAt: CART_CLOSE_UTC,
      cartCloseTriggers: ["Last 60 seats filled", "9:00 PM CT Fri May 29"],
      fetchedAt: new Date().toISOString()
    };

    return json(body, 200, {
      "cache-control": "public, max-age=5",
      "access-control-allow-origin": "*"
    });
  } catch (e) {
    return json({ ok: false, error: String(e).slice(0, 200) }, 500);
  }
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}
