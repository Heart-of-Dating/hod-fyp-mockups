// Cloudflare Pages Function — FYP May 2026 admin dashboard data endpoint.
// Pulls registration + VIP counts from ActiveCampaign for the live dashboard.
//
// Returns JSON: { regs: {...}, vip: {...}, channel: {...}, recent: [...], generated: ISO }
//
// Future: layer in Cloudflare Web Analytics pageview data once enabled.

const TAGS = {
  fyp_overall: 200,
  fyp_paid: 202,
  fyp_organic: 203,
  vip_overall_id: null, // resolve at runtime
};

async function ac(env, path) {
  const url = `${env.AC_API_URL.replace(/\/$/, "")}/api/3${path}`;
  const r = await fetch(url, {
    headers: { "Api-Token": env.AC_API_KEY, "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`AC ${r.status} on ${path}`);
  return r.json();
}

async function countContactsForTag(env, tagId, since) {
  // Pull all pages, count
  let total = 0;
  let offset = 0;
  while (offset < 5000) {
    const filter = since ? `&filters[created_after]=${encodeURIComponent(since)}` : "";
    const data = await ac(env, `/contacts?tagid=${tagId}${filter}&limit=100&offset=${offset}`);
    const contacts = data.contacts || [];
    total += contacts.length;
    if (contacts.length < 100) break;
    offset += 100;
  }
  return total;
}

async function listRecent(env, tagId, limit) {
  const data = await ac(env, `/contacts?tagid=${tagId}&orders[cdate]=DESC&limit=${limit}`);
  return (data.contacts || []).map(c => ({
    email: c.email,
    fname: c.firstName || "",
    state: "", // pulled from fieldValues separately if needed
    created: c.cdate,
  }));
}

function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }

export async function onRequestGet({ request, env }) {
  try {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const yesterdayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString();
    const launchCutoff = "2026-05-01T00:00:00Z";

    // Parallel pulls
    const [
      regsTodayAll,
      regsYesterdayAll,
      regsSinceMay1,
      regsPaid,
      regsOrganic,
      recentList,
    ] = await Promise.all([
      countContactsForTag(env, TAGS.fyp_overall, todayStart),
      (async () => {
        // yesterday only = total since yesterday minus today
        const total = await countContactsForTag(env, TAGS.fyp_overall, yesterdayStart);
        const today = await countContactsForTag(env, TAGS.fyp_overall, todayStart);
        return total - today;
      })(),
      countContactsForTag(env, TAGS.fyp_overall, launchCutoff),
      countContactsForTag(env, TAGS.fyp_paid, launchCutoff),
      countContactsForTag(env, TAGS.fyp_organic, launchCutoff),
      listRecent(env, TAGS.fyp_overall, 10),
    ]);

    // VIP counts — resolve tag IDs first
    const vipUmbrella = await ac(env, `/tags?search=${encodeURIComponent("FYP VIP May 2026")}`);
    const vipPaid = await ac(env, `/tags?search=${encodeURIComponent("FYP VIP May 2026 Paid")}`);
    const vipOrg = await ac(env, `/tags?search=${encodeURIComponent("FYP VIP May 2026 Organic")}`);

    const findId = (data, name) => (data.tags || []).find(t => t.tag === name)?.id;
    const vipUmbrellaId = findId(vipUmbrella, "FYP VIP May 2026");
    const vipPaidId = findId(vipPaid, "FYP VIP May 2026 Paid");
    const vipOrgId = findId(vipOrg, "FYP VIP May 2026 Organic");

    const [vipAll, vipPaidCount, vipOrgCount] = await Promise.all([
      vipUmbrellaId ? countContactsForTag(env, vipUmbrellaId, launchCutoff) : 0,
      vipPaidId ? countContactsForTag(env, vipPaidId, launchCutoff) : 0,
      vipOrgId ? countContactsForTag(env, vipOrgId, launchCutoff) : 0,
    ]);

    const regToVipPct = regsSinceMay1 > 0 ? (vipAll / regsSinceMay1 * 100).toFixed(1) : "—";
    const paidToVipPct = regsPaid > 0 ? (vipPaidCount / regsPaid * 100).toFixed(1) : "—";
    const orgToVipPct = regsOrganic > 0 ? (vipOrgCount / regsOrganic * 100).toFixed(1) : "—";

    return new Response(
      JSON.stringify({
        regs: {
          today: regsTodayAll,
          yesterday: regsYesterdayAll,
          since_may_1: regsSinceMay1,
        },
        channel: {
          paid: regsPaid,
          organic: regsOrganic,
          unknown: regsSinceMay1 - regsPaid - regsOrganic,
        },
        vip: {
          total: vipAll,
          paid: vipPaidCount,
          organic: vipOrgCount,
          reg_to_vip_pct: regToVipPct,
          paid_reg_to_vip_pct: paidToVipPct,
          organic_reg_to_vip_pct: orgToVipPct,
        },
        recent: recentList,
        pageviews: {
          note: "Pending — enable Cloudflare Web Analytics on the Pages project to populate",
        },
        generated_at: new Date().toISOString(),
      }, null, 2),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, max-age=0",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
