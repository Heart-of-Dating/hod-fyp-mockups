// Lightweight: /fyp/ path-only visits via CF Web Analytics.
// Returns today + yesterday pageviews and visits for landing page only.

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

export async function onRequest({ env }) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) {
    return new Response(JSON.stringify({ error: "missing CF creds" }), { status: 500 });
  }
  const today = isoDay(new Date());
  const yesterday = isoDay(new Date(Date.now() - 86400000));

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
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  const rows = j?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];

  const out = {
    today: { pageviews: 0, visits: 0 },
    yesterday: { pageviews: 0, visits: 0 },
    by_path: {},
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
    headers: { "Content-Type": "application/json" },
  });
}
