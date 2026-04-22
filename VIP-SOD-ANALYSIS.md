## ThriveCart Analysis — Fall 2025 VIP → SOD Conversion

**Pulled:** 8,373 transactions (full ThriveCart history back to 2024-11).
**Raw data:** `~/Documents/HOD-FYP-mockups/thrivecart-data.json`
**Summary JSON:** `~/Documents/HOD-FYP-mockups/analysis-summary.json`
**SOD defined as:** product IDs 15, 13, 5, 17, 45, 27, 25 (SOD main tiers) + 29, 31, 19 (PRO upgrades / deposits) + any item name containing "School of Dating" or starting with "SOD ". Excludes BOD (24).

### Raw Numbers
- Fall 2025 $5 VIP buyers (unique emails, 10/20/25 – 1/21/26): **2,016**
- VIP revenue: **$10,110** across 2,022 transactions
- SOD buyers since VIP launched (10/20/25 on): **212 unique**
- SOD buyers Nov 2025 – Feb 2026 window: **193 unique**
- VIP buyers who also bought SOD (post-10/20): **103**
- VIP buyers who also bought SOD (Nov–Feb window): **96**
- Non-VIP SOD buyers (post-10/20): **109**

### Conversion Rates
- **VIP → SOD: 5.11%** (103 / 2,016)
- **Non-VIP → SOD: 0.72%** (109 / 15,196, denom = 17,212 challenge reg − 2,016 VIP)
- **MULTIPLIER: VIP buyers were 7.1× more likely to buy SOD** (7.5× if you restrict to Nov–Feb window only)

### Revenue Impact
- SOD revenue attributable to VIP buyers (post-10/20 SOD tx from the 103 cross-buyers): **$75,262**
- VIP tripwire cost-to-acquire SOD buyer: $10,110 / 103 = **$98 per SOD buyer** (and the $5s largely cover processor fees — effectively free acquisition)

### BOD Analysis
- Lifetime BOD buyers: 216 (145 before Nov 2025)
- BOD → SOD lifetime overlap: **10 (4.6%)**
- BOD-before-Nov25 → SOD in the Fall 2025 window: **5 (3.45%)**
- VIP ∩ BOD overlap: 29 buyers (small — the two funnels reach different people)
- **Read:** BOD alone converts to SOD at ~3.5–4.6% — similar to VIP's 5.1%, but BOD takes $197 up front vs. $5. Bundling BOD into a $17 VIP gives buyers a course they can consume immediately AND plausibly keeps the SOD conversion rate in the same 4–5%+ band.

### Revenue Model at $17 vs $5 (May 2026, assume ~2,000 VIP sellthrough)
| Price | VIP units | VIP rev | If SOD conv holds at 5.1% | If SOD conv drops to 3.5% | If SOD conv drops to 2.5% |
|---|---|---|---|---|---|
| $5  | 2,000 | $10,000 | 102 SOD × $730 avg = $74,500 → **total $84,500** | — | — |
| $17 | 2,000 | $34,000 | 102 × $730 = $74,500 → **$108,500** | 70 × $730 = $51,100 → **$85,100** | 50 × $730 = $36,500 → **$70,500** |
| $17 | 1,400 (30% price drag) | $23,800 | 71 × $730 = $51,830 → **$75,630** | 49 × $730 = $35,770 → **$59,570** | 35 × $730 = $25,550 → **$49,350** |

*($730 avg SOD cart value derived from $75,262 / 103 buyers — mix of $997, 6× and 12× payment plans)*

### Recommendation
- **Price at $17 is justified** as long as (a) volume stays above ~1,400 buyers **and** (b) SOD conversion holds above ~3.5%. Both are plausible — the $5 → $17 step should filter out low-intent buyers, often *improving* downstream conversion rate even as unit volume dips.
- **Target for May 2026:** ≥ 3.5% VIP → SOD conversion at ≥ 1,500 VIP sales. Below 3.5% conversion at $17 means you've broken the funnel; pull back to $10–$12.
- **Bundle BOD with the $17 VIP.** The 4.6% lifetime BOD → SOD rate suggests BOD primes SOD intent, VIP/BOD overlap is only 29 (so minimal cannibalization), and bundling turns a $17 tripwire into a $197-value stack. This is the highest-leverage move you can make on the Spring campaign.

### Caveats / Data Limits
- Challenge reg denominator of 17,212 is a JJ-supplied figure; ThriveCart only stores the 430 paid/free-reg entries on product 34. Non-VIP conversion rate is sensitive to this denominator — if true reg was 10,000, non-VIP → SOD rises to 1.1% and multiplier falls to ~4.6×. Still decisive.
- SOD subscription plans generate monthly tx rows; unique-email de-duplication used throughout to avoid double-counting.
- Window-edge effect: VIP buyers have had up to 6 months post-purchase to convert; Nov-start non-VIPs had similar runway. Apples-to-apples.
