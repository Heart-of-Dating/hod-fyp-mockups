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

async function countContactsOnList(env, listId, since) {
  // Count subscribers on a list (cleaner than tag — list captures re-subs from
  // existing contacts whose tags already existed from prior launches)
  let total = 0;
  let offset = 0;
  while (offset < 10000) {
    const filter = since ? `&filters[updated_after]=${encodeURIComponent(since)}` : "";
    const data = await ac(env, `/contacts?listid=${listId}${filter}&limit=100&offset=${offset}`);
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

    // Total regs = List 28 membership (captures both new + pre-existing AC
    // contacts who registered for May 2026; tag-only count misses re-subs).
    // Today's count = contacts updated today on List 28 (filter via udate).
    // Channel split still uses FYP-Paid/FYP-Organic tags (set via /api/register
    // on each registration regardless of new/existing contact status).
    const LIST_ID = 28;
    const [
      regsTotalList28,
      regsTodayAll,
      regsYesterdayAll,
      regsPaid,
      regsOrganic,
      recentList,
    ] = await Promise.all([
      countContactsOnList(env, LIST_ID, null),
      countContactsOnList(env, LIST_ID, todayStart),
      (async () => {
        const total = await countContactsOnList(env, LIST_ID, yesterdayStart);
        const today = await countContactsOnList(env, LIST_ID, todayStart);
        return total - today;
      })(),
      countContactsForTag(env, TAGS.fyp_paid, null),
      countContactsForTag(env, TAGS.fyp_organic, null),
      listRecent(env, TAGS.fyp_overall, 10),
    ]);
    const regsSinceMay1 = regsTotalList28;

    // VIP counts — resolve tag IDs first
    const vipUmbrella = await ac(env, `/tags?search=${encodeURIComponent("FYP VIP May 2026")}`);
    const vipPaid = await ac(env, `/tags?search=${encodeURIComponent("FYP VIP May 2026 Paid")}`);
    const vipOrg = await ac(env, `/tags?search=${encodeURIComponent("FYP VIP May 2026 Organic")}`);

    const findId = (data, name) => (data.tags || []).find(t => t.tag === name)?.id;
    const vipUmbrellaId = findId(vipUmbrella, "FYP VIP May 2026");
    const vipPaidId = findId(vipPaid, "FYP VIP May 2026 Paid");
    const vipOrgId = findId(vipOrg, "FYP VIP May 2026 Organic");

    // VIP tags are launch-specific (named "FYP VIP May 2026"). Don't filter by
    // created_after — most VIP buyers are pre-existing AC contacts (Kait's
    // email list / podcast fans), so filtering by contact creation date
    // undercounts dramatically. Count ALL with the tag.
    const [vipAll, vipPaidCount, vipOrgCount] = await Promise.all([
      vipUmbrellaId ? countContactsForTag(env, vipUmbrellaId, null) : 0,
      vipPaidId ? countContactsForTag(env, vipPaidId, null) : 0,
      vipOrgId ? countContactsForTag(env, vipOrgId, null) : 0,
    ]);

    const regToVipPct = regsSinceMay1 > 0 ? (vipAll / regsSinceMay1 * 100).toFixed(1) : "—";
    const paidToVipPct = regsPaid > 0 ? (vipPaidCount / regsPaid * 100).toFixed(1) : "—";
    const orgToVipPct = regsOrganic > 0 ? (vipOrgCount / regsOrganic * 100).toFixed(1) : "—";

    // CF Web Analytics pageview pull (GraphQL)
    let pageviews = { today: 0, yesterday: 0, visits_today: 0 };
    let visitToRegPct = "—";
    if (env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID) {
      try {
        const todayDate = isoDay(new Date());
        const yesterdayDate = isoDay(new Date(Date.now() - 86400000));
        const query = `query { viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) { rumPageloadEventsAdaptiveGroups(limit: 1000, filter: {date_geq: "${yesterdayDate}", date_leq: "${todayDate}"}) { count sum { visits } dimensions { date } } } } }`;
        const gqlResp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
        });
        if (gqlResp.ok) {
          const gqlData = await gqlResp.json();
          const rows = gqlData?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
          for (const r of rows) {
            const d = r?.dimensions?.date;
            const count = r?.count || 0;
            const visits = r?.sum?.visits || 0;
            if (d === todayDate) {
              pageviews.today += count;
              pageviews.visits_today += visits;
            } else if (d === yesterdayDate) {
              pageviews.yesterday += count;
            }
          }
          if (pageviews.today > 0) {
            visitToRegPct = (regsTodayAll / pageviews.today * 100).toFixed(1);
          }
        }
      } catch (e) {
        // fail silent — dashboard still works without pageview data
      }
    }

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
        pageviews: {
          today: pageviews.today,
          yesterday: pageviews.yesterday,
          visits_today: pageviews.visits_today,
          visit_to_reg_pct: visitToRegPct,
        },
        recent: recentList,
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
