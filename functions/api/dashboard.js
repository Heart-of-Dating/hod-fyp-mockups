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
// Accepts optional date window via {since, until} ISO strings to scope counts
// to a date range (used by date-range-aware channel + VIP cards).
async function countContactsForTag(env, tagId, range = null) {
  const parts = [];
  if (range?.since) parts.push(`filters[updated_after]=${encodeURIComponent(range.since)}`);
  if (range?.until) parts.push(`filters[updated_before]=${encodeURIComponent(range.until)}`);
  const filter = parts.length ? `&${parts.join('&')}` : "";
  const data = await ac(env, `/contacts?tagid=${tagId}${filter}&limit=1`);
  return parseInt(data?.meta?.total || "0", 10);
}

async function countContactsOnList(env, listId, range = null) {
  const parts = [];
  if (range?.since) parts.push(`filters[updated_after]=${encodeURIComponent(range.since)}`);
  if (range?.until) parts.push(`filters[updated_before]=${encodeURIComponent(range.until)}`);
  const filter = parts.length ? `&${parts.join('&')}` : "";
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
// Pull contacts with optional state field. PARALLELIZED — first call returns
// page 0 + total via meta.total, then remaining pages fire concurrently.
// On Workers Standard (1000 subreq cap) this is safe; on Free it'd risk
// blowing the cap. Drops cold-MISS wall time ~3x (was sequential 14s → ~4s).
async function pullListWithMeta(env, listId, since, { includeState = false, maxPages = 50 } = {}) {
  const STATE_FIELD_ID = 18;
  const PAGE_SIZE = 100;
  const filterStr = since ? `&filters[updated_after]=${encodeURIComponent(since)}` : "";
  const includeParam = includeState ? "&include=fieldValues" : "";

  const buildUrl = (offset) =>
    `/contacts?listid=${listId}${filterStr}${includeParam}&limit=${PAGE_SIZE}&offset=${offset}`;

  // Page 0 — sync, gives us meta.total to plan remaining pages
  const page0 = await ac(env, buildUrl(0));
  const total = parseInt(page0?.meta?.total || "0", 10);
  const totalPages = Math.min(Math.ceil(total / PAGE_SIZE), maxPages);

  // Collect pages — page0 already fetched; fire remaining in parallel
  const pageDataList = [page0];
  if (totalPages > 1) {
    const remaining = [];
    for (let p = 1; p < totalPages; p++) remaining.push(ac(env, buildUrl(p * PAGE_SIZE)));
    const restResults = await Promise.allSettled(remaining);
    for (const r of restResults) {
      if (r.status === "fulfilled") pageDataList.push(r.value);
      // Failures degrade gracefully — partial dataset still useful
    }
  }

  // Flatten + extract state
  const out = [];
  for (const data of pageDataList) {
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
    // Multi-isolate per-key cache so multiple concurrent ranges don't collide
    if (!_cache.byKey) _cache.byKey = {};
    const cacheEntry = _cache.byKey[cacheKey];

    // Helper: build response from a body string
    const respond = (body, xCache) => new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, max-age=0",
        "Access-Control-Allow-Origin": "*",
        "X-Cache": xCache,
      },
    });

    // ---- Tier 1: in-isolate cache. Serve FRESH or STALE (SWR), trigger
    //              background refresh if stale to avoid user-facing failures.
    if (cacheEntry && cacheEntry.body) {
      const age = Date.now() - cacheEntry.at;
      if (age < CACHE_TTL_MS) {
        return respond(cacheEntry.body, "HIT-MEM");
      }
      // Stale — serve immediately, kick off background refresh.
      // Only spawn one refresh per cacheKey at a time (avoid stampede).
      if (!cacheEntry.refreshing) {
        cacheEntry.refreshing = true;
        waitUntil(refreshInBackground(cacheKey, env, url, context).finally(() => {
          if (_cache.byKey[cacheKey]) _cache.byKey[cacheKey].refreshing = false;
        }));
      }
      return respond(cacheEntry.body, "STALE-MEM");
    }

    // ---- Tier 2: CF edge cache (shared across all isolates in this colo)
    const edgeCache = caches.default;
    const cacheReq = new Request(url.toString(), { method: "GET" });
    const cached = await edgeCache.match(cacheReq);
    if (cached) {
      const body = await cached.clone().text();
      _cache.byKey[cacheKey] = { at: Date.now(), body, refreshing: false };
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

    // Pull window — only TODAY (live) or user range. Workers Standard plan
    // gives 1000-subreq + 30s-CPU budget so we can pull exhaustively.
    const todayUtcStart = isoDay(new Date()) + "T00:00:00Z";
    const fetchSinceIso = rangeMode ? rangeStartIso : todayUtcStart;

    // LEAN pull (no fieldValues): exhaustive for hourly accuracy + recent feeds.
    // 25 pages = 2500 contacts, well past current daily volume.
    let allContacts = [];
    try {
      allContacts = await pullListWithMeta(env, LIST_ID, fetchSinceIso, { includeState: false, maxPages: 25 });
    } catch (_) { /* graceful degrade */ }

    let regsTotalList28 = 0;
    try { regsTotalList28 = await countContactsOnList(env, LIST_ID, null); } catch (_) {}

    // State pull: 10 pages = 1000 contacts, strong representative sample of today.
    let stateContacts = [];
    try {
      const stateSince = rangeMode ? rangeStartIso : todayUtcStart;
      stateContacts = await pullListWithMeta(env, LIST_ID, stateSince, { includeState: true, maxPages: 10 });
    } catch (_) { /* non-fatal */ }

    // Today / yesterday counts — both via cheap meta.total queries since
    // the lean pull is now capped to 500 contacts and would undercount today.
    const todayDateUtc = isoDay(new Date());
    const yesterdayDateUtc = isoDay(new Date(Date.now() - 86400000));
    const yesterdayStart = yesterdayDateUtc + "T00:00:00Z";
    const yesterdayEnd = todayDateUtc + "T00:00:00Z";
    let regsTodayAll = 0, regsYesterdayAll = 0;
    try {
      const [tData, yData] = await Promise.all([
        ac(env, `/contacts?listid=${LIST_ID}&filters[updated_after]=${encodeURIComponent(todayUtcStart)}&limit=1`),
        ac(env, `/contacts?listid=${LIST_ID}&filters[updated_after]=${encodeURIComponent(yesterdayStart)}&filters[updated_before]=${encodeURIComponent(yesterdayEnd)}&limit=1`),
      ]);
      regsTodayAll = parseInt(tData?.meta?.total || "0", 10);
      regsYesterdayAll = parseInt(yData?.meta?.total || "0", 10);
    } catch (_) {}

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

    // Channel + VIP counts — date-range-aware when range is set, else all-time.
    // (Per James's audit: when a date range is selected, channel/VIP should
    // reflect that window, not all-time.)
    const rangeFilter = rangeMode
      ? { since: rangeStartIso, until: rangeEndIso }
      : null;

    const [
      regsPaid,
      regsOrganic,
      recentList,
    ] = await Promise.all([
      countContactsForTag(env, TAGS.fyp_paid, rangeFilter),
      countContactsForTag(env, TAGS.fyp_organic, rangeFilter),
      // Recent regs with channel badges (always latest, regardless of range)
      listRecentByChannel(env, TAGS.fyp_paid, TAGS.fyp_organic, 10),
    ]);
    const regsSinceMay1 = regsTotalList28; // always all-time (always-on reference card)

    // VIP tag IDs — one search instead of three (cuts 2 subrequests)
    const vipSearch = await ac(env, `/tags?search=${encodeURIComponent("FYP VIP May 2026")}`);
    const findId = (data, name) => (data.tags || []).find(t => t.tag === name)?.id;
    const vipUmbrellaId = findId(vipSearch, "FYP VIP May 2026");
    const vipPaidId = findId(vipSearch, "FYP VIP May 2026 Paid");
    const vipOrgId = findId(vipSearch, "FYP VIP May 2026 Organic");

    // VIP counts respect the same range filter. In range mode this gives
    // "VIP buyers WITHIN this window" — enables per-day VIP take-rate tracking
    // (the specific thing James called out as wanting).
    const [vipAll, vipPaidCount, vipOrgCount, recentVipList] = await Promise.all([
      vipUmbrellaId ? countContactsForTag(env, vipUmbrellaId, rangeFilter) : 0,
      vipPaidId ? countContactsForTag(env, vipPaidId, rangeFilter) : 0,
      vipOrgId ? countContactsForTag(env, vipOrgId, rangeFilter) : 0,
      listRecentByChannel(env, vipPaidId, vipOrgId, 10),
    ]);

    // VIP take rate denominator: in range mode use range.regs (= contacts that
    // hit the list in that window); in live mode use all-time list size.
    // The denominator must match the numerator's window so the % is meaningful.
    const vipDenom = rangeMode && rangeBlock ? rangeBlock.regs : regsSinceMay1;
    const regToVipPct = vipDenom > 0 ? (vipAll / vipDenom * 100).toFixed(1) : "—";
    const paidToVipPct = regsPaid > 0 ? (vipPaidCount / regsPaid * 100).toFixed(1) : "—";
    const orgToVipPct = regsOrganic > 0 ? (vipOrgCount / regsOrganic * 100).toFixed(1) : "—";

    // A/B test tag counts — LP variants + VIP variants.
    // Tags are created on-the-fly by register.js when first applied, so resolve by name.
    const abSearch = await ac(env, `/tags?search=${encodeURIComponent("LP-v")}`).catch(() => null);
    const vipAbSearch = await ac(env, `/tags?search=${encodeURIComponent("VIP-v")}`).catch(() => null);
    const lpV1Id = findId(abSearch, "LP-v1");
    const lpV2Id = findId(abSearch, "LP-v2");
    const vipV1Id = findId(vipAbSearch, "VIP-v1");
    const vipV2Id = findId(vipAbSearch, "VIP-v2");
    const [lpV1Count, lpV2Count, vipV1Count, vipV2Count] = await Promise.all([
      lpV1Id ? countContactsForTag(env, lpV1Id, rangeFilter) : 0,
      lpV2Id ? countContactsForTag(env, lpV2Id, rangeFilter) : 0,
      vipV1Id ? countContactsForTag(env, vipV1Id, rangeFilter) : 0,
      vipV2Id ? countContactsForTag(env, vipV2Id, rangeFilter) : 0,
    ]);
    const ab_test = {
      lp: {
        v1: { regs: lpV1Count, label: "/fyp/ (control)" },
        v2: { regs: lpV2Count, label: "/fyp/v2/ (AFD + Cloud hero)" },
      },
      vip: {
        v1: { regs: vipV1Count, label: "/fyp/vip (control)" },
        v2: { regs: vipV2Count, label: "/fyp/vip-paid (re-stacked)" },
      },
    };

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
        ab_test,
        range: rangeBlock,
        generated_at: new Date().toISOString(),
      }, null, 2);
    _cache.byKey[cacheKey] = { at: Date.now(), body, refreshing: false };

    // Write to CF edge cache for cross-isolate sharing within the colo
    const responseHeaders = {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=120, max-age=0",
      "Access-Control-Allow-Origin": "*",
      "X-Cache": "MISS",
    };
    const edgeResp = new Response(body, { status: 200, headers: responseHeaders });
    waitUntil(edgeCache.put(cacheReq, edgeResp.clone()));
    return edgeResp;
  } catch (e) {
    // SAFE-ERROR: return valid JSON (status 200) so frontend doesn't choke on
    // "Unexpected token <" from CF's HTML error page. UI shows a "still warming"
    // state. Real error is in `error` field for ops visibility.
    const fallback = (_cache.byKey && _cache.byKey[cacheKey]) ? _cache.byKey[cacheKey].body : null;
    if (fallback) {
      // Serve the last-known-good even if very stale — better than no data
      return respond(fallback, "STALE-FALLBACK");
    }
    return new Response(JSON.stringify({
      ok: false,
      error: e.message,
      warming: true,
      generated_at: new Date().toISOString(),
      // Provide skeletal shape so UI doesn't crash on missing fields
      regs: { today: 0, yesterday: 0, since_may_1: 0 },
      channel: { paid: 0, organic: 0, unknown: 0, paid_is_test: true },
      vip: { total: 0, paid: 0, organic: 0, reg_to_vip_pct: "—", paid_reg_to_vip_pct: "—", organic_reg_to_vip_pct: "—" },
      landing: { today: 0, yesterday: 0, landing_to_reg_pct: "—" },
      hourly_today: [], daily_7d: [], top_states: [], top_referrers: [],
      recent: [], recent_vip: [],
    }), {
      status: 200, // critical: NOT 500. CF Workers gate 500s through HTML error page.
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "X-Cache": "ERROR-SAFE",
      },
    });
  }
}

// Background refresh helper for SWR — re-runs the GET handler but discards
// the response (cache write is the side-effect we care about). Errors are
// swallowed so a failing background refresh doesn't surface to anyone.
async function refreshInBackground(cacheKey, env, url, context) {
  try {
    const fakeRequest = new Request(url.toString(), { method: "GET" });
    // Mark this invocation as a background-refresh to prevent infinite recursion
    fakeRequest.headers.set("x-bg-refresh", "1");
    await onRequestGet({ ...context, request: fakeRequest, env });
  } catch (_) { /* silent — best effort */ }
}
