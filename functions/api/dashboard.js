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

// Count via AC's meta.total — single subrequest instead of full pagination.
// Was 5-50 subrequests per count; now 1. Critical for staying under the
// CF Workers free-plan 50-subrequests-per-invocation cap as the list grows.
async function countContactsForTag(env, tagId, since) {
  const filter = since ? `&filters[created_after]=${encodeURIComponent(since)}` : "";
  const data = await ac(env, `/contacts?tagid=${tagId}${filter}&limit=1`);
  return parseInt(data?.meta?.total || "0", 10);
}

async function countContactsOnList(env, listId, since) {
  const filter = since ? `&filters[updated_after]=${encodeURIComponent(since)}` : "";
  const data = await ac(env, `/contacts?listid=${listId}${filter}&limit=1`);
  return parseInt(data?.meta?.total || "0", 10);
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

// Pull contacts on a list with cdate/udate (and optionally state field, for charts).
// Two-mode: lean (no fieldValues) for hourly/daily aggregation, full (with state)
// only when caller actually needs top-states. fieldValues bloat payload ~10x
// and CPU work ~5x — only include when used.
async function pullListWithMeta(env, listId, since, { includeState = false, maxPages = 50 } = {}) {
  const STATE_FIELD_ID = 18;
  const out = [];
  let offset = 0;
  let pages = 0;
  while (offset < 10000 && pages < maxPages) {
    const filter = since ? `&filters[updated_after]=${encodeURIComponent(since)}` : "";
    const includeParam = includeState ? "&include=fieldValues" : "";
    const data = await ac(env, `/contacts?listid=${listId}${filter}${includeParam}&limit=100&offset=${offset}`);
    const contacts = data.contacts || [];
    let stateByContact = null;
    if (includeState) {
      stateByContact = {};
      const fieldVals = data.fieldValues || [];
      for (const fv of fieldVals) {
        if (String(fv.field) === String(STATE_FIELD_ID)) {
          stateByContact[fv.contact] = (fv.value || "").toUpperCase();
        }
      }
    }
    for (const c of contacts) {
      out.push({
        cdate: c.cdate,
        udate: c.udate,
        state: stateByContact ? (stateByContact[c.id] || "") : "",
        email: c.email,
      });
    }
    if (contacts.length < 100) break;
    offset += 100;
    pages++;
  }
  return out;
}

function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }

// Module-level cache (persists per CF isolate). 60s TTL keeps us under
// Worker CPU limits when admin auto-refreshes every 60s. Keyed by request
// shape (live vs specific date range) so different views don't collide.
let _cache = { at: 0, key: null, body: null };
const CACHE_TTL_MS = 120 * 1000; // bumped from 60s — every successful MISS is expensive (~5-8s, large AC pagination), so let cache age longer to amortize. Frontend auto-refresh is still 60s.

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

    // Pull window — in live mode, only pull TODAY's contacts (CF Pages Functions
    // CPU budget is 50ms; 7-day pull at 2K+ scale blew through it). In range
    // mode, use the user's chosen window (their explicit ask).
    const todayUtcStart = isoDay(new Date()) + "T00:00:00Z";
    const fetchSinceIso = rangeMode ? rangeStartIso : todayUtcStart;
    // LEAN pull (no fieldValues). Hard page cap protects CPU budget.
    const allContacts = await pullListWithMeta(env, LIST_ID, fetchSinceIso, { includeState: false, maxPages: 15 });
    const regsTotalList28 = await countContactsOnList(env, LIST_ID, null);

    // Separate state-field pull for top_states, capped tight. If it fails,
    // top_states gracefully degrades to [].
    let stateContacts = [];
    try {
      const stateSince = rangeMode ? rangeStartIso : todayUtcStart;
      stateContacts = await pullListWithMeta(env, LIST_ID, stateSince, { includeState: true, maxPages: 10 });
    } catch (_) { /* non-fatal */ }

    // Today / yesterday counts — today comes from allContacts (pulled fresh),
    // yesterday from a cheap meta.total query since we no longer pull 7 days.
    const todayDateUtc = isoDay(new Date());
    const yesterdayDateUtc = isoDay(new Date(Date.now() - 86400000));
    const regsTodayAll = allContacts.filter(c => isoDay(c.udate) === todayDateUtc).length;
    const yesterdayStart = yesterdayDateUtc + "T00:00:00Z";
    const yesterdayEnd = todayDateUtc + "T00:00:00Z";
    let regsYesterdayAll = 0;
    try {
      const yData = await ac(env, `/contacts?listid=${LIST_ID}&filters[updated_after]=${encodeURIComponent(yesterdayStart)}&filters[updated_before]=${encodeURIComponent(yesterdayEnd)}&limit=1`);
      regsYesterdayAll = parseInt(yData?.meta?.total || "0", 10);
    } catch (_) { /* non-fatal */ }

    // Hourly today (UTC), PT = UTC-7 (PDT, valid May-Nov). Aligns with Meta
    // Ads Manager default timezone so reg-hour bars match Meta's hour buckets.
    const TZ_OFFSET_HOURS = 7; // PDT
    const hourlyToday = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    for (const c of allContacts) {
      const d = new Date(c.udate);
      if (isoDay(d) !== todayDateUtc) continue;
      const ptHour = (d.getUTCHours() - TZ_OFFSET_HOURS + 24) % 24;
      hourlyToday[ptHour].count++;
    }

    // Daily last 7 days — 7 parallel meta.total queries (cheap, no contact data).
    // Avoids the CPU cost of pulling+iterating 7 days of full contacts.
    const dayKeys = [];
    for (let i = 6; i >= 0; i--) dayKeys.push(isoDay(new Date(Date.now() - i * 86400000)));
    const dayCounts = await Promise.all(dayKeys.map(async (day, idx) => {
      try {
        const start = day + "T00:00:00Z";
        const nextDay = isoDay(new Date(Date.now() - (6 - idx - 1) * 86400000));
        const end = (idx === dayKeys.length - 1)
          ? new Date().toISOString()
          : nextDay + "T00:00:00Z";
        const d = await ac(env, `/contacts?listid=${LIST_ID}&filters[updated_after]=${encodeURIComponent(start)}&filters[updated_before]=${encodeURIComponent(end)}&limit=1`);
        return parseInt(d?.meta?.total || "0", 10);
      } catch (_) { return 0; }
    }));
    const dailyLast7 = dayKeys.map((date, i) => ({ date, count: dayCounts[i] }));

    // Top states — from the lean 2-day stateContacts pull (separate from allContacts)
    const stateCounts = {};
    for (const c of stateContacts) {
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
        const hourBuckets = new Map(); // key: "MM/DD HH (PT)" → count
        // Pre-fill buckets so empty hours show as zero
        const PT_OFFSET_MS = 7 * 3600000; // PDT
        const firstHourMs = Math.floor(startMs / 3600000) * 3600000;
        const lastHourMs = Math.floor(endMs / 3600000) * 3600000;
        for (let t = firstHourMs; t <= lastHourMs; t += 3600000) {
          const ptD = new Date(t - PT_OFFSET_MS);
          const label = `${String(ptD.getUTCMonth() + 1).padStart(2,"0")}/${String(ptD.getUTCDate()).padStart(2,"0")} ${String(ptD.getUTCHours()).padStart(2,"0")}`;
          hourBuckets.set(label, 0);
        }
        for (const c of contactsInRange) {
          const t = Date.parse(c.udate);
          const hourMs = Math.floor(t / 3600000) * 3600000;
          const ptD = new Date(hourMs - PT_OFFSET_MS);
          const label = `${String(ptD.getUTCMonth() + 1).padStart(2,"0")}/${String(ptD.getUTCDate()).padStart(2,"0")} ${String(ptD.getUTCHours()).padStart(2,"0")}`;
          if (hourBuckets.has(label)) hourBuckets.set(label, hourBuckets.get(label) + 1);
        }
        rangeHourly = Array.from(hourBuckets.entries()).map(([label, count]) => ({ label, count }));
      }

      // Top states within the range — pull a separate state-included slice
      // for just the range window (smaller payload than full range pull with fields).
      let rangeTopStates = [];
      try {
        const stateRange = await pullListWithMeta(env, LIST_ID, rangeStartIso, { includeState: true, maxPages: 15 });
        const startMsR = rangeStartTs.getTime();
        const endMsR = rangeEndTs.getTime();
        const rangeStateCounts = {};
        for (const c of stateRange) {
          const t = Date.parse(c.udate);
          if (t < startMsR || t > endMsR) continue;
          const st = c.state || "—";
          rangeStateCounts[st] = (rangeStateCounts[st] || 0) + 1;
        }
        rangeTopStates = Object.entries(rangeStateCounts)
          .filter(([s]) => s !== "—" && s.length === 2)
          .map(([state, count]) => ({ state, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);
      } catch (_) { /* non-fatal */ }

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

    // VIP tag IDs — one search instead of three (cuts 2 subrequests)
    const vipSearch = await ac(env, `/tags?search=${encodeURIComponent("FYP VIP May 2026")}`);
    const findId = (data, name) => (data.tags || []).find(t => t.tag === name)?.id;
    const vipUmbrellaId = findId(vipSearch, "FYP VIP May 2026");
    const vipPaidId = findId(vipSearch, "FYP VIP May 2026 Paid");
    const vipOrgId = findId(vipSearch, "FYP VIP May 2026 Organic");

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
      "Cache-Control": "public, s-maxage=120, max-age=0",
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
