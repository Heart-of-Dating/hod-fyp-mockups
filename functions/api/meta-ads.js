// Meta Marketing API integration — pulls ads insights for the dashboard.
//
// GET /api/meta-ads                           → today PT (ad-account-aligned)
// GET /api/meta-ads?start=ISO&end=ISO         → custom range (matches dashboard)
//
// Returns: {
//   spend, impressions, clicks, ctr, cpc, reach, frequency, leads, cpl,
//   compare: { period_label, spend, leads, cpl, ctr, deltas: { spend_pct, leads_pct, cpl_pct, ctr_pct } },
//   audience: { age: [...], gender: [...] },
//   top_campaigns: [ { name, spend, clicks, ctr, leads, cpl, frequency, reach } ],
//   alerts: [ { level, type, subject, message, value } ],
//   recommendations: [ { action, subject, rationale, confidence, suggested_delta } ],
//   range, timezone, generated_at
// }
//
// Secrets required (CF Pages):
//   META_ADS_TOKEN, META_AD_ACCOUNT_ID

const META_API_VERSION = "v19.0";
const TARGET_CPL = 1.79; // From James's May 2026 brief — used for rec thresholds
const FYP_LAUNCH_DATE = "2026-05-01"; // FYP May 2026 paid funnel started
const FYP_EVENT_START_DATE = "2026-05-26"; // Night 1 of FYP — "must hit target by" date
const DEFAULT_PAID_LEAD_TARGET = 15500; // From James's brief: 4.5K organic + 15.5K paid = 20K total. Overridable via env.META_PAID_LEAD_TARGET
// Campaign-name filter to scope ALL metrics to FYP May 2026 only.
// HOD ad account is shared across podcast/SOD/BOD/other events — without this
// filter we'd mix in non-FYP spend. All current FYP campaigns are named
// "JSC - FYP Challenge 2026 MAY 26-29 ..." so "FYP Challenge 2026" matches all.
const FYP_CAMPAIGN_FILTER = JSON.stringify([{
  field: "campaign.name",
  operator: "CONTAIN",
  value: "FYP Challenge 2026",
}]);

// SWR cache (90s). Per-cacheKey isolation so range + today don't evict each other.
let _cache = { byKey: {} };
const CACHE_TTL_MS = 90 * 1000;

function ptDateStr(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function timeRangeFromIso(startIso, endIso) {
  return { since: ptDateStr(new Date(startIso)), until: ptDateStr(new Date(endIso)) };
}

// Previous-equal-length window (e.g. yesterday for "today", prior 3 days for a 3-day range)
function compareWindow(startIso, endIso) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const spanMs = endMs - startMs;
  const compareEnd = new Date(startMs - 1);
  const compareStart = new Date(startMs - spanMs - 1);
  return {
    since: ptDateStr(compareStart),
    until: ptDateStr(compareEnd),
    label: spanHoursLabel(spanMs),
  };
}

function spanHoursLabel(spanMs) {
  const hours = Math.round(spanMs / 3600000);
  if (hours <= 24) return "previous day";
  if (hours <= 48) return "previous 2 days";
  const days = Math.round(hours / 24);
  return `previous ${days} days`;
}

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

function actionCount(row, type) {
  const m = (row?.actions || []).find(a => a.action_type === type);
  return m ? parseInt(m.value, 10) : 0;
}
function getLeads(row) {
  return actionCount(row, "complete_registration")
      || actionCount(row, "lead")
      || actionCount(row, "onsite_conversion.lead_grouped")
      || 0;
}
function pctDelta(current, prior) {
  if (!prior) return null; // can't compute % from zero baseline
  return ((current - prior) / prior) * 100;
}

// Build common insight params with optional time_range / date_preset.
// ALWAYS applies the FYP campaign-name filter so account-level aggregates
// don't include HOD's other campaigns (podcast promos, BOD, SOD, etc.)
// running on the same ad account.
function buildParams(extras, hasRange, timeRange, datePreset) {
  const p = { filtering: FYP_CAMPAIGN_FILTER, ...extras };
  if (hasRange) p.time_range = timeRange;
  else p.date_preset = datePreset;
  return p;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const waitUntil = typeof context.waitUntil === "function"
    ? context.waitUntil.bind(context)
    : (p) => { p.catch(() => {}); };

  try {
    if (!env.META_ADS_TOKEN || !env.META_AD_ACCOUNT_ID) {
      return safeError("Meta API not configured");
    }

    const url = new URL(request.url);
    const startParam = url.searchParams.get("start");
    const endParam = url.searchParams.get("end");
    const hasRange = !!(startParam && endParam);

    const cacheKey = hasRange ? `range:${startParam}_${endParam}` : "today";
    if (!_cache.byKey) _cache.byKey = {};
    const entry = _cache.byKey[cacheKey];

    const respond = (body, xCache) => new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, max-age=0",
        "Access-Control-Allow-Origin": "*",
        "X-Cache": xCache,
      },
    });

    // SWR
    if (entry?.body) {
      const age = Date.now() - entry.at;
      if (age < CACHE_TTL_MS) return respond(entry.body, "HIT-MEM");
      if (!entry.refreshing) {
        entry.refreshing = true;
        waitUntil((async () => {
          try {
            const fresh = await computeSnapshot(env, { startParam, endParam, hasRange });
            _cache.byKey[cacheKey] = { at: Date.now(), body: fresh, refreshing: false };
          } catch (_) {
            if (_cache.byKey[cacheKey]) _cache.byKey[cacheKey].refreshing = false;
          }
        })());
      }
      return respond(entry.body, "STALE-MEM");
    }

    const body = await computeSnapshot(env, { startParam, endParam, hasRange });
    _cache.byKey[cacheKey] = { at: Date.now(), body, refreshing: false };
    return respond(body, "MISS");
  } catch (e) {
    return safeError(e.message);
  }
}

function safeError(msg) {
  return new Response(JSON.stringify({
    ok: false, error: msg, warming: true,
    spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, reach: 0, frequency: 0, leads: 0, cpl: 0,
    compare: null, audience: { age: [], gender: [] }, top_campaigns: [],
    alerts: [], recommendations: [],
    daily_spend: [], lifetime: null, pacing: null,
    generated_at: new Date().toISOString(),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Cache": "ERROR-SAFE" },
  });
}

async function computeSnapshot(env, { startParam, endParam, hasRange }) {
  // Time-range objects (current + compare)
  let timeRange = null, compareTr = null, compareLabel = null;
  if (hasRange) {
    timeRange = timeRangeFromIso(startParam, endParam);
    const cw = compareWindow(startParam, endParam);
    compareTr = { since: cw.since, until: cw.until };
    compareLabel = cw.label;
  } else {
    // "today" — compare against yesterday
    compareLabel = "yesterday";
  }

  // Parallel Graph calls
  const accountFields = "spend,impressions,clicks,ctr,cpc,reach,frequency,actions,cost_per_action_type";
  const campaignFields = "campaign_name,spend,impressions,clicks,ctr,actions,reach,frequency,cost_per_action_type";
  const dailyFields = "spend,impressions,clicks,actions";

  // Daily-spend window: in range mode use the user's range; in live mode show
  // trailing 14 days for context (sees the full launch ramp).
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
    fetchInsights(env,
      hasRange
        ? { filtering: FYP_CAMPAIGN_FILTER, fields: dailyFields, level: "account", time_range: dailyTimeRange, time_increment: 1 }
        : { filtering: FYP_CAMPAIGN_FILTER, fields: dailyFields, level: "account", date_preset: dailyPreset, time_increment: 1 }),
    // 7) FYP-to-date aggregate (since May 1, FYP campaigns only).
    fetchInsights(env, {
      filtering: FYP_CAMPAIGN_FILTER,
      fields: accountFields,
      level: "account",
      time_range: { since: FYP_LAUNCH_DATE, until: ptDateStr(new Date()) },
    }),
  ];

  const settled = await Promise.allSettled(calls);
  const [curRes, cmpRes, campRes, ageRes, genderRes, dailyRes, lifetimeRes] = settled;

  // Helper to unwrap a settled promise to its data (empty array on failure)
  const unwrap = (s) => (s.status === "fulfilled" ? s.value : []);
  const accountRows = unwrap(curRes);
  const compareRows = unwrap(cmpRes);
  const campaignRows = unwrap(campRes);
  const ageRows = unwrap(ageRes);
  const genderRows = unwrap(genderRes);
  const dailyRows = unwrap(dailyRes);
  const lifetimeRows = unwrap(lifetimeRes);

  // ---- Account aggregate ----
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

  // ---- Compare period ----
  const cmp = compareRows[0] || {};
  const cmpSpend = parseFloat(cmp.spend || 0);
  const cmpClicks = parseInt(cmp.clicks || 0, 10);
  const cmpCtr = parseFloat(cmp.ctr || 0);
  const cmpLeads = getLeads(cmp);
  const cmpCpl = cmpLeads > 0 ? cmpSpend / cmpLeads : 0;
  const compare = (cmpSpend > 0 || cmpLeads > 0) ? {
    period_label: compareLabel,
    spend: cmpSpend,
    leads: cmpLeads,
    cpl: cmpCpl,
    ctr: cmpCtr,
    deltas: {
      spend_pct: pctDelta(spend, cmpSpend),
      leads_pct: pctDelta(leads, cmpLeads),
      cpl_pct: pctDelta(cpl, cmpCpl),
      ctr_pct: pctDelta(ctr, cmpCtr),
    },
  } : null;

  // ---- Top campaigns (with frequency now) ----
  const top_campaigns = campaignRows.map(c => {
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
      frequency: parseFloat(c.frequency || 0),
    };
  }).sort((a, b) => b.spend - a.spend).slice(0, 10);

  // ---- Audience breakdowns ----
  const ageBuckets = ageRows.map(r => {
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
      cpl: rLeads > 0 ? rSpend / rLeads : 0,
    };
  }).sort((a, b) => b.spend - a.spend);

  const genderBuckets = genderRows.map(r => {
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
      cpl: rLeads > 0 ? rSpend / rLeads : 0,
    };
  }).sort((a, b) => b.spend - a.spend);

  // ---- Alerts (descriptive — what's happening) ----
  const alerts = [];

  // High-CPL campaigns with enough volume
  for (const c of top_campaigns) {
    if (c.spend > 50 && c.leads >= 5 && c.cpl > TARGET_CPL * 2) {
      alerts.push({
        level: "critical",
        type: "high_cpl_campaign",
        subject: c.name,
        message: `CPL $${c.cpl.toFixed(2)} is ${(c.cpl / TARGET_CPL).toFixed(1)}x target ($${TARGET_CPL.toFixed(2)})`,
        value: c.cpl,
      });
    }
  }

  // Frequency saturation — at campaign level
  for (const c of top_campaigns) {
    if (c.reach > 1000) {
      if (c.frequency > 3.5) {
        alerts.push({
          level: "critical",
          type: "frequency_saturated",
          subject: c.name,
          message: `Frequency ${c.frequency.toFixed(2)} — audience is burned out. Refresh creative or expand audience.`,
          value: c.frequency,
        });
      } else if (c.frequency > 2.5) {
        alerts.push({
          level: "warning",
          type: "frequency_approaching",
          subject: c.name,
          message: `Frequency ${c.frequency.toFixed(2)} — approaching fatigue. Monitor CTR for decay.`,
          value: c.frequency,
        });
      }
    }
  }

  // Frequency saturation — at audience-age level
  for (const a of ageBuckets) {
    if (a.reach > 1000) {
      if (a.frequency > 3.5) {
        alerts.push({
          level: "critical",
          type: "audience_saturated",
          subject: `age ${a.key}`,
          message: `Frequency ${a.frequency.toFixed(2)} on ${a.key} bracket — saturated.`,
          value: a.frequency,
        });
      } else if (a.frequency > 2.5) {
        alerts.push({
          level: "warning",
          type: "audience_approaching",
          subject: `age ${a.key}`,
          message: `Frequency ${a.frequency.toFixed(2)} on ${a.key} bracket — fatigue brewing.`,
          value: a.frequency,
        });
      }
    }
  }

  // Day-over-day CPL spike
  if (compare && cmpLeads >= 10 && cpl > 0 && cmpCpl > 0) {
    const cplDelta = pctDelta(cpl, cmpCpl);
    if (cplDelta > 25) {
      alerts.push({
        level: "warning",
        type: "cpl_trending_up",
        subject: "account aggregate",
        message: `CPL up ${cplDelta.toFixed(0)}% vs ${compareLabel} ($${cmpCpl.toFixed(2)} → $${cpl.toFixed(2)})`,
        value: cplDelta,
      });
    }
  }

  // ---- Recommendations (actionable — what to do) ----
  const recommendations = [];

  // PAUSE candidates: high CPL with real volume
  for (const c of top_campaigns) {
    if (c.spend > 50 && c.leads >= 5 && c.cpl > TARGET_CPL * 2) {
      recommendations.push({
        action: "PAUSE",
        subject: c.name,
        rationale: `CPL $${c.cpl.toFixed(2)} is ${(c.cpl / TARGET_CPL).toFixed(1)}x target ($${TARGET_CPL.toFixed(2)}). Volume: $${c.spend.toFixed(0)} spent on ${c.leads} leads — past the small-sample threshold.`,
        confidence: c.spend > 150 ? "high" : "medium",
        suggested_delta: "-100% (pause)",
      });
    }
  }

  // PAUSE candidates: severe frequency saturation
  for (const c of top_campaigns) {
    if (c.reach > 1000 && c.frequency > 3.5) {
      // Don't double-recommend if already flagged for CPL
      if (recommendations.find(r => r.subject === c.name)) continue;
      recommendations.push({
        action: "PAUSE",
        subject: c.name,
        rationale: `Frequency ${c.frequency.toFixed(2)} — audience burned out. Either refresh creative + relaunch, or expand audience and resume.`,
        confidence: "high",
        suggested_delta: "-100% (pause + refresh)",
      });
    }
  }

  // SCALE candidates: low CPL, validated volume, room to grow
  for (const c of top_campaigns) {
    if (c.spend > 30 && c.leads >= 10 && c.cpl < TARGET_CPL * 1.2 && c.frequency < 2.0) {
      // Don't double-recommend
      if (recommendations.find(r => r.subject === c.name)) continue;
      recommendations.push({
        action: "SCALE",
        subject: c.name,
        rationale: `CPL $${c.cpl.toFixed(2)} ≤ 1.2x target. Frequency ${c.frequency.toFixed(2)} = room to grow (not yet saturated). Volume: $${c.spend.toFixed(0)} on ${c.leads} leads.`,
        confidence: c.spend > 100 ? "high" : "medium",
        suggested_delta: "+25% budget",
      });
    }
  }

  // INVESTIGATE: campaigns with high spend but no leads (something broken)
  for (const c of top_campaigns) {
    if (c.spend > 30 && c.leads === 0) {
      if (recommendations.find(r => r.subject === c.name)) continue;
      recommendations.push({
        action: "INVESTIGATE",
        subject: c.name,
        rationale: `$${c.spend.toFixed(0)} spent with 0 leads. Pixel/CAPI broken on this campaign's landing, or audience mismatch.`,
        confidence: "high",
        suggested_delta: "diagnose first, pause if confirmed broken",
      });
    }
  }

  // SCALE-AGE-BUCKET: age buckets crushing target
  for (const a of ageBuckets) {
    if (a.spend > 30 && a.leads >= 10 && a.cpl < TARGET_CPL * 1.2 && a.frequency < 2.0) {
      recommendations.push({
        action: "BOOST AUDIENCE",
        subject: `age ${a.key}`,
        rationale: `${a.key} bracket converting at $${a.cpl.toFixed(2)} CPL. Reach ${a.reach.toLocaleString()}, frequency ${a.frequency.toFixed(2)} — room to grow. Consider lookalike off this bracket.`,
        confidence: "medium",
        suggested_delta: "build 1% LAL from this segment",
      });
    }
  }

  // CUT-AGE-BUCKET: age buckets bleeding
  for (const a of ageBuckets) {
    if (a.spend > 30 && (a.leads === 0 || a.cpl > TARGET_CPL * 3)) {
      recommendations.push({
        action: "EXCLUDE AUDIENCE",
        subject: `age ${a.key}`,
        rationale: `$${a.spend.toFixed(0)} spent, ${a.leads ? `CPL $${a.cpl.toFixed(2)} (${(a.cpl / TARGET_CPL).toFixed(1)}x target)` : "0 conversions"}. Exclude this bracket from active ad sets.`,
        confidence: "high",
        suggested_delta: "exclude from all active ad sets",
      });
    }
  }

  // Cap & rank: confidence priority, then action severity
  const actionPriority = { "PAUSE": 1, "INVESTIGATE": 2, "EXCLUDE AUDIENCE": 3, "SCALE": 4, "BOOST AUDIENCE": 5 };
  recommendations.sort((a, b) => {
    const conf = { high: 1, medium: 2, low: 3 };
    return (conf[a.confidence] - conf[b.confidence]) || (actionPriority[a.action] - actionPriority[b.action]);
  });

  // ---- Daily breakdown (spend timeline) ----
  // Meta returns one row per day in account TZ with `date_start` / `date_stop`.
  // Sort ascending so chart reads left → right oldest → newest.
  const daily_spend = dailyRows.map(r => {
    const dSpend = parseFloat(r.spend || 0);
    const dLeads = getLeads(r);
    return {
      date: r.date_start,
      spend: dSpend,
      impressions: parseInt(r.impressions || 0, 10),
      clicks: parseInt(r.clicks || 0, 10),
      leads: dLeads,
      cpl: dLeads > 0 ? dSpend / dLeads : 0,
    };
  }).sort((a, b) => a.date.localeCompare(b.date));

  // ---- Lifetime aggregate (all-time campaign performance) ----
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
    frequency: parseFloat(lifeRow.frequency || 0),
  };

  // ---- Pacing to goal (paid lead target from James's brief) ----
  // Override DEFAULT_PAID_LEAD_TARGET via CF Pages secret META_PAID_LEAD_TARGET.
  const targetLeads = parseInt(env.META_PAID_LEAD_TARGET || DEFAULT_PAID_LEAD_TARGET, 10);
  const todayPt = ptDateStr(new Date());
  // Avg daily leads from COMPLETE days only (exclude today partial)
  const completeDays = daily_spend.filter(d => d.date < todayPt && d.spend > 0);
  const avgDailyLeads = completeDays.length > 0
    ? completeDays.reduce((s, d) => s + d.leads, 0) / completeDays.length
    : 0;
  // Days remaining until event start (May 26 inclusive of today)
  const todayMs = Date.parse(todayPt + "T00:00:00Z");
  const eventMs = Date.parse(FYP_EVENT_START_DATE + "T00:00:00Z");
  const daysRemaining = Math.max(0, Math.round((eventMs - todayMs) / 86400000));
  // Projected total leads at current pace (today included as partial)
  const projectedTotal = lifeLeads + Math.round(avgDailyLeads * daysRemaining);
  const pctToTarget = targetLeads > 0 ? (lifeLeads / targetLeads) * 100 : 0;
  const projectedPct = targetLeads > 0 ? (projectedTotal / targetLeads) * 100 : 0;
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
    leads_needed_per_day: daysRemaining > 0
      ? Math.max(0, Math.ceil((targetLeads - lifeLeads) / daysRemaining))
      : 0,
  };

  return JSON.stringify({
    ok: true,
    spend, impressions, clicks, ctr, cpc, reach, frequency, leads, cpl,
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
    generated_at: new Date().toISOString(),
  }, null, 2);
}
