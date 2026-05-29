var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// api/admin-login.js
var PASSWORD = "jjcool";
var COOKIE_NAME = "hod_admin";
var COOKIE_VALUE = "ok-jjcool-2026";
async function onRequestPost({ request }) {
  let payload;
  try {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      payload = await request.json();
    } else {
      const form = await request.formData();
      payload = Object.fromEntries(form.entries());
    }
  } catch (_) {
    payload = {};
  }
  const pass = (payload.password || "").trim();
  if (pass !== PASSWORD) {
    return new Response(JSON.stringify({ ok: false, error: "wrong password" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  const maxAge = 60 * 60 * 24 * 30;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
    }
  });
}
__name(onRequestPost, "onRequestPost");

// api/dashboard.js
var TAGS = {
  fyp_overall: 200,
  fyp_paid: 202,
  fyp_organic: 203,
  vip_overall_id: null
  // resolve at runtime
};
async function ac(env, path) {
  const url = `${env.AC_API_URL.replace(/\/$/, "")}/api/3${path}`;
  const r = await fetch(url, {
    headers: { "Api-Token": env.AC_API_KEY, "Content-Type": "application/json" }
  });
  if (!r.ok) throw new Error(`AC ${r.status} on ${path}`);
  return r.json();
}
__name(ac, "ac");
async function countContactsForTag(env, tagId, range = null) {
  const parts = [];
  if (range?.since) parts.push(`filters[updated_after]=${encodeURIComponent(range.since)}`);
  if (range?.until) parts.push(`filters[updated_before]=${encodeURIComponent(range.until)}`);
  const filter = parts.length ? `&${parts.join("&")}` : "";
  const data = await ac(env, `/contacts?tagid=${tagId}${filter}&limit=1`);
  return parseInt(data?.meta?.total || "0", 10);
}
__name(countContactsForTag, "countContactsForTag");
async function countContactsOnList(env, listId, range = null) {
  const parts = [];
  if (range?.since) parts.push(`filters[updated_after]=${encodeURIComponent(range.since)}`);
  if (range?.until) parts.push(`filters[updated_before]=${encodeURIComponent(range.until)}`);
  const filter = parts.length ? `&${parts.join("&")}` : "";
  const data = await ac(env, `/contacts?listid=${listId}${filter}&limit=1`);
  return parseInt(data?.meta?.total || "0", 10);
}
__name(countContactsOnList, "countContactsOnList");
async function listRecent(env, tagId, limit) {
  const data = await ac(env, `/contacts?tagid=${tagId}&orders[cdate]=DESC&limit=${limit}`);
  return (data.contacts || []).map((c) => ({
    email: c.email,
    fname: c.firstName || "",
    state: "",
    // pulled from fieldValues separately if needed
    created: c.cdate
  }));
}
__name(listRecent, "listRecent");
async function listRecentByChannel(env, paidTagId, organicTagId, limit) {
  const [paid, organic] = await Promise.all([
    paidTagId ? listRecent(env, paidTagId, limit) : Promise.resolve([]),
    organicTagId ? listRecent(env, organicTagId, limit) : Promise.resolve([])
  ]);
  const merged = [
    ...paid.map((c) => ({ ...c, channel: "paid" })),
    ...organic.map((c) => ({ ...c, channel: "organic" }))
  ];
  merged.sort((a, b) => new Date(b.created) - new Date(a.created));
  return merged.slice(0, limit);
}
__name(listRecentByChannel, "listRecentByChannel");
async function pullListWithMeta(env, listId, since, { includeState = false, maxPages = 50 } = {}) {
  const STATE_FIELD_ID = 18;
  const PAGE_SIZE = 100;
  const filterStr = since ? `&filters[updated_after]=${encodeURIComponent(since)}` : "";
  const includeParam = includeState ? "&include=fieldValues" : "";
  const buildUrl = /* @__PURE__ */ __name((offset) => `/contacts?listid=${listId}${filterStr}${includeParam}&limit=${PAGE_SIZE}&offset=${offset}`, "buildUrl");
  const page0 = await ac(env, buildUrl(0));
  const total = parseInt(page0?.meta?.total || "0", 10);
  const totalPages = Math.min(Math.ceil(total / PAGE_SIZE), maxPages);
  const pageDataList = [page0];
  if (totalPages > 1) {
    const remaining = [];
    for (let p = 1; p < totalPages; p++) remaining.push(ac(env, buildUrl(p * PAGE_SIZE)));
    const restResults = await Promise.allSettled(remaining);
    for (const r of restResults) {
      if (r.status === "fulfilled") pageDataList.push(r.value);
    }
  }
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
        state: stateByContact ? stateByContact[c.id] || "" : "",
        email: c.email
      });
    }
  }
  return out;
}
__name(pullListWithMeta, "pullListWithMeta");
function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}
__name(isoDay, "isoDay");
var _cache = { at: 0, key: null, body: null };
var CACHE_TTL_MS = 30 * 1e3;
var LAUNCH_CUTOFF = "2026-05-01";
async function onRequestGet(context) {
  const { request, env } = context;
  const waitUntil = typeof context.waitUntil === "function" ? context.waitUntil.bind(context) : (p) => {
    p.catch(() => {
    });
  };
  try {
    const url = new URL(request.url);
    const startParam = url.searchParams.get("start");
    const endParam = url.searchParams.get("end");
    const parseTs = /* @__PURE__ */ __name((s, isEnd) => {
      if (typeof s !== "string") return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return /* @__PURE__ */ new Date(s + (isEnd ? "T23:59:59.999Z" : "T00:00:00.000Z"));
      }
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }, "parseTs");
    let rangeMode = false;
    let rangeStartTs = null, rangeEndTs = null;
    let rangeStartIso = null, rangeEndIso = null;
    const startTs = parseTs(startParam, false);
    const endTs = parseTs(endParam, true);
    const launchCutoffTs = /* @__PURE__ */ new Date(LAUNCH_CUTOFF + "T00:00:00.000Z");
    if (startTs && endTs && startTs <= endTs) {
      rangeMode = true;
      rangeStartTs = startTs < launchCutoffTs ? launchCutoffTs : startTs;
      rangeEndTs = endTs;
      rangeStartIso = rangeStartTs.toISOString();
      rangeEndIso = rangeEndTs.toISOString();
    }
    const cacheKey2 = rangeMode ? `range:${rangeStartIso}_${rangeEndIso}` : "live";
    if (!_cache.byKey) _cache.byKey = {};
    const cacheEntry = _cache.byKey[cacheKey2];
    const respond2 = /* @__PURE__ */ __name((body2, xCache) => new Response(body2, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, max-age=0",
        "Access-Control-Allow-Origin": "*",
        "X-Cache": xCache
      }
    }), "respond");
    if (cacheEntry && cacheEntry.body) {
      const age = Date.now() - cacheEntry.at;
      if (age < CACHE_TTL_MS) {
        return respond2(cacheEntry.body, "HIT-MEM");
      }
      if (!cacheEntry.refreshing) {
        cacheEntry.refreshing = true;
        waitUntil(refreshInBackground(cacheKey2, env, url, context).finally(() => {
          if (_cache.byKey[cacheKey2]) _cache.byKey[cacheKey2].refreshing = false;
        }));
      }
      return respond2(cacheEntry.body, "STALE-MEM");
    }
    const edgeCache = caches.default;
    const cacheReq = new Request(url.toString(), { method: "GET" });
    const cached = await edgeCache.match(cacheReq);
    if (cached) {
      const body2 = await cached.clone().text();
      _cache.byKey[cacheKey2] = { at: Date.now(), body: body2, refreshing: false };
      const r = new Response(body2, cached);
      r.headers.set("X-Cache", "HIT-EDGE");
      return r;
    }
    const LIST_ID = 28;
    const todayUtcStart = isoDay(/* @__PURE__ */ new Date()) + "T00:00:00Z";
    const fetchSinceIso = rangeMode ? rangeStartIso : todayUtcStart;
    let allContacts = [];
    try {
      allContacts = await pullListWithMeta(env, LIST_ID, fetchSinceIso, { includeState: false, maxPages: 25 });
    } catch (_) {
    }
    let regsTotalList28 = 0;
    try {
      regsTotalList28 = await countContactsOnList(env, LIST_ID, null);
    } catch (_) {
    }
    let stateContacts = [];
    try {
      const stateSince = rangeMode ? rangeStartIso : todayUtcStart;
      stateContacts = await pullListWithMeta(env, LIST_ID, stateSince, { includeState: true, maxPages: 10 });
    } catch (_) {
    }
    const todayDateUtc = isoDay(/* @__PURE__ */ new Date());
    const yesterdayDateUtc = isoDay(new Date(Date.now() - 864e5));
    const yesterdayStart = yesterdayDateUtc + "T00:00:00Z";
    const yesterdayEnd = todayDateUtc + "T00:00:00Z";
    let regsTodayAll = 0, regsYesterdayAll = 0;
    try {
      const [tData, yData] = await Promise.all([
        ac(env, `/contacts?listid=${LIST_ID}&filters[created_after]=${encodeURIComponent(todayUtcStart)}&limit=1`),
        ac(env, `/contacts?listid=${LIST_ID}&filters[created_after]=${encodeURIComponent(yesterdayStart)}&filters[created_before]=${encodeURIComponent(yesterdayEnd)}&limit=1`)
      ]);
      regsTodayAll = parseInt(tData?.meta?.total || "0", 10);
      regsYesterdayAll = parseInt(yData?.meta?.total || "0", 10);
    } catch (_) {
    }
    const TZ_OFFSET_HOURS = 7;
    const hourlyToday = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    for (const c of allContacts) {
      const d = new Date(c.udate);
      if (isoDay(d) !== todayDateUtc) continue;
      const ptHour = (d.getUTCHours() - TZ_OFFSET_HOURS + 24) % 24;
      hourlyToday[ptHour].count++;
    }
    const dayKeys = [];
    for (let i = 6; i >= 0; i--) dayKeys.push(isoDay(new Date(Date.now() - i * 864e5)));
    const dayCounts = await Promise.all(dayKeys.map(async (day, idx) => {
      try {
        const start = day + "T00:00:00Z";
        const nextDay = isoDay(new Date(Date.now() - (6 - idx - 1) * 864e5));
        const end = idx === dayKeys.length - 1 ? (/* @__PURE__ */ new Date()).toISOString() : nextDay + "T00:00:00Z";
        const d = await ac(env, `/contacts?listid=${LIST_ID}&filters[updated_after]=${encodeURIComponent(start)}&filters[updated_before]=${encodeURIComponent(end)}&limit=1`);
        return parseInt(d?.meta?.total || "0", 10);
      } catch (_) {
        return 0;
      }
    }));
    const dailyLast7 = dayKeys.map((date, i) => ({ date, count: dayCounts[i] }));
    const stateCounts = {};
    for (const c of stateContacts) {
      const st = c.state || "\u2014";
      stateCounts[st] = (stateCounts[st] || 0) + 1;
    }
    const topStates = Object.entries(stateCounts).filter(([s]) => s !== "\u2014" && s.length === 2).map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count).slice(0, 10);
    let rangeBlock = null;
    if (rangeMode) {
      const startMs = rangeStartTs.getTime();
      const endMs = rangeEndTs.getTime();
      const contactsInRange = allContacts.filter((c) => {
        const t = Date.parse(c.udate);
        return t >= startMs && t <= endMs;
      });
      const spanHours = Math.round((endMs - startMs) / 36e5);
      const useHourly = spanHours <= 48;
      const rangeDailyMap = {};
      const startDayMs = Date.parse(isoDay(rangeStartTs) + "T00:00:00.000Z");
      const endDayMs = Date.parse(isoDay(rangeEndTs) + "T00:00:00.000Z");
      for (let t = startDayMs; t <= endDayMs; t += 864e5) {
        rangeDailyMap[isoDay(new Date(t))] = 0;
      }
      for (const c of contactsInRange) {
        const k = isoDay(c.udate);
        if (k in rangeDailyMap) rangeDailyMap[k]++;
      }
      const rangeDaily = Object.entries(rangeDailyMap).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
      let rangeHourly = null;
      if (useHourly) {
        const hourBuckets = /* @__PURE__ */ new Map();
        const PT_OFFSET_MS = 7 * 36e5;
        const firstHourMs = Math.floor(startMs / 36e5) * 36e5;
        const lastHourMs = Math.floor(endMs / 36e5) * 36e5;
        for (let t = firstHourMs; t <= lastHourMs; t += 36e5) {
          const ptD = new Date(t - PT_OFFSET_MS);
          const label = `${String(ptD.getUTCMonth() + 1).padStart(2, "0")}/${String(ptD.getUTCDate()).padStart(2, "0")} ${String(ptD.getUTCHours()).padStart(2, "0")}`;
          hourBuckets.set(label, 0);
        }
        for (const c of contactsInRange) {
          const t = Date.parse(c.udate);
          const hourMs = Math.floor(t / 36e5) * 36e5;
          const ptD = new Date(hourMs - PT_OFFSET_MS);
          const label = `${String(ptD.getUTCMonth() + 1).padStart(2, "0")}/${String(ptD.getUTCDate()).padStart(2, "0")} ${String(ptD.getUTCHours()).padStart(2, "0")}`;
          if (hourBuckets.has(label)) hourBuckets.set(label, hourBuckets.get(label) + 1);
        }
        rangeHourly = Array.from(hourBuckets.entries()).map(([label, count]) => ({ label, count }));
      }
      let rangeTopStates = [];
      try {
        const stateRange = await pullListWithMeta(env, LIST_ID, rangeStartIso, { includeState: true, maxPages: 15 });
        const startMsR = rangeStartTs.getTime();
        const endMsR = rangeEndTs.getTime();
        const rangeStateCounts = {};
        for (const c of stateRange) {
          const t = Date.parse(c.udate);
          if (t < startMsR || t > endMsR) continue;
          const st = c.state || "\u2014";
          rangeStateCounts[st] = (rangeStateCounts[st] || 0) + 1;
        }
        rangeTopStates = Object.entries(rangeStateCounts).filter(([s]) => s !== "\u2014" && s.length === 2).map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count).slice(0, 10);
      } catch (_) {
      }
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
        top_states: rangeTopStates
      };
    }
    const rangeFilter = rangeMode ? { since: rangeStartIso, until: rangeEndIso } : null;
    const [
      regsPaid,
      regsOrganic,
      recentList
    ] = await Promise.all([
      countContactsForTag(env, TAGS.fyp_paid, rangeFilter),
      countContactsForTag(env, TAGS.fyp_organic, rangeFilter),
      // Recent regs with channel badges (always latest, regardless of range)
      listRecentByChannel(env, TAGS.fyp_paid, TAGS.fyp_organic, 10)
    ]);
    const regsSinceMay1 = regsTotalList28;
    const vipSearch = await ac(env, `/tags?search=${encodeURIComponent("FYP VIP May 2026")}`);
    const findId = /* @__PURE__ */ __name((data, name) => (data.tags || []).find((t) => t.tag === name)?.id, "findId");
    const vipUmbrellaId = findId(vipSearch, "FYP VIP May 2026");
    const vipPaidId = findId(vipSearch, "FYP VIP May 2026 Paid");
    const vipOrgId = findId(vipSearch, "FYP VIP May 2026 Organic");
    const [vipAll, vipPaidCount, vipOrgCount, recentVipList] = await Promise.all([
      vipUmbrellaId ? countContactsForTag(env, vipUmbrellaId, rangeFilter) : 0,
      vipPaidId ? countContactsForTag(env, vipPaidId, rangeFilter) : 0,
      vipOrgId ? countContactsForTag(env, vipOrgId, rangeFilter) : 0,
      listRecentByChannel(env, vipPaidId, vipOrgId, 10)
    ]);
    const vipDenom = rangeMode && rangeBlock ? rangeBlock.regs : regsSinceMay1;
    const regToVipPct = vipDenom > 0 ? (vipAll / vipDenom * 100).toFixed(1) : "\u2014";
    const paidToVipPct = regsPaid > 0 ? (vipPaidCount / regsPaid * 100).toFixed(1) : "\u2014";
    const orgToVipPct = regsOrganic > 0 ? (vipOrgCount / regsOrganic * 100).toFixed(1) : "\u2014";
    const LP_AB_START = "2026-05-22T02:04:14Z";
    const lpRange = (() => {
      const since = rangeFilter?.since && rangeFilter.since > LP_AB_START ? rangeFilter.since : LP_AB_START;
      const until = rangeFilter?.until || null;
      return until ? { since, until } : { since };
    })();
    const abSearch = await ac(env, `/tags?search=${encodeURIComponent("LP-v")}`).catch(() => null);
    const vipAbSearch = await ac(env, `/tags?search=${encodeURIComponent("VIP-v")}`).catch(() => null);
    const lpV1Id = findId(abSearch, "LP-v1");
    const lpV2Id = findId(abSearch, "LP-v2");
    const vipV1Id = findId(vipAbSearch, "VIP-v1");
    const vipV2Id = findId(vipAbSearch, "VIP-v2");
    const [lpV1Count, lpV2Count, lpV1AllCount, lpV2AllCount, vipV1Count, vipV2Count] = await Promise.all([
      lpV1Id ? countContactsForTag(env, lpV1Id, lpRange) : 0,
      lpV2Id ? countContactsForTag(env, lpV2Id, lpRange) : 0,
      lpV1Id ? countContactsForTag(env, lpV1Id, rangeFilter) : 0,
      lpV2Id ? countContactsForTag(env, lpV2Id, rangeFilter) : 0,
      vipV1Id ? countContactsForTag(env, vipV1Id, rangeFilter) : 0,
      vipV2Id ? countContactsForTag(env, vipV2Id, rangeFilter) : 0
    ]);
    let lpV1Visitors = 0, lpV2Visitors = 0;
    let convRateSince = lpRange.since;
    if (env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID) {
      try {
        const fmt = /* @__PURE__ */ __name((iso) => iso.slice(0, 19).replace("T", " "), "fmt");
        const minSql = `SELECT formatDateTime(min(timestamp), '%Y-%m-%dT%H:%i:%SZ') AS first_ts FROM ab_test_visitors FORMAT JSON`;
        const minResp = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
          { method: "POST", headers: { "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "text/plain" }, body: minSql }
        );
        if (minResp.ok) {
          const minJson = await minResp.json();
          const firstTs = minJson?.data?.[0]?.first_ts;
          if (firstTs && firstTs > convRateSince) convRateSince = firstTs;
        }
        const sinceIso = convRateSince;
        const untilIso = lpRange.until || (/* @__PURE__ */ new Date()).toISOString();
        const sql = `SELECT blob1 AS variant, COUNT() AS visitors
          FROM ab_test_visitors
          WHERE timestamp >= toDateTime('${fmt(sinceIso)}')
            AND timestamp <= toDateTime('${fmt(untilIso)}')
          GROUP BY blob1
          FORMAT JSON`;
        const aeResp = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}`,
              "Content-Type": "text/plain"
            },
            body: sql
          }
        );
        if (aeResp.ok) {
          const aeJson = await aeResp.json();
          for (const row of aeJson?.data || []) {
            if (row.variant === "v1") lpV1Visitors = parseInt(row.visitors, 10) || 0;
            else if (row.variant === "v2") lpV2Visitors = parseInt(row.visitors, 10) || 0;
          }
        }
      } catch (_) {
      }
    }
    let lpV1RegsConvWindow = lpV1Count, lpV2RegsConvWindow = lpV2Count;
    if (convRateSince !== lpRange.since && lpV1Id && lpV2Id) {
      try {
        const cwRange = { since: convRateSince, until: lpRange.until };
        [lpV1RegsConvWindow, lpV2RegsConvWindow] = await Promise.all([
          countContactsForTag(env, lpV1Id, cwRange),
          countContactsForTag(env, lpV2Id, cwRange)
        ]);
      } catch (_) {
      }
    }
    const pct = /* @__PURE__ */ __name((num, denom) => denom > 0 ? +(num / denom * 100).toFixed(2) : null, "pct");
    const ab_test = {
      lp: {
        v1: {
          regs: lpV1Count,
          visitors: lpV1Visitors,
          regs_conv_window: lpV1RegsConvWindow,
          conv_rate: pct(lpV1RegsConvWindow, lpV1Visitors),
          label: "/fyp/ (control)"
        },
        v2: {
          regs: lpV2Count,
          visitors: lpV2Visitors,
          regs_conv_window: lpV2RegsConvWindow,
          conv_rate: pct(lpV2RegsConvWindow, lpV2Visitors),
          label: "/fyp/v2/ (AFD + Cloud hero)"
        },
        v1_all: lpV1AllCount,
        v2_all: lpV2AllCount,
        since: lpRange.since,
        conv_rate_since: convRateSince,
        note: "Lift % uses regs scoped to post-middleware (LP-v1 tagging predates rotation). Conv-rate % uses regs + visitors both scoped to the AE-instrumentation floor (earliest visitor row) for apples-to-apples math."
      },
      vip: {
        v1: { regs: vipV1Count, label: "/fyp/vip (control)" },
        v2: { regs: vipV2Count, label: "/fyp/vip-paid (re-stacked)" }
      }
    };
    const smsSearch = await ac(env, `/tags?search=${encodeURIComponent("SMS_Optin_Yes")}`).catch(() => null);
    const smsTagId = findId(smsSearch, "SMS_Optin_Yes");
    const PRE_FLIP_END = "2026-05-17T23:59:59Z";
    const POST_FLIP_START = "2026-05-18T00:00:00Z";
    const [smsTotal, smsPre, smsPost, regsPre, regsPost] = await Promise.all([
      smsTagId ? countContactsForTag(env, smsTagId, null) : 0,
      smsTagId ? countContactsForTag(env, smsTagId, { until: PRE_FLIP_END }) : 0,
      smsTagId ? countContactsForTag(env, smsTagId, { since: POST_FLIP_START }) : 0,
      countContactsOnList(env, LIST_ID, { until: PRE_FLIP_END }),
      countContactsOnList(env, LIST_ID, { since: POST_FLIP_START })
    ]);
    const sms_optin = {
      total: smsTotal,
      pre_flip: { regs: regsPre, optins: smsPre, pct: regsPre > 0 ? +(smsPre / regsPre * 100).toFixed(1) : 0 },
      post_flip: { regs: regsPost, optins: smsPost, pct: regsPost > 0 ? +(smsPost / regsPost * 100).toFixed(1) : 0 },
      delta_pp: 0
      // computed below
    };
    sms_optin.delta_pp = +(sms_optin.post_flip.pct - sms_optin.pre_flip.pct).toFixed(1);
    let telnyxMetrics = { sent: 0, delivered: 0, errors: 0, delivery_pct: null };
    if (env.TELNYX_API_KEY && env.TELNYX_MESSAGING_PROFILE_ID) {
      try {
        const r = await fetch(
          `https://api.telnyx.com/v2/messaging_profiles/${env.TELNYX_MESSAGING_PROFILE_ID}/metrics?time_frame=30d`,
          { headers: { "Authorization": `Bearer ${env.TELNYX_API_KEY}` } }
        );
        if (r.ok) {
          const tj = await r.json();
          const ov = tj?.data?.overview?.outbound || {};
          telnyxMetrics.sent = ov.sent || 0;
          telnyxMetrics.delivered = ov.delivered || 0;
          telnyxMetrics.errors = ov.errors || 0;
          telnyxMetrics.delivery_pct = telnyxMetrics.sent > 0 ? +(telnyxMetrics.delivered / telnyxMetrics.sent * 100).toFixed(1) : null;
        }
      } catch (_) {
      }
    }
    const smsNightCounts = { n1: 0, n2: 0, n3: 0, n4: 0 };
    try {
      const sentTagsSearch = await ac(env, `/tags?search=${encodeURIComponent("Sent_N")}`);
      const nightTagIds = {};
      for (const t of sentTagsSearch?.tags || []) {
        const m = (t.tag || "").match(/^Sent_N([1-4])$/);
        if (m) nightTagIds["n" + m[1]] = t.id;
      }
      const counts = await Promise.all(
        ["n1", "n2", "n3", "n4"].map((k) => nightTagIds[k] ? countContactsForTag(env, nightTagIds[k], null).catch(() => 0) : Promise.resolve(0))
      );
      counts.forEach((c, i) => smsNightCounts["n" + (i + 1)] = c);
    } catch (_) {
    }
    const SOD_J26_TAG = 193;
    const SOD_CAP = 200;
    const SOD_PRO_FAB_CAP = 100;
    const SOD_CHALLENGE_BASELINE = 26;
    let sodTotal = 0;
    try {
      sodTotal = await countContactsForTag(env, SOD_J26_TAG, null);
    } catch (_) {
    }
    const sodLift = Math.max(0, sodTotal - SOD_CHALLENGE_BASELINE);
    const sodPitchCap = SOD_CAP - SOD_CHALLENGE_BASELINE;
    const sodPitchEnrolled = sodLift;
    const sodPitchRemaining = Math.max(0, sodPitchCap - sodPitchEnrolled);
    const sod = {
      // Admin/internal view (everything)
      total: sodTotal,
      tonight: sodLift,
      baseline: SOD_CHALLENGE_BASELINE,
      cap: SOD_CAP,
      headroom: Math.max(0, SOD_CAP - sodTotal),
      cap_pct: SOD_CAP > 0 ? +(sodTotal / SOD_CAP * 100).toFixed(1) : 0,
      // Pitch view (Kait's live screen — baseline hidden, 174-slot framing)
      pitch: {
        enrolled: sodPitchEnrolled,
        // starts at 0, grows as new SODs come in
        cap: sodPitchCap,
        // 174 (= 200 - 26)
        remaining: sodPitchRemaining,
        // counts down from 174
        cap_pct: sodPitchCap > 0 ? +(sodPitchEnrolled / sodPitchCap * 100).toFixed(1) : 0
      },
      pro_fab_cap: SOD_PRO_FAB_CAP
    };
    let landing = { today: 0, yesterday: 0, pageviews_today: 0 };
    let landingToRegPct = "\u2014";
    if (env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID) {
      try {
        const todayDate = isoDay(/* @__PURE__ */ new Date());
        const yesterdayDate = isoDay(new Date(Date.now() - 864e5));
        const query = `query { viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) { rumPageloadEventsAdaptiveGroups(limit: 100, filter: {date_geq: "${yesterdayDate}", date_leq: "${todayDate}", requestPath: "/fyp/"}) { count sum { visits } dimensions { date } } } } }`;
        const gqlResp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ query })
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
      }
    }
    const refDateFrom = rangeMode ? isoDay(rangeStartTs) : isoDay(new Date(Date.now() - 864e5));
    const refDateTo = rangeMode ? isoDay(rangeEndTs) : isoDay(/* @__PURE__ */ new Date());
    let topReferrers = [];
    if (env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID) {
      try {
        const refQuery = `query { viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) { rumPageloadEventsAdaptiveGroups(limit: 10, filter: {date_geq: "${refDateFrom}", date_leq: "${refDateTo}"}, orderBy: [count_DESC]) { count dimensions { refererHost } } } } }`;
        const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: refQuery })
        });
        if (r.ok) {
          const j = await r.json();
          const rows = j?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
          topReferrers = rows.map((r2) => ({ referrer: r2.dimensions?.refererHost || "(direct)", count: r2.count || 0 })).filter((r2) => r2.count > 0).slice(0, 5);
        }
      } catch (_) {
      }
    }
    let rangeLanding = null;
    if (rangeMode && env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID) {
      try {
        const lq = `query { viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) { rumPageloadEventsAdaptiveGroups(limit: 100, filter: {date_geq: "${refDateFrom}", date_leq: "${refDateTo}", requestPath: "/fyp/"}) { count sum { visits } dimensions { date } } } } }`;
        const lr = await fetch("https://api.cloudflare.com/client/v4/graphql", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: lq })
        });
        if (lr.ok) {
          const lj = await lr.json();
          const rows = lj?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
          let visits = 0, pv = 0;
          for (const r of rows) {
            visits += r?.sum?.visits || 0;
            pv += r?.count || 0;
          }
          const conv = visits > 0 ? (rangeBlock.regs / visits * 100).toFixed(1) : "\u2014";
          rangeLanding = { visits, pageviews: pv, landing_to_reg_pct: conv };
        }
      } catch (_) {
      }
      if (rangeBlock) rangeBlock.landing = rangeLanding;
    }
    const paidLooksReal = regsPaid > 5;
    const body = JSON.stringify({
      regs: {
        today: regsTodayAll,
        yesterday: regsYesterdayAll,
        since_may_1: regsSinceMay1
      },
      channel: {
        paid: regsPaid,
        organic: regsOrganic,
        unknown: Math.max(0, regsSinceMay1 - regsPaid - regsOrganic),
        paid_is_test: !paidLooksReal
      },
      vip: {
        total: vipAll,
        paid: vipPaidCount,
        organic: vipOrgCount,
        reg_to_vip_pct: regToVipPct,
        paid_reg_to_vip_pct: paidToVipPct,
        organic_reg_to_vip_pct: orgToVipPct
      },
      landing: {
        today: landing.today,
        yesterday: landing.yesterday,
        pageviews_today: landing.pageviews_today,
        landing_to_reg_pct: landingToRegPct
      },
      hourly_today: hourlyToday,
      daily_7d: dailyLast7,
      top_states: topStates,
      top_referrers: topReferrers,
      recent: recentList,
      recent_vip: recentVipList,
      ab_test,
      sms_optin,
      telnyx: telnyxMetrics,
      sms_nights: smsNightCounts,
      sod,
      range: rangeBlock,
      generated_at: (/* @__PURE__ */ new Date()).toISOString()
    }, null, 2);
    _cache.byKey[cacheKey2] = { at: Date.now(), body, refreshing: false };
    const responseHeaders = {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=30, max-age=0",
      "Access-Control-Allow-Origin": "*",
      "X-Cache": "MISS"
    };
    const edgeResp = new Response(body, { status: 200, headers: responseHeaders });
    waitUntil(edgeCache.put(cacheReq, edgeResp.clone()));
    return edgeResp;
  } catch (e) {
    const fallback = _cache.byKey && _cache.byKey[cacheKey] ? _cache.byKey[cacheKey].body : null;
    if (fallback) {
      return respond(fallback, "STALE-FALLBACK");
    }
    return new Response(JSON.stringify({
      ok: false,
      error: e.message,
      warming: true,
      generated_at: (/* @__PURE__ */ new Date()).toISOString(),
      // Provide skeletal shape so UI doesn't crash on missing fields
      regs: { today: 0, yesterday: 0, since_may_1: 0 },
      channel: { paid: 0, organic: 0, unknown: 0, paid_is_test: true },
      vip: { total: 0, paid: 0, organic: 0, reg_to_vip_pct: "\u2014", paid_reg_to_vip_pct: "\u2014", organic_reg_to_vip_pct: "\u2014" },
      landing: { today: 0, yesterday: 0, landing_to_reg_pct: "\u2014" },
      hourly_today: [],
      daily_7d: [],
      top_states: [],
      top_referrers: [],
      recent: [],
      recent_vip: []
    }), {
      status: 200,
      // critical: NOT 500. CF Workers gate 500s through HTML error page.
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "X-Cache": "ERROR-SAFE"
      }
    });
  }
}
__name(onRequestGet, "onRequestGet");
async function refreshInBackground(cacheKey2, env, url, context) {
  try {
    const fakeRequest = new Request(url.toString(), { method: "GET" });
    fakeRequest.headers.set("x-bg-refresh", "1");
    await onRequestGet({ ...context, request: fakeRequest, env });
  } catch (_) {
  }
}
__name(refreshInBackground, "refreshInBackground");

// api/dashboard-search.js
async function ac2(env, path) {
  const url = `${env.AC_API_URL.replace(/\/$/, "")}/api/3${path}`;
  const r = await fetch(url, {
    headers: { "Api-Token": env.AC_API_KEY, "Content-Type": "application/json" }
  });
  if (!r.ok) throw new Error(`AC ${r.status} on ${path}`);
  return r.json();
}
__name(ac2, "ac");
var RELEVANT_TAG_PATTERNS = [
  /^FYP/i,
  /^SMS_Optin/i,
  /^School of Dating/i,
  /VIP/i
];
async function onRequestGet2({ request, env }) {
  try {
    const url = new URL(request.url);
    const emailRaw = (url.searchParams.get("email") || "").trim().toLowerCase();
    if (!emailRaw || emailRaw.length < 3) {
      return new Response(JSON.stringify({ error: "email required (min 3 chars)" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    const FYP_OVERALL_TAG_ID = 200;
    const isPartial = !emailRaw.includes("@") || emailRaw.endsWith("@");
    const path = isPartial ? `/contacts?search=${encodeURIComponent(emailRaw)}&tagid=${FYP_OVERALL_TAG_ID}&limit=10` : `/contacts?email=${encodeURIComponent(emailRaw)}&tagid=${FYP_OVERALL_TAG_ID}&limit=10`;
    const data = await ac2(env, path);
    const contacts = data.contacts || [];
    if (!contacts.length) {
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    const results = await Promise.all(contacts.map(async (c) => {
      const tagsResp = await ac2(env, `/contacts/${c.id}/contactTags`);
      const contactTagLinks = tagsResp.contactTags || [];
      const tagIds = contactTagLinks.map((ct) => ct.tag);
      const tagNames = [];
      const idsToResolve = tagIds.slice(0, 30);
      const tagFetches = await Promise.all(idsToResolve.map(async (id) => {
        try {
          const tr = await ac2(env, `/tags/${id}`);
          return tr.tag?.tag || null;
        } catch (_) {
          return null;
        }
      }));
      for (const name of tagFetches) {
        if (name) tagNames.push(name);
      }
      const relevantTags = tagNames.filter((t) => RELEVANT_TAG_PATTERNS.some((rx) => rx.test(t)));
      const channel = relevantTags.find((t) => /FYP-Paid/i.test(t)) ? "paid" : relevantTags.find((t) => /FYP-Organic/i.test(t)) ? "organic" : null;
      const isVip = relevantTags.some((t) => /VIP May 2026/i.test(t));
      const smsOptin = relevantTags.some((t) => /SMS_Optin_Yes/i.test(t));
      return {
        id: c.id,
        email: c.email,
        fname: c.firstName || "",
        lname: c.lastName || "",
        phone: c.phone || "",
        created: c.cdate,
        updated: c.udate,
        channel,
        is_vip: isVip,
        sms_optin: smsOptin,
        tags: relevantTags
      };
    }));
    return new Response(JSON.stringify({ results }, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, max-age=0",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
__name(onRequestGet2, "onRequestGet");

// api/meta-ads.js
var META_API_VERSION = "v19.0";
var TARGET_CPL = 1.79;
var FYP_LAUNCH_DATE = "2026-05-13";
var FYP_EVENT_START_DATE = "2026-05-26";
var DEFAULT_PAID_LEAD_TARGET = 15500;
var FYP_CAMPAIGN_FILTER = JSON.stringify([{
  field: "campaign.name",
  operator: "CONTAIN",
  value: "FYP Challenge 2026"
}]);
var _cache2 = { byKey: {} };
var CACHE_TTL_MS2 = 90 * 1e3;
function ptDateStr(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}
__name(ptDateStr, "ptDateStr");
function timeRangeFromIso(startIso, endIso) {
  return { since: ptDateStr(new Date(startIso)), until: ptDateStr(new Date(endIso)) };
}
__name(timeRangeFromIso, "timeRangeFromIso");
function compareWindow(startIso, endIso) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const spanMs = endMs - startMs;
  const compareEnd = new Date(startMs - 1);
  const compareStart = new Date(startMs - spanMs - 1);
  return {
    since: ptDateStr(compareStart),
    until: ptDateStr(compareEnd),
    label: spanHoursLabel(spanMs)
  };
}
__name(compareWindow, "compareWindow");
function spanHoursLabel(spanMs) {
  const hours = Math.round(spanMs / 36e5);
  if (hours <= 24) return "previous day";
  if (hours <= 48) return "previous 2 days";
  const days = Math.round(hours / 24);
  return `previous ${days} days`;
}
__name(spanHoursLabel, "spanHoursLabel");
async function fetchInsights(env, params) {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}/${env.META_AD_ACCOUNT_ID}/insights`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : v);
  url.searchParams.set("access_token", env.META_ADS_TOKEN);
  const r = await fetch(url.toString());
  const data = await r.json();
  if (!r.ok || data.error) {
    throw new Error(`Meta ${r.status}: ${data.error?.message || "unknown"}`);
  }
  return data.data || [];
}
__name(fetchInsights, "fetchInsights");
function actionCount(row, type) {
  const m = (row?.actions || []).find((a) => a.action_type === type);
  return m ? parseInt(m.value, 10) : 0;
}
__name(actionCount, "actionCount");
function getLeads(row) {
  return actionCount(row, "complete_registration") || actionCount(row, "lead") || actionCount(row, "onsite_conversion.lead_grouped") || 0;
}
__name(getLeads, "getLeads");
function pctDelta(current, prior) {
  if (!prior) return null;
  return (current - prior) / prior * 100;
}
__name(pctDelta, "pctDelta");
function buildParams(extras, hasRange, timeRange, datePreset) {
  const p = { filtering: FYP_CAMPAIGN_FILTER, ...extras };
  if (hasRange) p.time_range = timeRange;
  else p.date_preset = datePreset;
  return p;
}
__name(buildParams, "buildParams");
async function onRequestGet3(context) {
  const { request, env } = context;
  const waitUntil = typeof context.waitUntil === "function" ? context.waitUntil.bind(context) : (p) => {
    p.catch(() => {
    });
  };
  try {
    if (!env.META_ADS_TOKEN || !env.META_AD_ACCOUNT_ID) {
      return safeError("Meta API not configured");
    }
    const url = new URL(request.url);
    const startParam = url.searchParams.get("start");
    const endParam = url.searchParams.get("end");
    const hasRange = !!(startParam && endParam);
    const cacheKey2 = hasRange ? `range:${startParam}_${endParam}` : "today";
    if (!_cache2.byKey) _cache2.byKey = {};
    const entry = _cache2.byKey[cacheKey2];
    const respond2 = /* @__PURE__ */ __name((body2, xCache) => new Response(body2, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, max-age=0",
        "Access-Control-Allow-Origin": "*",
        "X-Cache": xCache
      }
    }), "respond");
    if (entry?.body) {
      const age = Date.now() - entry.at;
      if (age < CACHE_TTL_MS2) return respond2(entry.body, "HIT-MEM");
      if (!entry.refreshing) {
        entry.refreshing = true;
        waitUntil((async () => {
          try {
            const fresh = await computeSnapshot(env, { startParam, endParam, hasRange });
            _cache2.byKey[cacheKey2] = { at: Date.now(), body: fresh, refreshing: false };
          } catch (_) {
            if (_cache2.byKey[cacheKey2]) _cache2.byKey[cacheKey2].refreshing = false;
          }
        })());
      }
      return respond2(entry.body, "STALE-MEM");
    }
    const body = await computeSnapshot(env, { startParam, endParam, hasRange });
    _cache2.byKey[cacheKey2] = { at: Date.now(), body, refreshing: false };
    return respond2(body, "MISS");
  } catch (e) {
    return safeError(e.message);
  }
}
__name(onRequestGet3, "onRequestGet");
function safeError(msg) {
  return new Response(JSON.stringify({
    ok: false,
    error: msg,
    warming: true,
    spend: 0,
    impressions: 0,
    clicks: 0,
    ctr: 0,
    cpc: 0,
    reach: 0,
    frequency: 0,
    leads: 0,
    cpl: 0,
    compare: null,
    audience: { age: [], gender: [] },
    top_campaigns: [],
    alerts: [],
    recommendations: [],
    daily_spend: [],
    lifetime: null,
    pacing: null,
    generated_at: (/* @__PURE__ */ new Date()).toISOString()
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Cache": "ERROR-SAFE" }
  });
}
__name(safeError, "safeError");
async function computeSnapshot(env, { startParam, endParam, hasRange }) {
  let timeRange = null, compareTr = null, compareLabel = null;
  if (hasRange) {
    timeRange = timeRangeFromIso(startParam, endParam);
    const cw = compareWindow(startParam, endParam);
    compareTr = { since: cw.since, until: cw.until };
    compareLabel = cw.label;
  } else {
    compareLabel = "yesterday";
  }
  const accountFields = "spend,impressions,clicks,ctr,cpc,reach,frequency,actions,cost_per_action_type";
  const campaignFields = "campaign_name,spend,impressions,clicks,ctr,actions,reach,frequency,cost_per_action_type";
  const dailyFields = "spend,impressions,clicks,actions";
  const dailyTimeRange = hasRange ? timeRange : null;
  const dailyPreset = hasRange ? null : "last_14d";
  const calls = [
    // 1) current account aggregate
    fetchInsights(env, buildParams({ fields: accountFields, level: "account" }, hasRange, timeRange, "today")),
    // 2) compare-period account aggregate
    fetchInsights(env, buildParams({ fields: accountFields, level: "account" }, hasRange, compareTr, "yesterday")),
    // 3) campaigns (current)
    fetchInsights(env, buildParams({ fields: campaignFields, level: "campaign", limit: "20" }, hasRange, timeRange, "today")),
    // 4) audience breakdown by age (current)
    fetchInsights(env, buildParams({ fields: "spend,reach,frequency,actions,impressions,clicks,ctr", breakdowns: "age", level: "account" }, hasRange, timeRange, "today")),
    // 5) audience breakdown by gender (current)
    fetchInsights(env, buildParams({ fields: "spend,reach,frequency,actions,impressions,clicks,ctr", breakdowns: "gender", level: "account" }, hasRange, timeRange, "today")),
    // 6) daily breakdown — for spend-over-time chart (time_increment=1)
    fetchInsights(
      env,
      hasRange ? { filtering: FYP_CAMPAIGN_FILTER, fields: dailyFields, level: "account", time_range: dailyTimeRange, time_increment: 1 } : { filtering: FYP_CAMPAIGN_FILTER, fields: dailyFields, level: "account", date_preset: dailyPreset, time_increment: 1 }
    ),
    // 7) FYP-to-date aggregate (since May 1, FYP campaigns only).
    fetchInsights(env, {
      filtering: FYP_CAMPAIGN_FILTER,
      fields: accountFields,
      level: "account",
      time_range: { since: FYP_LAUNCH_DATE, until: ptDateStr(/* @__PURE__ */ new Date()) }
    })
  ];
  const settled = await Promise.allSettled(calls);
  const [curRes, cmpRes, campRes, ageRes, genderRes, dailyRes, lifetimeRes] = settled;
  const unwrap = /* @__PURE__ */ __name((s) => s.status === "fulfilled" ? s.value : [], "unwrap");
  const accountRows = unwrap(curRes);
  const compareRows = unwrap(cmpRes);
  const campaignRows = unwrap(campRes);
  const ageRows = unwrap(ageRes);
  const genderRows = unwrap(genderRes);
  const dailyRows = unwrap(dailyRes);
  const lifetimeRows = unwrap(lifetimeRes);
  const acc = accountRows[0] || {};
  const spend = parseFloat(acc.spend || 0);
  const impressions = parseInt(acc.impressions || 0, 10);
  const clicks = parseInt(acc.clicks || 0, 10);
  const ctr = parseFloat(acc.ctr || 0);
  const cpc = parseFloat(acc.cpc || 0);
  const reach = parseInt(acc.reach || 0, 10);
  const frequency = parseFloat(acc.frequency || 0);
  const leads = getLeads(acc);
  const cpl = leads > 0 ? spend / leads : 0;
  const cmp = compareRows[0] || {};
  const cmpSpend = parseFloat(cmp.spend || 0);
  const cmpClicks = parseInt(cmp.clicks || 0, 10);
  const cmpCtr = parseFloat(cmp.ctr || 0);
  const cmpLeads = getLeads(cmp);
  const cmpCpl = cmpLeads > 0 ? cmpSpend / cmpLeads : 0;
  const compare = cmpSpend > 0 || cmpLeads > 0 ? {
    period_label: compareLabel,
    spend: cmpSpend,
    leads: cmpLeads,
    cpl: cmpCpl,
    ctr: cmpCtr,
    deltas: {
      spend_pct: pctDelta(spend, cmpSpend),
      leads_pct: pctDelta(leads, cmpLeads),
      cpl_pct: pctDelta(cpl, cmpCpl),
      ctr_pct: pctDelta(ctr, cmpCtr)
    }
  } : null;
  const top_campaigns = campaignRows.map((c) => {
    const cSpend = parseFloat(c.spend || 0);
    const cLeads = getLeads(c);
    return {
      name: c.campaign_name || "(unnamed)",
      spend: cSpend,
      impressions: parseInt(c.impressions || 0, 10),
      clicks: parseInt(c.clicks || 0, 10),
      ctr: parseFloat(c.ctr || 0),
      leads: cLeads,
      cpl: cLeads > 0 ? cSpend / cLeads : 0,
      reach: parseInt(c.reach || 0, 10),
      frequency: parseFloat(c.frequency || 0)
    };
  }).sort((a, b) => b.spend - a.spend).slice(0, 10);
  const ageBuckets = ageRows.map((r) => {
    const rSpend = parseFloat(r.spend || 0);
    const rLeads = getLeads(r);
    return {
      key: r.age || "unknown",
      spend: rSpend,
      reach: parseInt(r.reach || 0, 10),
      frequency: parseFloat(r.frequency || 0),
      impressions: parseInt(r.impressions || 0, 10),
      clicks: parseInt(r.clicks || 0, 10),
      ctr: parseFloat(r.ctr || 0),
      leads: rLeads,
      cpl: rLeads > 0 ? rSpend / rLeads : 0
    };
  }).sort((a, b) => b.spend - a.spend);
  const genderBuckets = genderRows.map((r) => {
    const rSpend = parseFloat(r.spend || 0);
    const rLeads = getLeads(r);
    return {
      key: r.gender || "unknown",
      spend: rSpend,
      reach: parseInt(r.reach || 0, 10),
      frequency: parseFloat(r.frequency || 0),
      impressions: parseInt(r.impressions || 0, 10),
      clicks: parseInt(r.clicks || 0, 10),
      ctr: parseFloat(r.ctr || 0),
      leads: rLeads,
      cpl: rLeads > 0 ? rSpend / rLeads : 0
    };
  }).sort((a, b) => b.spend - a.spend);
  const alerts = [];
  for (const c of top_campaigns) {
    if (c.spend > 50 && c.leads >= 5 && c.cpl > TARGET_CPL * 2) {
      alerts.push({
        level: "critical",
        type: "high_cpl_campaign",
        subject: c.name,
        message: `CPL $${c.cpl.toFixed(2)} is ${(c.cpl / TARGET_CPL).toFixed(1)}x target ($${TARGET_CPL.toFixed(2)})`,
        value: c.cpl
      });
    }
  }
  for (const c of top_campaigns) {
    if (c.reach > 1e3) {
      if (c.frequency > 3.5) {
        alerts.push({
          level: "critical",
          type: "frequency_saturated",
          subject: c.name,
          message: `Frequency ${c.frequency.toFixed(2)} \u2014 audience is burned out. Refresh creative or expand audience.`,
          value: c.frequency
        });
      } else if (c.frequency > 2.5) {
        alerts.push({
          level: "warning",
          type: "frequency_approaching",
          subject: c.name,
          message: `Frequency ${c.frequency.toFixed(2)} \u2014 approaching fatigue. Monitor CTR for decay.`,
          value: c.frequency
        });
      }
    }
  }
  for (const a of ageBuckets) {
    if (a.reach > 1e3) {
      if (a.frequency > 3.5) {
        alerts.push({
          level: "critical",
          type: "audience_saturated",
          subject: `age ${a.key}`,
          message: `Frequency ${a.frequency.toFixed(2)} on ${a.key} bracket \u2014 saturated.`,
          value: a.frequency
        });
      } else if (a.frequency > 2.5) {
        alerts.push({
          level: "warning",
          type: "audience_approaching",
          subject: `age ${a.key}`,
          message: `Frequency ${a.frequency.toFixed(2)} on ${a.key} bracket \u2014 fatigue brewing.`,
          value: a.frequency
        });
      }
    }
  }
  if (compare && cmpLeads >= 10 && cpl > 0 && cmpCpl > 0) {
    const cplDelta = pctDelta(cpl, cmpCpl);
    if (cplDelta > 25) {
      alerts.push({
        level: "warning",
        type: "cpl_trending_up",
        subject: "account aggregate",
        message: `CPL up ${cplDelta.toFixed(0)}% vs ${compareLabel} ($${cmpCpl.toFixed(2)} \u2192 $${cpl.toFixed(2)})`,
        value: cplDelta
      });
    }
  }
  const recommendations = [];
  for (const c of top_campaigns) {
    if (c.spend > 50 && c.leads >= 5 && c.cpl > TARGET_CPL * 2) {
      recommendations.push({
        action: "PAUSE",
        subject: c.name,
        rationale: `CPL $${c.cpl.toFixed(2)} is ${(c.cpl / TARGET_CPL).toFixed(1)}x target ($${TARGET_CPL.toFixed(2)}). Volume: $${c.spend.toFixed(0)} spent on ${c.leads} leads \u2014 past the small-sample threshold.`,
        confidence: c.spend > 150 ? "high" : "medium",
        suggested_delta: "-100% (pause)"
      });
    }
  }
  for (const c of top_campaigns) {
    if (c.reach > 1e3 && c.frequency > 3.5) {
      if (recommendations.find((r) => r.subject === c.name)) continue;
      recommendations.push({
        action: "PAUSE",
        subject: c.name,
        rationale: `Frequency ${c.frequency.toFixed(2)} \u2014 audience burned out. Either refresh creative + relaunch, or expand audience and resume.`,
        confidence: "high",
        suggested_delta: "-100% (pause + refresh)"
      });
    }
  }
  for (const c of top_campaigns) {
    if (c.spend > 30 && c.leads >= 10 && c.cpl < TARGET_CPL * 1.2 && c.frequency < 2) {
      if (recommendations.find((r) => r.subject === c.name)) continue;
      recommendations.push({
        action: "SCALE",
        subject: c.name,
        rationale: `CPL $${c.cpl.toFixed(2)} \u2264 1.2x target. Frequency ${c.frequency.toFixed(2)} = room to grow (not yet saturated). Volume: $${c.spend.toFixed(0)} on ${c.leads} leads.`,
        confidence: c.spend > 100 ? "high" : "medium",
        suggested_delta: "+25% budget"
      });
    }
  }
  for (const c of top_campaigns) {
    if (c.spend > 30 && c.leads === 0) {
      if (recommendations.find((r) => r.subject === c.name)) continue;
      recommendations.push({
        action: "INVESTIGATE",
        subject: c.name,
        rationale: `$${c.spend.toFixed(0)} spent with 0 leads. Pixel/CAPI broken on this campaign's landing, or audience mismatch.`,
        confidence: "high",
        suggested_delta: "diagnose first, pause if confirmed broken"
      });
    }
  }
  for (const a of ageBuckets) {
    if (a.spend > 30 && a.leads >= 10 && a.cpl < TARGET_CPL * 1.2 && a.frequency < 2) {
      recommendations.push({
        action: "BOOST AUDIENCE",
        subject: `age ${a.key}`,
        rationale: `${a.key} bracket converting at $${a.cpl.toFixed(2)} CPL. Reach ${a.reach.toLocaleString()}, frequency ${a.frequency.toFixed(2)} \u2014 room to grow. Consider lookalike off this bracket.`,
        confidence: "medium",
        suggested_delta: "build 1% LAL from this segment"
      });
    }
  }
  for (const a of ageBuckets) {
    if (a.spend > 30 && (a.leads === 0 || a.cpl > TARGET_CPL * 3)) {
      recommendations.push({
        action: "EXCLUDE AUDIENCE",
        subject: `age ${a.key}`,
        rationale: `$${a.spend.toFixed(0)} spent, ${a.leads ? `CPL $${a.cpl.toFixed(2)} (${(a.cpl / TARGET_CPL).toFixed(1)}x target)` : "0 conversions"}. Exclude this bracket from active ad sets.`,
        confidence: "high",
        suggested_delta: "exclude from all active ad sets"
      });
    }
  }
  const actionPriority = { "PAUSE": 1, "INVESTIGATE": 2, "EXCLUDE AUDIENCE": 3, "SCALE": 4, "BOOST AUDIENCE": 5 };
  recommendations.sort((a, b) => {
    const conf = { high: 1, medium: 2, low: 3 };
    return conf[a.confidence] - conf[b.confidence] || actionPriority[a.action] - actionPriority[b.action];
  });
  const daily_spend = dailyRows.map((r) => {
    const dSpend = parseFloat(r.spend || 0);
    const dLeads = getLeads(r);
    return {
      date: r.date_start,
      spend: dSpend,
      impressions: parseInt(r.impressions || 0, 10),
      clicks: parseInt(r.clicks || 0, 10),
      leads: dLeads,
      cpl: dLeads > 0 ? dSpend / dLeads : 0
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const lifeRow = lifetimeRows[0] || {};
  const lifeSpend = parseFloat(lifeRow.spend || 0);
  const lifeLeads = getLeads(lifeRow);
  const lifetime = {
    spend: lifeSpend,
    impressions: parseInt(lifeRow.impressions || 0, 10),
    clicks: parseInt(lifeRow.clicks || 0, 10),
    leads: lifeLeads,
    cpl: lifeLeads > 0 ? lifeSpend / lifeLeads : 0,
    ctr: parseFloat(lifeRow.ctr || 0),
    reach: parseInt(lifeRow.reach || 0, 10),
    frequency: parseFloat(lifeRow.frequency || 0)
  };
  const targetLeads = parseInt(env.META_PAID_LEAD_TARGET || DEFAULT_PAID_LEAD_TARGET, 10);
  const todayPt = ptDateStr(/* @__PURE__ */ new Date());
  const completeDays = daily_spend.filter((d) => d.date < todayPt && d.spend > 0);
  const avgDailyLeads = completeDays.length > 0 ? completeDays.reduce((s, d) => s + d.leads, 0) / completeDays.length : 0;
  const todayMs = Date.parse(todayPt + "T00:00:00Z");
  const eventMs = Date.parse(FYP_EVENT_START_DATE + "T00:00:00Z");
  const daysRemaining = Math.max(0, Math.round((eventMs - todayMs) / 864e5));
  const projectedTotal = lifeLeads + Math.round(avgDailyLeads * daysRemaining);
  const pctToTarget = targetLeads > 0 ? lifeLeads / targetLeads * 100 : 0;
  const projectedPct = targetLeads > 0 ? projectedTotal / targetLeads * 100 : 0;
  const pacing = {
    target_leads: targetLeads,
    leads_to_date: lifeLeads,
    pct_to_target: pctToTarget,
    avg_daily_leads_complete_days: avgDailyLeads,
    complete_days_count: completeDays.length,
    days_remaining: daysRemaining,
    event_start_date: FYP_EVENT_START_DATE,
    projected_total_leads: projectedTotal,
    projected_pct: projectedPct,
    on_track: projectedTotal >= targetLeads,
    leads_needed_per_day: daysRemaining > 0 ? Math.max(0, Math.ceil((targetLeads - lifeLeads) / daysRemaining)) : 0
  };
  return JSON.stringify({
    ok: true,
    spend,
    impressions,
    clicks,
    ctr,
    cpc,
    reach,
    frequency,
    leads,
    cpl,
    compare,
    audience: { age: ageBuckets, gender: genderBuckets },
    top_campaigns,
    alerts,
    recommendations,
    daily_spend,
    lifetime,
    pacing,
    target_cpl: TARGET_CPL,
    range: hasRange ? { start: startParam, end: endParam } : null,
    timezone: "America/Los_Angeles",
    generated_at: (/* @__PURE__ */ new Date()).toISOString()
  }, null, 2);
}
__name(computeSnapshot, "computeSnapshot");

// api/register.js
var TIER1_STATES = /* @__PURE__ */ new Set(["TX", "CA", "FL"]);
var WELCOME_SMS_BODY = "Heart of Dating: You're in for the Find Your Person Challenge! Save this number \u2014 we'll text you 1hr before each night. Reply STOP to opt out, HELP for help.";
function toE164US(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (String(raw).trim().startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}
__name(toE164US, "toE164US");
async function sendWelcomeSMS(env, { phone, smsOptIn, contactId }) {
  if (env.TELNYX_LIVE !== "true") return;
  if (!smsOptIn) return;
  if (!env.TELNYX_API_KEY || !env.TELNYX_FROM_NUMBER || !env.TELNYX_MESSAGING_PROFILE_ID) {
    console.log(`telnyx welcome skipped (config missing) contact=${contactId}`);
    return;
  }
  const to = toE164US(phone);
  if (!to) {
    console.log(`telnyx welcome skipped (phone not E.164) contact=${contactId}`);
    return;
  }
  const r = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TELNYX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.TELNYX_FROM_NUMBER,
      to,
      text: WELCOME_SMS_BODY,
      messaging_profile_id: env.TELNYX_MESSAGING_PROFILE_ID
    })
  });
  if (!r.ok) {
    const errTxt = await r.text();
    console.log(`telnyx welcome send failed contact=${contactId} status=${r.status} body=${errTxt.slice(0, 300)}`);
  } else {
    console.log(`telnyx welcome sent contact=${contactId} to=${to}`);
  }
}
__name(sendWelcomeSMS, "sendWelcomeSMS");
var TAGS_ALWAYS = ["FYP-Overall"];
var CHANNEL_TAG = { paid: "FYP-Paid", organic: "FYP-Organic" };
var CUSTOM_FIELD_IDS = {
  birth_year: 17,
  // %BIRTH_YEAR%
  state: 18,
  // %STATE%
  sms_optin: 19
  // %SMS_OPTIN% — "yes"/"no"
};
function bad(msg, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
__name(bad, "bad");
async function ac3(env, path, init = {}) {
  const url = `${env.AC_API_URL.replace(/\/$/, "")}/api/3${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      "Api-Token": env.AC_API_KEY,
      "Content-Type": "application/json",
      ...init.headers || {}
    }
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { ok: r.ok, status: r.status, body };
}
__name(ac3, "ac");
async function onRequestPost2(context) {
  const { request, env } = context;
  const waitUntil = typeof context.waitUntil === "function" ? context.waitUntil.bind(context) : null;
  if (!env.AC_API_URL || !env.AC_API_KEY) {
    return bad("Server not configured: AC_API_URL or AC_API_KEY missing", 500);
  }
  let payload;
  try {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      payload = await request.json();
    } else {
      const form = await request.formData();
      payload = Object.fromEntries(form.entries());
    }
  } catch {
    return bad("Could not parse request body");
  }
  const fname = (payload.fname || "").trim();
  const lname = (payload.lname || "").trim();
  const email = (payload.email || "").trim().toLowerCase();
  const phone = (payload.phone || "").trim();
  const byear = (payload.byear || "").trim();
  const state = (payload.state || "").trim().toUpperCase();
  const sms = payload.sms === "on" || payload.sms === true || payload.sms === "true" || payload.sms === "1";
  const srcRaw = (payload.src || payload.utm_medium || "").trim().toLowerCase();
  const src = srcRaw === "paid" ? "paid" : "organic";
  const lpRaw = (payload.lp_variant || "v1").toString().trim().toLowerCase();
  const lpVariant = lpRaw === "v2" ? "v2" : "v1";
  if (!fname || !lname || !email || !phone || !byear || !state) {
    return bad("Missing required field");
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) return bad("Invalid email");
  if (!/^\d{4}$/.test(byear)) return bad("Birth year must be 4 digits");
  const contactResp = await ac3(env, "/contact/sync", {
    method: "POST",
    body: JSON.stringify({
      contact: {
        email,
        firstName: fname,
        lastName: lname,
        phone,
        fieldValues: [
          { field: CUSTOM_FIELD_IDS.birth_year, value: byear },
          { field: CUSTOM_FIELD_IDS.state, value: state },
          { field: CUSTOM_FIELD_IDS.sms_optin, value: sms ? "yes" : "no" }
        ]
      }
    })
  });
  if (!contactResp.ok) {
    return bad(`AC contact sync failed: ${contactResp.status}`, 502);
  }
  const contactId = contactResp.body?.contact?.id;
  if (!contactId) return bad("AC sync returned no contact id", 502);
  if (env.AC_LIST_ID) {
    await ac3(env, "/contactLists", {
      method: "POST",
      body: JSON.stringify({
        contactList: { list: env.AC_LIST_ID, contact: contactId, status: 1 }
      })
    });
  }
  const tagsToApply = [...TAGS_ALWAYS];
  tagsToApply.push(CHANNEL_TAG[src]);
  tagsToApply.push(TIER1_STATES.has(state) ? "Region_Tier1" : "Region_Tier2");
  if (sms) tagsToApply.push("SMS_Optin_Yes");
  tagsToApply.push(`LP-${lpVariant}`);
  let emailHash = 0;
  for (let i = 0; i < email.length; i++) {
    emailHash = (emailHash << 5) - emailHash + email.charCodeAt(i) | 0;
  }
  const vipVariant = Math.abs(emailHash) % 2 === 0 ? "v1" : "v2";
  const vipPath = vipVariant === "v2" ? "/fyp/vip-paid" : "/fyp/vip";
  tagsToApply.push(`VIP-${vipVariant}`);
  await Promise.all(tagsToApply.map(async (tagName) => {
    let tagId;
    const search = await ac3(env, `/tags?search=${encodeURIComponent(tagName)}`);
    const existing = (search.body?.tags || []).find((t) => t.tag === tagName);
    if (existing) {
      tagId = existing.id;
    } else {
      const created = await ac3(env, "/tags", {
        method: "POST",
        body: JSON.stringify({ tag: { tag: tagName, tagType: "contact", description: "FYP May 2026 auto-tag" } })
      });
      tagId = created.body?.tag?.id;
    }
    if (tagId) {
      await ac3(env, "/contactTags", {
        method: "POST",
        body: JSON.stringify({ contactTag: { contact: contactId, tag: tagId } })
      });
    }
  }));
  if (env.META_CAPI_TOKEN && env.META_PIXEL_ID) {
    try {
      const eventId = (payload.event_id || `completeregistration_${email}_${Date.now()}`).slice(0, 256);
      const eventTime = Math.floor(Date.now() / 1e3);
      const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
      const userAgent = request.headers.get("user-agent") || "";
      const sourceUrl = request.headers.get("referer") || "https://fyp.heartofdating.com/fyp/";
      const sha256Hex = /* @__PURE__ */ __name(async (s) => {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.toLowerCase().trim()));
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      }, "sha256Hex");
      const normPhone = phone.replace(/\D/g, "");
      const userData = {
        em: [await sha256Hex(email)],
        ph: normPhone ? [await sha256Hex(normPhone)] : void 0,
        client_ip_address: clientIp,
        client_user_agent: userAgent,
        fbc: payload.fbc || void 0,
        fbp: payload.fbp || void 0
      };
      Object.keys(userData).forEach((k) => userData[k] === void 0 && delete userData[k]);
      const capiBody = {
        data: [{
          event_name: "CompleteRegistration",
          event_time: eventTime,
          event_id: eventId,
          action_source: "website",
          event_source_url: sourceUrl,
          user_data: userData,
          custom_data: {
            content_name: "FYP May 2026 Registration",
            content_category: src
            // "paid" | "organic"
          }
        }]
      };
      const capiResp = await fetch(
        `https://graph.facebook.com/v19.0/${env.META_PIXEL_ID}/events?access_token=${env.META_CAPI_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(capiBody)
        }
      );
      if (!capiResp.ok) {
        console.log(`CAPI CompleteRegistration failed for contact ${contactId}: ${capiResp.status}`);
      }
    } catch (e) {
      console.log(`CAPI CompleteRegistration error for contact ${contactId}: ${e.message}`);
    }
  }
  const smsTask = sendWelcomeSMS(env, { phone, smsOptIn: sms, contactId }).catch((e) => {
    console.log(`telnyx welcome error contact=${contactId}: ${e?.message || e}`);
  });
  if (waitUntil) waitUntil(smsTask);
  return new Response(JSON.stringify({ ok: true, contact: contactId, redirect: `${vipPath}?src=${src}` }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
__name(onRequestPost2, "onRequestPost");
function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
__name(onRequestOptions, "onRequestOptions");

// api/scholarship-enter.js
var REQUIRED = ["CROISSANT", "BONJOUR", "ESCARGOT", "BERET"];
var CORS = {
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
__name(json, "json");
async function onRequestOptions2() {
  return new Response(null, { status: 204, headers: CORS });
}
__name(onRequestOptions2, "onRequestOptions");
async function onRequestPost3({ request, env }) {
  if (!env.SCHOLARSHIP) return json({ ok: false, error: "KV not bound" }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }
  const name = String(body.name || "").trim().slice(0, 80);
  const words = Array.isArray(body.codeWords) ? body.codeWords.map((w) => String(w || "").trim().toUpperCase()) : [];
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
  return json({ ok: true, key, message: "You're in the pool! \u{1F389}" });
}
__name(onRequestPost3, "onRequestPost");

// api/_click_diag.js
async function onRequest({ env }) {
  const sql = `SELECT toStartOfMinute(timestamp) AS minute, COUNT() AS clicks
               FROM ab_test_visitors
               WHERE blob1 = 'sms_click_n1'
                 AND timestamp >= toDateTime('2026-05-27 00:05:00')
                 AND timestamp <= toDateTime('2026-05-27 01:05:00')
               GROUP BY minute
               ORDER BY minute
               FORMAT JSON`;
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    { method: "POST", headers: { "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "text/plain" }, body: sql }
  );
  return new Response(await r.text(), { headers: { "content-type": "application/json" } });
}
__name(onRequest, "onRequest");

// api/fyp-visits.js
function isoDay2(d) {
  return d.toISOString().slice(0, 10);
}
__name(isoDay2, "isoDay");
async function onRequest2({ env }) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) {
    return new Response(JSON.stringify({ error: "missing CF creds" }), { status: 500 });
  }
  const today = isoDay2(/* @__PURE__ */ new Date());
  const yesterday = isoDay2(new Date(Date.now() - 864e5));
  const query = `query {
    viewer {
      accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) {
        rumPageloadEventsAdaptiveGroups(
          limit: 100,
          filter: {
            date_geq: "${yesterday}",
            date_leq: "${today}",
            requestPath_like: "/fyp/%"
          }
        ) {
          count
          sum { visits }
          dimensions { date requestPath }
        }
      }
    }
  }`;
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query })
  });
  const j = await r.json();
  const rows = j?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
  const out = {
    today: { pageviews: 0, visits: 0 },
    yesterday: { pageviews: 0, visits: 0 },
    by_path: {}
  };
  for (const row of rows) {
    const d = row?.dimensions?.date;
    const path = row?.dimensions?.requestPath || "(unknown)";
    const c = row?.count || 0;
    const v = row?.sum?.visits || 0;
    if (d === today) {
      out.today.pageviews += c;
      out.today.visits += v;
    } else if (d === yesterday) {
      out.yesterday.pageviews += c;
      out.yesterday.visits += v;
    }
    out.by_path[path] = (out.by_path[path] || 0) + c;
  }
  return new Response(JSON.stringify(out, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
}
__name(onRequest2, "onRequest");

// api/scholarship-list.js
async function onRequest3({ env }) {
  if (!env.SCHOLARSHIP) {
    return json2({ ok: false, error: "KV not bound" }, 500);
  }
  const list = await env.SCHOLARSHIP.list({ prefix: "schol:", limit: 1e3 });
  const entries = await Promise.all(
    list.keys.map(async (k) => {
      try {
        const v = await env.SCHOLARSHIP.get(k.name);
        if (!v) return null;
        const parsed = JSON.parse(v);
        return { name: parsed.name, enteredAt: parsed.enteredAt };
      } catch {
        return null;
      }
    })
  );
  const valid = entries.filter(Boolean).sort((a, b) => (b.enteredAt || "").localeCompare(a.enteredAt || ""));
  return json2({
    ok: true,
    count: valid.length,
    entries: valid,
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
  }, 200, {
    // Edge cache 2s so 2K viewers don't hammer KV
    "cache-control": "public, max-age=2"
  });
}
__name(onRequest3, "onRequest");
function json2(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extra
    }
  });
}
__name(json2, "json");

// api/sod-counts.js
var AC_URL = "https://kaitness.api-us1.com/api/3";
var TAG_SOD = 193;
var TAG_SOD_PRO = 194;
var CAP_TOTAL = 200;
var CAP_FAB = 60;
var FAB_BASELINE = CAP_TOTAL - CAP_FAB;
var PRE_EXISTING = 24;
var CART_CLOSE_UTC = "2026-05-30T02:00:00Z";
async function onRequest4({ env }) {
  const KEY = env.AC_API_KEY;
  if (!KEY) {
    return json3({ error: "AC_API_KEY not set" }, 500);
  }
  async function ac4(path) {
    const r = await fetch(`${AC_URL}${path}`, {
      headers: { "Api-Token": KEY },
      cf: { cacheTtl: 5 }
    });
    if (!r.ok) throw new Error(`AC ${r.status} on ${path}`);
    return r.json();
  }
  __name(ac4, "ac");
  try {
    const sodMeta = await ac4(`/contacts?tagid=${TAG_SOD}&limit=1`);
    const sodTotal = parseInt(sodMeta.meta?.total || 0);
    const proMeta = await ac4(`/contacts?tagid=${TAG_SOD_PRO}&limit=1`);
    const proTotal = parseInt(proMeta.meta?.total || 0);
    const ctRes = await ac4(
      `/contacts?tagid=${TAG_SOD}&orders%5Bcdate%5D=DESC&limit=250`
    );
    const recentSignups = (ctRes.contacts || []).map((c) => ({
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
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return json3(body, 200, {
      "cache-control": "public, max-age=5",
      "access-control-allow-origin": "*"
    });
  } catch (e) {
    return json3({ ok: false, error: String(e).slice(0, 200) }, 500);
  }
}
__name(onRequest4, "onRequest");
function json3(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}
__name(json3, "json");

// admin/_middleware.js
var COOKIE_NAME2 = "hod_admin";
var COOKIE_VALUE2 = "ok-jjcool-2026";
async function onRequest5({ request, next }) {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/login.html") || url.pathname.endsWith("/login")) {
    return next();
  }
  const cookies = request.headers.get("Cookie") || "";
  const match2 = cookies.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME2}=([^;]+)`));
  if (match2 && match2[1] === COOKIE_VALUE2) {
    return next();
  }
  return Response.redirect(new URL("/admin/login.html", request.url).toString(), 302);
}
__name(onRequest5, "onRequest");

// fyp/_middleware.js
var COOKIE_NAME3 = "lp_assigned";
var COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
function readCookie(req, name) {
  const header = req.headers.get("Cookie") || "";
  const match2 = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match2 ? match2[1] : null;
}
__name(readCookie, "readCookie");
async function onRequest6(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);
  const isRoot = url.pathname === "/fyp" || url.pathname === "/fyp/" || url.pathname === "/fyp/index.html";
  if (!isRoot) return next();
  const existingCookie = readCookie(request, COOKIE_NAME3);
  let variant = existingCookie;
  const isNewAssignment = variant !== "v1" && variant !== "v2";
  if (isNewAssignment) {
    variant = Math.random() < 0.5 ? "v1" : "v2";
    try {
      env.AB_ANALYTICS?.writeDataPoint({
        blobs: [variant],
        // blob1 = variant — group by this in SQL
        doubles: [1],
        // doubles1 = visitor count (1 per datapoint)
        indexes: [variant]
        // sampling index — keeps per-variant fidelity
      });
    } catch (_) {
    }
  }
  let response;
  if (variant === "v2") {
    const v2Url = new URL(request.url);
    v2Url.pathname = "/fyp/v2/";
    const upstream = await fetch(v2Url.toString(), {
      headers: request.headers
    });
    const body = await upstream.arrayBuffer();
    response = new Response(body, {
      status: upstream.status,
      headers: new Headers(upstream.headers)
    });
    response.headers.set("Content-Type", "text/html; charset=utf-8");
  } else {
    response = await next();
    response = new Response(response.body, response);
  }
  if (!readCookie(request, COOKIE_NAME3)) {
    response.headers.append(
      "Set-Cookie",
      `${COOKIE_NAME3}=${variant}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; Secure`
    );
  }
  response.headers.set("X-LP-Variant", variant);
  return response;
}
__name(onRequest6, "onRequest");

// _lib/click-redirect.js
function logAndRedirect(context, label, zoomUrl) {
  const { env, request } = context;
  try {
    env.AB_ANALYTICS?.writeDataPoint({
      blobs: [label],
      doubles: [1],
      indexes: [label]
    });
  } catch (_) {
  }
  const incomingQs = new URL(request.url).search;
  const target = incomingQs ? `${zoomUrl}${zoomUrl.includes("?") ? "&" : "?"}${incomingQs.slice(1)}` : zoomUrl;
  return Response.redirect(target, 302);
}
__name(logAndRedirect, "logAndRedirect");
var ZOOM_FYP = "https://us02web.zoom.us/j/9852476403?pwd=Vc8ePcE59HBd75MAmVa58jg5GSQPte.1&omn=84007480572";
var ZOOM_VIP = "https://us02web.zoom.us/j/9852476403?pwd=Vc8ePcE59HBd75MAmVa58jg5GSQPte.1&omn=89437962456";

// FYPN1.js
var onRequest7 = /* @__PURE__ */ __name((ctx) => logAndRedirect(ctx, "sms_click_n1", ZOOM_FYP), "onRequest");

// FYPN2.js
var onRequest8 = /* @__PURE__ */ __name((ctx) => logAndRedirect(ctx, "sms_click_n2", ZOOM_FYP), "onRequest");

// FYPN3.js
var onRequest9 = /* @__PURE__ */ __name((ctx) => logAndRedirect(ctx, "sms_click_n3", ZOOM_FYP), "onRequest");

// FYPN4.js
var onRequest10 = /* @__PURE__ */ __name((ctx) => logAndRedirect(ctx, "sms_click_n4", ZOOM_FYP), "onRequest");

// FYPVIP.js
var onRequest11 = /* @__PURE__ */ __name((ctx) => logAndRedirect(ctx, "sms_click_vip", ZOOM_VIP), "onRequest");

// ../.wrangler/tmp/pages-xv5yD7/functionsRoutes-0.8001141524247317.mjs
var routes = [
  {
    routePath: "/api/admin-login",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost]
  },
  {
    routePath: "/api/dashboard",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet]
  },
  {
    routePath: "/api/dashboard-search",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet2]
  },
  {
    routePath: "/api/meta-ads",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet3]
  },
  {
    routePath: "/api/register",
    mountPath: "/api",
    method: "OPTIONS",
    middlewares: [],
    modules: [onRequestOptions]
  },
  {
    routePath: "/api/register",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost2]
  },
  {
    routePath: "/api/scholarship-enter",
    mountPath: "/api",
    method: "OPTIONS",
    middlewares: [],
    modules: [onRequestOptions2]
  },
  {
    routePath: "/api/scholarship-enter",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost3]
  },
  {
    routePath: "/api/_click_diag",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest]
  },
  {
    routePath: "/api/fyp-visits",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest2]
  },
  {
    routePath: "/api/scholarship-list",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest3]
  },
  {
    routePath: "/api/sod-counts",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest4]
  },
  {
    routePath: "/admin",
    mountPath: "/admin",
    method: "",
    middlewares: [onRequest5],
    modules: []
  },
  {
    routePath: "/fyp",
    mountPath: "/fyp",
    method: "",
    middlewares: [onRequest6],
    modules: []
  },
  {
    routePath: "/FYPN1",
    mountPath: "/",
    method: "",
    middlewares: [],
    modules: [onRequest7]
  },
  {
    routePath: "/FYPN2",
    mountPath: "/",
    method: "",
    middlewares: [],
    modules: [onRequest8]
  },
  {
    routePath: "/FYPN3",
    mountPath: "/",
    method: "",
    middlewares: [],
    modules: [onRequest9]
  },
  {
    routePath: "/FYPN4",
    mountPath: "/",
    method: "",
    middlewares: [],
    modules: [onRequest10]
  },
  {
    routePath: "/FYPVIP",
    mountPath: "/",
    method: "",
    middlewares: [],
    modules: [onRequest11]
  }
];

// ../../../../../opt/homebrew/lib/node_modules/wrangler/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../../../../opt/homebrew/lib/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
export {
  pages_template_worker_default as default
};
