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

// Pull all contacts on a list with their cdate + state field, for charts
async function pullListWithMeta(env, listId, since) {
  const STATE_FIELD_ID = 18;
  const out = [];
  let offset = 0;
  while (offset < 5000) {
    const filter = since ? `&filters[updated_after]=${encodeURIComponent(since)}` : "";
    const data = await ac(env, `/contacts?listid=${listId}${filter}&include=fieldValues&limit=100&offset=${offset}`);
    const contacts = data.contacts || [];
    const fieldVals = data.fieldValues || [];
    // Build map contactId → state
    const stateByContact = {};
    for (const fv of fieldVals) {
      if (String(fv.field) === String(STATE_FIELD_ID)) {
        stateByContact[fv.contact] = (fv.value || "").toUpperCase();
      }
    }
    for (const c of contacts) {
      out.push({
        cdate: c.cdate,
        udate: c.udate,
        state: stateByContact[c.id] || "",
        email: c.email,
      });
    }
    if (contacts.length < 100) break;
    offset += 100;
  }
  return out;
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
    // Pull full List 28 with cdate + state, single query — derive everything from this
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const allContacts = await pullListWithMeta(env, LIST_ID, sevenDaysAgo);
    const regsTotalList28 = await countContactsOnList(env, LIST_ID, null);

    // Today / yesterday counts from the 7-day pull
    const todayDateUtc = isoDay(new Date());
    const yesterdayDateUtc = isoDay(new Date(Date.now() - 86400000));
    const regsTodayAll = allContacts.filter(c => isoDay(c.udate) === todayDateUtc).length;
    const regsYesterdayAll = allContacts.filter(c => isoDay(c.udate) === yesterdayDateUtc).length;

    // Hourly today (UTC), CT = UTC-5
    const hourlyToday = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    for (const c of allContacts) {
      const d = new Date(c.udate);
      if (isoDay(d) !== todayDateUtc) continue;
      // Convert to CT (UTC-5 during CDT)
      const ctHour = (d.getUTCHours() - 5 + 24) % 24;
      hourlyToday[ctHour].count++;
    }

    // Daily last 7 days
    const dailyMap = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 86400000);
      dailyMap[isoDay(d)] = 0;
    }
    for (const c of allContacts) {
      const dayKey = isoDay(c.udate);
      if (dayKey in dailyMap) dailyMap[dayKey]++;
    }
    const dailyLast7 = Object.entries(dailyMap)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Top states from List 28 (last 7 days only — fresh signal)
    const stateCounts = {};
    for (const c of allContacts) {
      const st = c.state || "—";
      stateCounts[st] = (stateCounts[st] || 0) + 1;
    }
    const topStates = Object.entries(stateCounts)
      .filter(([s]) => s !== "—" && s.length === 2)
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const [
      regsPaid,
      regsOrganic,
      recentList,
    ] = await Promise.all([
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

    // CF Web Analytics pageview pull (GraphQL).
    // Note: Web Analytics enabled ~22:30 UTC May 13. Today's numbers are PARTIAL
    // until tomorrow's full 24-hour window. Conversion math will be apples-to-apples
    // from May 14 00:00 CT onward.
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

    // Top referrers from CF Web Analytics
    let topReferrers = [];
    if (env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID) {
      try {
        const refQuery = `query { viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) { rumPageloadEventsAdaptiveGroups(limit: 10, filter: {date_geq: "${isoDay(new Date(Date.now() - 86400000))}"}, orderBy: [count_DESC]) { count dimensions { refererHost } } } } }`;
        const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: refQuery }),
        });
        if (r.ok) {
          const j = await r.json();
          const rows = j?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
          topReferrers = rows
            .map(r => ({ referrer: r.dimensions?.refererHost || "(direct)", count: r.count || 0 }))
            .filter(r => r.count > 0)
            .slice(0, 5);
        }
      } catch (_) {}
    }

    // Paid count cleanup — until paid launches, the few "paid" contacts are test data
    const paidLooksReal = regsPaid > 5;

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
          unknown: Math.max(0, regsSinceMay1 - regsPaid - regsOrganic),
          paid_is_test: !paidLooksReal,
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
        hourly_today: hourlyToday,
        daily_7d: dailyLast7,
        top_states: topStates,
        top_referrers: topReferrers,
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
