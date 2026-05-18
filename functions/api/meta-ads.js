// Meta Marketing API integration — pulls ads insights for the dashboard.
//
// GET /api/meta-ads                           → today PT (ad-account-aligned)
// GET /api/meta-ads?start=ISO&end=ISO         → custom range (matches dashboard)
//
// Returns: { spend, impressions, clicks, ctr, cpc, reach, frequency, leads, cpl, top_campaigns[], generated_at }
//
// Secrets required (CF Pages):
//   META_ADS_TOKEN         system-user access token with ads_read
//   META_AD_ACCOUNT_ID     act_XXXXXXXXXX

const META_API_VERSION = "v19.0";

// SWR cache (90s) — Meta's data updates with a few-minute lag anyway,
// no point hitting Graph more often than that.
let _cache = { byKey: {} };
const CACHE_TTL_MS = 90 * 1000;

function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }

// Build time_range param from start/end (ISO). Meta wants YYYY-MM-DD in the
// account's timezone (Kait's is America/Los_Angeles = PT, matches our dashboard).
function timeRangeParam(startIso, endIso) {
  // Convert to PT-aligned YYYY-MM-DD using Intl
  const toPtDate = (iso) => {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
  };
  return JSON.stringify({ since: toPtDate(startIso), until: toPtDate(endIso) });
}

async function fetchInsights(env, params) {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}/${env.META_AD_ACCOUNT_ID}/insights`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", env.META_ADS_TOKEN);
  const r = await fetch(url.toString());
  const data = await r.json();
  if (!r.ok || data.error) {
    throw new Error(`Meta insights ${r.status}: ${data.error?.message || "unknown"}`);
  }
  return data.data || [];
}

// Extract a specific action type from Meta's `actions` array (e.g. "lead", "complete_registration")
function actionCount(insightsRow, actionType) {
  const actions = insightsRow?.actions || [];
  const match = actions.find(a => a.action_type === actionType);
  return match ? parseInt(match.value, 10) : 0;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const waitUntil = typeof context.waitUntil === "function"
    ? context.waitUntil.bind(context)
    : (p) => { p.catch(() => {}); };

  try {
    if (!env.META_ADS_TOKEN || !env.META_AD_ACCOUNT_ID) {
      return new Response(JSON.stringify({ ok: false, error: "Meta API not configured" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const url = new URL(request.url);
    const startParam = url.searchParams.get("start");
    const endParam = url.searchParams.get("end");
    const hasRange = startParam && endParam;

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

    // SWR: serve fresh-or-stale, refresh in background if stale
    if (entry?.body) {
      const age = Date.now() - entry.at;
      if (age < CACHE_TTL_MS) return respond(entry.body, "HIT-MEM");
      if (!entry.refreshing) {
        entry.refreshing = true;
        waitUntil((async () => {
          try {
            const fresh = await computeMetaSnapshot(env, { startParam, endParam, hasRange });
            _cache.byKey[cacheKey] = { at: Date.now(), body: fresh, refreshing: false };
          } catch (_) {
            if (_cache.byKey[cacheKey]) _cache.byKey[cacheKey].refreshing = false;
          }
        })());
      }
      return respond(entry.body, "STALE-MEM");
    }

    const body = await computeMetaSnapshot(env, { startParam, endParam, hasRange });
    _cache.byKey[cacheKey] = { at: Date.now(), body, refreshing: false };
    return respond(body, "MISS");
  } catch (e) {
    // Safe-error: return valid JSON shape so frontend doesn't break
    return new Response(JSON.stringify({
      ok: false,
      error: e.message,
      warming: true,
      spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0,
      reach: 0, frequency: 0, leads: 0, cpl: 0,
      top_campaigns: [],
      generated_at: new Date().toISOString(),
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "X-Cache": "ERROR-SAFE",
      },
    });
  }
}

async function computeMetaSnapshot(env, { startParam, endParam, hasRange }) {
  // Build params for both account-level and campaign-level insights
  const accountParams = {
    fields: "spend,impressions,clicks,ctr,cpc,reach,frequency,actions,cost_per_action_type",
    level: "account",
  };
  const campaignParams = {
    fields: "campaign_name,spend,impressions,clicks,ctr,actions,cost_per_action_type",
    level: "campaign",
    limit: "20",
  };

  if (hasRange) {
    const tr = timeRangeParam(startParam, endParam);
    accountParams.time_range = tr;
    campaignParams.time_range = tr;
  } else {
    // Default: today in account timezone (PT). Meta's `date_preset=today` honors the ad account's TZ.
    accountParams.date_preset = "today";
    campaignParams.date_preset = "today";
  }

  // Pull both in parallel
  const [accountRows, campaignRows] = await Promise.all([
    fetchInsights(env, accountParams),
    fetchInsights(env, campaignParams),
  ]);

  // Account aggregate (insights returns 1 row at account level)
  const acc = accountRows[0] || {};
  const spend = parseFloat(acc.spend || 0);
  const impressions = parseInt(acc.impressions || 0, 10);
  const clicks = parseInt(acc.clicks || 0, 10);
  const ctr = parseFloat(acc.ctr || 0);
  const cpc = parseFloat(acc.cpc || 0);
  const reach = parseInt(acc.reach || 0, 10);
  const frequency = parseFloat(acc.frequency || 0);

  // Leads — prefer CompleteRegistration (our event), fall back to lead/onsite_conversion.lead_grouped
  const leads =
    actionCount(acc, "complete_registration") ||
    actionCount(acc, "lead") ||
    actionCount(acc, "onsite_conversion.lead_grouped") || 0;
  const cpl = leads > 0 ? spend / leads : 0;

  // Top campaigns
  const top_campaigns = campaignRows.map(c => {
    const cSpend = parseFloat(c.spend || 0);
    const cLeads =
      actionCount(c, "complete_registration") ||
      actionCount(c, "lead") ||
      actionCount(c, "onsite_conversion.lead_grouped") || 0;
    return {
      name: c.campaign_name || "(unnamed)",
      spend: cSpend,
      impressions: parseInt(c.impressions || 0, 10),
      clicks: parseInt(c.clicks || 0, 10),
      ctr: parseFloat(c.ctr || 0),
      leads: cLeads,
      cpl: cLeads > 0 ? cSpend / cLeads : 0,
    };
  }).sort((a, b) => b.spend - a.spend).slice(0, 10);

  return JSON.stringify({
    ok: true,
    spend, impressions, clicks, ctr, cpc, reach, frequency,
    leads, cpl,
    top_campaigns,
    range: hasRange ? { start: startParam, end: endParam } : null,
    timezone: "America/Los_Angeles",
    generated_at: new Date().toISOString(),
  }, null, 2);
}
