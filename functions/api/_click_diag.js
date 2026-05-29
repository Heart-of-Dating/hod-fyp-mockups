// Lockout-window clicks: 7:05 PM CT (00:05 UTC) → 8:05 PM CT (01:05 UTC May 27)
export async function onRequest({env}) {
  const sql = `SELECT toStartOfMinute(timestamp) AS minute, COUNT() AS clicks
               FROM ab_test_visitors
               WHERE blob1 = 'sms_click_n1'
                 AND timestamp >= toDateTime('2026-05-27 00:05:00')
                 AND timestamp <= toDateTime('2026-05-27 01:05:00')
               GROUP BY minute
               ORDER BY minute
               FORMAT JSON`;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {method:"POST", headers:{"Authorization":`Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type":"text/plain"}, body:sql});
  return new Response(await r.text(), {headers:{"content-type":"application/json"}});
}
