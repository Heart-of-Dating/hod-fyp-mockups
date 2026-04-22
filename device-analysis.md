# ThriveCart Device Analysis — HOD

**Device data available via ThriveCart API?** YES — `customer.client user agent` is populated on transactions (`/api/external/transactions`). Parsed into mobile / desktop / tablet via UA string.

## Important caveat
ThriveCart captures the **CHECKOUT device**, not the landing-page device. A user can browse the sales page on desktop, then complete checkout on mobile (or vice versa). For true landing-device conversion data, pair this with Google Analytics or Meta Pixel on the sales pages.

Also: these are **buyer** splits (transactions), not funnel conversion rates. We don't have non-buyer device data from ThriveCart.

## Device split by product (charges only)

| Segment | Total | Mobile | Desktop | Tablet |
|---|---:|---:|---:|---:|
| FYP Challenge (id 34, Nov 2025) | 447 | **72.7%** | 27.1% | 0.2% |
| FYP Challenge (id 28, evergreen) | 3,395 | **87.3%** | 12.2% | 0.5% |
| VIP Tripwire $5 Fall 2025 (ids 37 + 1760024889718, since 2025-09-01) | 2,093 | **88.7%** | 10.7% | 0.6% |
| SOD (ids 15,13,5,17,45,27,25,29,31,19 since 2025-10-01) | 231 | **58.4%** | 41.1% | 0.4% |

## Takeaways
- **Low-ticket funnels (FYP $5 VIP, FYP challenge) are overwhelmingly mobile** (~87–89%). Optimize checkout for thumbs.
- **FYP id 34 (Nov 2025 cohort) skews less mobile** (72.7%) than evergreen id 28 (87.3%) — different traffic source likely (email list vs paid social?). Worth checking attribution.
- **SOD is the desktop outlier at 41%** — higher-ticket product, buyers more likely to sit down at a laptop. Don't treat SOD checkout UX as mobile-first.

## Recommendation
Device data from ThriveCart = checkout device only. For landing-page device conversion (the question that actually matters for ad spend and page design), layer in:
1. **GA4** (Tech > Device category on the relevant landing URLs)
2. **Meta Pixel** breakdowns if ads are running
3. **ConvertKit** form submissions (has device field on newer versions)
