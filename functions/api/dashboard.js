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

// Pull recent from two tags in parallel, mark channel, merge & sort desc.
// Used for the "recent regs" feed (paid + organic) so each row shows its source.
async function listRecentByChannel(env, paidTagId, organicTagId, limit) {
  const [paid, organic] = await Promise.all([
    paidTagId ? listRecent(env, paidTagId, limit) : Promise.resolve([]),
    organicTagId ? listRecent(env, organicTagId, limit) : Promise.resolve([]),
  ]);
  const merged = [
    ...paid.map(c => ({ ...c, channel: "paid" })),
    ...organic.map(c => ({ ...c, channel: "organic" })),
  ];
  merged.sort((a, b) => new Date(b.created) - new Date(a.created));
  return merged.slice(0, limit);
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

// Module-level cache (persists per CF isolate). 60s TTL keeps us under
// Worker CPU limits when admin auto-refreshes every 60s. Keyed by request
// shape (live vs specific date range) so different views don't collide.
let _cache = { at: 0, key: null, body: null };
const CACHE_TTL_MS = 60 * 1000;

const LAUNCH_CUTOFF = "2026-05-01"; // earliest meaningful date for range mode

export async function onRequestGet(context) {
  const { request, env } = context;
  // Pages Functions exposes waitUntil on context (older runtimes may not).
  const waitUntil = typeof context.waitUntil === "function"
    ? context.waitUntil.bind(context)
    : (p) => { p.catch(() => {}); };
  try {
    // ---- Parse range query params ----
    // ?start=YYYY-MM-DD&end=YYYY-MM-DD switches the time-based panels into
    // range mode. Cumulative panels (total regs, VIP, recent feeds) always
    // show current state regardless of range.
    const url = new URL(request.url);
    const startParam = url.searchParams.get("start");
    const endParam = url.searchParams.get("end");
    // Accept either YYYY-MM-DD (date-only, treated as UTC 00:00 / end of day)
    // or full ISO timestamps with hour precision.
    const parseTs = (s, isEnd) => {
      if (typeof s !== "string") return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return new Date(s + (isEnd ? "T23:59:59.999Z" : "T00:00:00.000Z"));
      }
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    };
    let rangeMode = false;
    let rangeStartTs = null, rangeEndTs = null;
    let rangeStartIso = null, rangeEndIso = null;
    const startTs = parseTs(startParam, false);
    const endTs = parseTs(endParam, true);
    const launchCutoffTs = new Date(LAUNCH_CUTOFF + "T00:00:00.000Z");
    if (startTs && endTs && startTs <= endTs) {
      rangeMode = true;
      // Clamp start to launch cutoff
      rangeStartTs = startTs < launchCutoffTs ? launchCutoffTs : startTs;
      rangeEndTs = endTs;
      rangeStartIso = rangeStartTs.toISOString();
      rangeEndIso = rangeEndTs.toISOString();
    }

    const cacheKey = rangeMode ? `range:${rangeStartIso}_${rangeEndIso}` : "live";

    // ---- Tier 1: in-isolate cache (microseconds, but per-isolate only) ----
    if (_cache.body && _cache.key === cacheKey && Date.now() - _cache.at < CACHE_TTL_MS) {
      return new Response(_cache.body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, max-age=0",
          "Access-Control-Allow-Origin": "*",
          "X-Cache": "HIT-MEM",
        },
      });
    }

    // ---- Tier 2: CF edge cache (shared across all isolates, ~5ms) ----
    // Keyed by the request URL (start/end query params naturally partition it).
    // Each colo holds its own copy but lives across cold starts within that colo.
    const edgeCache = caches.default;
    const cacheReq = new Request(url.toString(), { method: "GET" });
    const cached = await edgeCache.match(cacheReq);
    if (cached) {
      // Warm in-isolate cache from edge for faster subsequent hits
      const body = await cached.clone().text();
      _cache = { at: Date.now(), key: cacheKey, body };
      const r = new Response(body, cached);
      r.headers.set("X-Cache", "HIT-EDGE");
      return r;
    }

    // Total regs = List 28 membership (captures both new + pre-existing AC
    // contacts who registered for May 2026; tag-only count misses re-subs).
    // Today's count = contacts updated today on List 28 (filter via udate).
    // Channel split still uses FYP-Paid/FYP-Organic tags (set via /api/register
    // on each registration regardless of new/existing contact status).
    const LIST_ID = 28;

    // Pull window — widen if range mode reaches back further than 7 days
    const sevenDaysAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();
    const fetchSinceIso = rangeMode ? rangeStartIso : sevenDaysAgoIso;
    const allContacts = await pullListWithMeta(env, LIST_ID, fetchSinceIso);
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

    // ---- Range-mode aggregation (only computed if rangeMode = true) ----
    // Timestamp-precise filtering (not just day-level). Hourly bars when span ≤ 48h,
    // daily bars when longer.
    let rangeBlock = null;
    if (rangeMode) {
      const startMs = rangeStartTs.getTime();
      const endMs = rangeEndTs.getTime();
      const contactsInRange = allContacts.filter(c => {
        const t = Date.parse(c.udate);
        return t >= startMs && t <= endMs;
      });

      const spanHours = Math.round((endMs - startMs) / 3600000);
      const useHourly = spanHours <= 48; // hourly bars for ≤2 days, daily beyond

      // Daily breakdown across the range (zero-fill days)
      const rangeDailyMap = {};
      const startDayMs = Date.parse(isoDay(rangeStartTs) + "T00:00:00.000Z");
      const endDayMs = Date.parse(isoDay(rangeEndTs) + "T00:00:00.000Z");
      for (let t = startDayMs; t <= endDayMs; t += 86400000) {
        rangeDailyMap[isoDay(new Date(t))] = 0;
      }
      for (const c of contactsInRange) {
        const k = isoDay(c.udate);
        if (k in rangeDailyMap) rangeDailyMap[k]++;
      }
      const rangeDaily = Object.entries(rangeDailyMap)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // Hourly breakdown — single-day shows 24 CT hours, multi-day (≤48h) shows
      // hour-of-range labeled with "MM/DD HH" so user sees the actual hour.
      let rangeHourly = null;
      if (useHourly) {
        const hourBuckets = new Map(); // key: "MM-DD HH (CT)" → count
        // Pre-fill buckets so empty hours show as zero
        const firstHourMs = Math.floor(startMs / 3600000) * 3600000;
        const lastHourMs = Math.floor(endMs / 3600000) * 3600000;
        for (let t = firstHourMs; t <= lastHourMs; t += 3600000) {
          const d = new Date(t);
          const ctMs = t - 5 * 3600000; // UTC → CT (UTC-5 CDT)
          const ctD = new Date(ctMs);
          const label = `${String(ctD.getUTCMonth() + 1).padStart(2,"0")}/${String(ctD.getUTCDate()).padStart(2,"0")} ${String(ctD.getUTCHours()).padStart(2,"0")}`;
          hourBuckets.set(label, 0);
        }
        for (const c of contactsInRange) {
          const t = Date.parse(c.udate);
          const hourMs = Math.floor(t / 3600000) * 3600000;
          const ctMs = hourMs - 5 * 3600000;
          const ctD = new Date(ctMs);
          const label = `${String(ctD.getUTCMonth() + 1).padStart(2,"0")}/${String(ctD.getUTCDate()).padStart(2,"0")} ${String(ctD.getUTCHours()).padStart(2,"0")}`;
          if (hourBuckets.has(label)) hourBuckets.set(label, hourBuckets.get(label) + 1);
        }
        rangeHourly = Array.from(hourBuckets.entries()).map(([label, count]) => ({ label, count }));
      }

      // Top states within the range
      const rangeStateCounts = {};
      for (const c of contactsInRange) {
        const st = c.state || "—";
        rangeStateCounts[st] = (rangeStateCounts[st] || 0) + 1;
      }
      const rangeTopStates = Object.entries(rangeStateCounts)
        .filter(([s]) => s !== "—" && s.length === 2)
        .map(([state, count]) => ({ state, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      rangeBlock = {
        start: rangeStartIso,
        end: rangeEndIso,
        start_label: rangeStartIso.slice(0, 16).replace("T", " ") + " UTC",
        end_label: rangeEndIso.slice(0, 16).replace("T", " ") + " UTC",
        days: rangeDaily.length,
        span_hours: spanHours,
        use_hourly: useHourly,
        is_single_day: spanHours <= 24,
        regs: contactsInRange.length,
        daily: rangeDaily,
        hourly: rangeHourly,
        top_states: rangeTopStates,
      };
    }

    const [
      regsPaid,
      regsOrganic,
      recentList,
    ] = await Promise.all([
      countContactsForTag(env, TAGS.fyp_paid, null),
      countContactsForTag(env, TAGS.fyp_organic, null),
      // Recent regs with channel badges (paid vs organic)
      listRecentByChannel(env, TAGS.fyp_paid, TAGS.fyp_organic, 10),
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
    const [vipAll, vipPaidCount, vipOrgCount, recentVipList] = await Promise.all([
      vipUmbrellaId ? countContactsForTag(env, vipUmbrellaId, null) : 0,
      vipPaidId ? countContactsForTag(env, vipPaidId, null) : 0,
      vipOrgId ? countContactsForTag(env, vipOrgId, null) : 0,
      // Recent VIP buyers with channel badges
      listRecentByChannel(env, vipPaidId, vipOrgId, 10),
    ]);

    const regToVipPct = regsSinceMay1 > 0 ? (vipAll / regsSinceMay1 * 100).toFixed(1) : "—";
    const paidToVipPct = regsPaid > 0 ? (vipPaidCount / regsPaid * 100).toFixed(1) : "—";
    const orgToVipPct = regsOrganic > 0 ? (vipOrgCount / regsOrganic * 100).toFixed(1) : "—";

    // CF Web Analytics pageview pull (GraphQL).
    // Note: Web Analytics enabled ~22:30 UTC May 13. Today's numbers are PARTIAL
    // until tomorrow's full 24-hour window. Conversion math will be apples-to-apples
    // from May 14 00:00 CT onward.
    // Landing visits — /fyp/ path only. Use UNIQUE VISITS (sessions), not raw
    // pageviews, as the conversion denominator. A reload or back-button revisit
    // shouldn't inflate the denominator.
    let landing = { today: 0, yesterday: 0, pageviews_today: 0 };
    let landingToRegPct = "—";
    if (env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID) {
      try {
        const todayDate = isoDay(new Date());
        const yesterdayDate = isoDay(new Date(Date.now() - 86400000));
        const query = `query { viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) { rumPageloadEventsAdaptiveGroups(limit: 100, filter: {date_geq: "${yesterdayDate}", date_leq: "${todayDate}", requestPath: "/fyp/"}) { count sum { visits } dimensions { date } } } } }`;
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
            const pv = r?.count || 0;
            const visits = r?.sum?.visits || 0;
            if (d === todayDate) {
              landing.today += visits;
              landing.pageviews_today += pv;
            } else if (d === yesterdayDate) {
              landing.yesterday += visits;
            }
          }
          if (landing.today > 0) {
            landingToRegPct = (regsTodayAll / landing.today * 100).toFixed(1);
          }
        }
      } catch (e) {
        // fail silent — dashboard still works without pageview data
      }
    }

    // Top referrers from CF Web Analytics — range-aware
    // CF GraphQL date_geq/date_leq only support YYYY-MM-DD, so for hour-precision
    // ranges we widen to the covering days.
    const refDateFrom = rangeMode ? isoDay(rangeStartTs) : isoDay(new Date(Date.now() - 86400000));
    const refDateTo = rangeMode ? isoDay(rangeEndTs) : isoDay(new Date());
    let topReferrers = [];
    if (env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID) {
      try {
        const refQuery = `query { viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) { rumPageloadEventsAdaptiveGroups(limit: 10, filter: {date_geq: "${refDateFrom}", date_leq: "${refDateTo}"}, orderBy: [count_DESC]) { count dimensions { refererHost } } } } }`;
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

    // Range-mode landing visits (/fyp/ only, summed across the range)
    let rangeLanding = null;
    if (rangeMode && env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID) {
      try {
        const lq = `query { viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) { rumPageloadEventsAdaptiveGroups(limit: 100, filter: {date_geq: "${refDateFrom}", date_leq: "${refDateTo}", requestPath: "/fyp/"}) { count sum { visits } dimensions { date } } } } }`;
        const lr = await fetch("https://api.cloudflare.com/client/v4/graphql", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: lq }),
        });
        if (lr.ok) {
          const lj = await lr.json();
          const rows = lj?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
          let visits = 0, pv = 0;
          for (const r of rows) {
            visits += r?.sum?.visits || 0;
            pv += r?.count || 0;
          }
          const conv = visits > 0 ? (rangeBlock.regs / visits * 100).toFixed(1) : "—";
          rangeLanding = { visits, pageviews: pv, landing_to_reg_pct: conv };
        }
      } catch (_) {}
      if (rangeBlock) rangeBlock.landing = rangeLanding;
    }

    // Paid count cleanup — until paid launches, the few "paid" contacts are test data
    const paidLooksReal = regsPaid > 5;

    const body = JSON.stringify({
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
        landing: {
          today: landing.today,
          yesterday: landing.yesterday,
          pageviews_today: landing.pageviews_today,
          landing_to_reg_pct: landingToRegPct,
        },
        hourly_today: hourlyToday,
        daily_7d: dailyLast7,
        top_states: topStates,
        top_referrers: topReferrers,
        recent: recentList,
        recent_vip: recentVipList,
        range: rangeBlock,
        generated_at: new Date().toISOString(),
      }, null, 2);
    _cache = { at: Date.now(), key: cacheKey, body };

    // Write to CF edge cache so other isolates / colos can serve from there.
    // s-maxage=60 = edge holds for 60s, browser still treats as no-store.
    const responseHeaders = {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=60, max-age=0",
      "Access-Control-Allow-Origin": "*",
      "X-Cache": "MISS",
    };
    const edgeResp = new Response(body, { status: 200, headers: responseHeaders });
    // Use waitUntil so cache.put doesn't delay the response
    waitUntil(edgeCache.put(cacheReq, edgeResp.clone()));
    return edgeResp;
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
