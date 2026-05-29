// Live SOD signup tracker — reads AC tag counts + recent signups.
// Polled by /sod/ page every ~8s. Edge cached 5s so 1K simultaneous viewers
// don't hammer AC.

const AC_URL = "https://kaitness.api-us1.com/api/3";
const TAG_SOD = 193;       // "School of Dating June 26"
const TAG_SOD_PRO = 194;   // "SOD PRO June 26"
const CAP_TOTAL = 200;
const CAP_FAB = 100;

// Pre-existing signups BEFORE tonight's FAB offer launched (Wed 5/27 8pm CT).
// JJ confirmed: 24 pre-signups. FAB taken = ac_count_now - PRE_EXISTING.
const PRE_EXISTING = 24;

// Cart closes either at 100 FAB seats OR Thu 5/28 9pm CT (02:00 UTC May 29)
const CART_CLOSE_UTC = "2026-05-29T02:00:00Z";

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

    // 3. ALL SOD tag-adds — every enrolled student, deduped by contact id.
    // Used to drive the scrollable "Welcome to the cohort" list so JJ/Kait
    // can shout students out by name on the camp-out slide.
    const ctRes = await ac(
      `/contactTags?filters%5Btag%5D=${TAG_SOD}&orders%5Bcdate%5D=DESC&limit=250&include=contact`
    );

    const contacts = {};
    for (const c of (ctRes.contacts || [])) contacts[c.id] = c;

    const seen = new Set();
    const recentSignups = [];
    for (const ct of (ctRes.contactTags || [])) {
      if (seen.has(ct.contact)) continue;
      seen.add(ct.contact);
      const c = contacts[ct.contact] || {};
      recentSignups.push({
        firstName: c.firstName || "Friend",
        lastInitial: (c.lastName || "").slice(0, 1).toUpperCase(),
        state: null,
        addedAt: ct.cdate
      });
    }

    const fabTaken = Math.max(0, sodTotal - PRE_EXISTING);
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
      cartCloseTriggers: ["100 FAB seats taken", "9:00 PM CT Thu May 28"],
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
