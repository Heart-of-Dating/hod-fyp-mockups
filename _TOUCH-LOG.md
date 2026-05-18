# _TOUCH-LOG — hod-fyp-mockups cross-machine collaboration

Same protocol as hod-brain. Append on every edit to shared files. Order: newest at the bottom.

Format:
```
YYYY-MM-DD HH:MM TZ — <Agent> edited <path> (<one-line summary>)
```
2026-05-15 15:01 CDT — Bandit added WORKFLOW.md + _TOUCH-LOG.md (cross-machine collab setup for Banjo)
2026-05-15 17:30 CDT — Banjo edited functions/api/register.js (added Telnyx welcome SMS staged behind TELNYX_LIVE flag, fire-and-forget via ctx.waitUntil)
2026-05-15 17:30 CDT — Banjo added scripts/sms-backfill.js (standalone dry-run-default backfill tool for existing SMS_Optin_Yes contacts; --confirm to send, --limit/--resume flags)
2026-05-15 17:30 CDT — Banjo added public/fyp/vip-paid-mockup/ (paid-traffic trust-variant VIP page: re-stacked layout, real Nov 2025 testimonials, teaser-expand <details> pattern for mobile, randomuser.me avatar placeholders pending AI-gen replacements)
2026-05-16 11:34 CDT — Bandit added date range picker to dashboard (backend /api/dashboard?start=X&end=Y with range-aware aggregation; UI presets Today/Yesterday/7d/30d/Since launch + custom; range affects hourly/daily/states/landing while VIP+channel+recent feeds stay cumulative)
2026-05-16 14:02 CDT — Bandit fixed iOS WebKit duplicate-form scroll bug (James diagnosis) + dashboard CF edge cache layer (kills 503s under auto-refresh load)
2026-05-16 14:16 CDT — Bandit simplified dashboard range picker to Live / Yesterday / Custom (date+hour); backend accepts full ISO timestamps; hourly bars auto-shown when span ≤48h
2026-05-16 14:43 CDT — Bandit removed bottom register form (commented out), replaced with anchor button → #register-form (testing whether _b-suffix fix was insufficient against iOS WebKit autofill anchoring; if scroll jump now gone, James Option A confirmed as the real fix)
2026-05-16 23:12 CDT — Bandit fixed dashboard 'too many subrequests' (CF Workers 50/invocation cap): countContactsForTag + countContactsOnList now read meta.total in 1 request instead of paginating all pages; consolidated 3 VIP tag searches into 1; cuts ~25-50 subrequests per call
2026-05-16 23:30 CDT — Bandit switched dashboard timezone CT → PT (aligns with Meta Ads Manager default). Backend hourly bucketing now UTC-7 (PDT). Frontend: datetime-local inputs treated as PT regardless of browser locale, fmtPt uses Intl with America/Los_Angeles, Yesterday preset = PT 00:00-23:59, all labels say PT, helper footnote added under range bar
2026-05-17 06:26 CDT — Bandit fixed dashboard 503/CPU-limit at ~2K reg scale: pullListWithMeta default no longer pulls fieldValues (cuts payload ~10x + CPU ~5x); top_states pulls separately in 2-day window with fieldValues; range-mode top_states does its own scoped pull; cache TTL 60s → 120s
2026-05-17 15:40 CDT — Bandit fixed CPU-limit 503 at 2.6K+ scale: live mode now pulls only TODAY's contacts (not 7 days); daily 7-day chart uses 7 parallel meta.total queries (no contact data); yesterday count uses meta.total with date range. CF Pages CPU budget is 50ms and 7-day pull at 2K+ scale blew through it even without fieldValues
2026-05-17 15:50 CDT — Bandit re-architected dashboard for resilience: subreq cap reduced (5+2 page limits on AC pulls), counts via meta.total only, SWR (stale-while-revalidate) cache pattern, per-cacheKey isolation prevents range queries from evicting live data, safe-error JSON instead of HTML 500 so frontend never sees 'Unexpected token <', last-known-good fallback. Stress test 10/10 + 8/8 parallel uniques PASS (was 0/0)
2026-05-17 20:43 CDT — Bandit un-capped dashboard pulls post Workers Standard upgrade: lean pull 5→25 pages (2500 contact ceiling), state pull 2→10 pages (1000). Hourly chart + top_states now exhaustive (verified: sum-of-hourly == today count). MISS path 14-16s but succeeds; SWR keeps user-facing path fast
