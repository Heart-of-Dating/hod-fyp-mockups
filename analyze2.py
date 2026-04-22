#!/usr/bin/env python3
"""Refined analysis: Fall 2025 VIP buyers vs SOD conversion.
SOD = products 15, 13, 5, 17, 45, 27, 25, 29, 31, 19, and item_name containing SOD
"""
import json
from collections import defaultdict, Counter

DATA = "/Users/jjtomlin/Documents/HOD-FYP-mockups/thrivecart-data.json"
txs = json.load(open(DATA))["transactions"]

def ok(t): return t.get("transaction_type") == "charge"
def email(t): return (t.get("customer", {}) or {}).get("email", "").strip().lower()
def iid(t): return str(t.get("item_id"))

# Broad SOD definition (excludes "Basics of Dating")
SOD_IDS = {"15", "13", "5", "17", "45", "27", "25", "29", "31", "19"}
def is_sod(t):
    if iid(t) in SOD_IDS: return True
    n = (t.get("item_name") or "").lower()
    if "school of dating" in n or n.startswith("sod "): return True
    return False

VIP_FALL25_ID = "37"
BOD_ID = "24"

# ---- VIP Fall 2025 ($5 tripwire) ----
vip_emails = set()
vip_tx = []
for t in txs:
    if not ok(t): continue
    if iid(t) != VIP_FALL25_ID: continue
    d = t.get("date", "")
    if "2025-10-01" <= d <= "2026-01-31":
        vip_emails.add(email(t))
        vip_tx.append(t)

vip_dates = sorted(t.get("date") for t in vip_tx)
vip_by_month = Counter(t.get("date","")[:7] for t in vip_tx)

# ---- SOD enrollments: unique email per SOD product, earliest date
sod_enrolled = {}   # email -> (first_date, item_id, item_name)
for t in txs:
    if not ok(t): continue
    if not is_sod(t): continue
    e = email(t)
    if not e: continue
    d = t.get("date", "")
    if e not in sod_enrolled or d < sod_enrolled[e][0]:
        sod_enrolled[e] = (d, iid(t), t.get("item_name"))

# SOD window of interest: Nov 2025 - Feb 2026 (post-Fall-challenge)
sod_window_emails = {e for e, (d, _, _) in sod_enrolled.items() if "2025-11-01" <= d <= "2026-02-28"}
# Broader: any SOD enrollment after VIP launch (Oct 20 2025) through today
sod_post_vip_emails = {e for e, (d, _, _) in sod_enrolled.items() if d >= "2025-10-20"}

# ---- BOD ----
bod_emails = set()
bod_first = {}
for t in txs:
    if not ok(t): continue
    if iid(t) != BOD_ID: continue
    e = email(t); d = t.get("date","")
    bod_emails.add(e)
    if e not in bod_first or d < bod_first[e]:
        bod_first[e] = d

bod_before_nov = {e for e, d in bod_first.items() if d < "2025-11-01"}

# ---- Cross-ref ----
vip_sod_window = vip_emails & sod_window_emails
vip_sod_any = vip_emails & set(sod_enrolled.keys())
vip_sod_post_vip = vip_emails & sod_post_vip_emails
non_vip_sod_window = sod_window_emails - vip_emails
non_vip_sod_post = sod_post_vip_emails - vip_emails

bod_sod = bod_emails & set(sod_enrolled.keys())
bod_before_to_sod_window = bod_before_nov & sod_window_emails
bod_before_to_sod_post = bod_before_nov & sod_post_vip_emails

vip_bod_overlap = vip_emails & bod_emails

# ---- Revenue from VIP→SOD conversions ----
# pull all transactions for emails in vip_sod_post_vip where is_sod and date>=2025-10-20
vip_sod_revenue_cents = 0
for t in txs:
    if not ok(t): continue
    if not is_sod(t): continue
    if email(t) in vip_sod_post_vip and t.get("date","") >= "2025-10-20":
        vip_sod_revenue_cents += t.get("amount", 0)

# ---- Print ----
print("=" * 60)
print("FALL 2025 VIP ($5) TRIPWIRE")
print("=" * 60)
print(f"Unique buyers: {len(vip_emails)}")
print(f"Transactions:  {len(vip_tx)}")
print(f"Date range:    {vip_dates[0]} → {vip_dates[-1]}")
print(f"Revenue:       ${sum(t.get('amount',0) for t in vip_tx)/100:,.2f}")
print("By month:")
for m, n in sorted(vip_by_month.items()): print(f"  {m}: {n}")
print()

print("=" * 60)
print("SOD ENROLLMENTS (unique emails, any SOD SKU)")
print("=" * 60)
print(f"Lifetime unique SOD buyers: {len(sod_enrolled)}")
print(f"SOD buyers Nov 2025 – Feb 2026: {len(sod_window_emails)}")
print(f"SOD buyers since VIP launch (2025-10-20 on): {len(sod_post_vip_emails)}")
print()

print("=" * 60)
print("VIP → SOD CONVERSION")
print("=" * 60)
print(f"VIP buyers who also bought SOD (Nov25–Feb26 window): {len(vip_sod_window)}")
print(f"VIP buyers who also bought SOD (Oct20 on):           {len(vip_sod_post_vip)}")
print(f"VIP buyers who ever bought SOD (lifetime):           {len(vip_sod_any)}")
print()
print(f"Non-VIP SOD buyers in Nov25–Feb26 window: {len(non_vip_sod_window)}")
print(f"Non-VIP SOD buyers since Oct 20:          {len(non_vip_sod_post)}")
print()

vip_conv_w = len(vip_sod_window)/len(vip_emails)*100
vip_conv_p = len(vip_sod_post_vip)/len(vip_emails)*100
print(f"VIP → SOD rate (Nov25–Feb26 window): {vip_conv_w:.2f}%  ({len(vip_sod_window)}/{len(vip_emails)})")
print(f"VIP → SOD rate (Oct 20 onward):      {vip_conv_p:.2f}%  ({len(vip_sod_post_vip)}/{len(vip_emails)})")

CHALLENGE_REG = 17212
non_vip_pool = CHALLENGE_REG - len(vip_emails)
nv_conv_w = len(non_vip_sod_window) / non_vip_pool * 100
nv_conv_p = len(non_vip_sod_post) / non_vip_pool * 100
print(f"Non-VIP → SOD rate (window, denom={non_vip_pool}): {nv_conv_w:.3f}%  ({len(non_vip_sod_window)}/{non_vip_pool})")
print(f"Non-VIP → SOD rate (Oct 20 on):      {nv_conv_p:.3f}%  ({len(non_vip_sod_post)}/{non_vip_pool})")
print()
print(f"*** MULTIPLIER (window):    {vip_conv_w/max(nv_conv_w,1e-9):.1f}x ***")
print(f"*** MULTIPLIER (Oct20 on):  {vip_conv_p/max(nv_conv_p,1e-9):.1f}x ***")
print()
print(f"Revenue from VIP→SOD conversions (post-Oct-20 SOD tx): ${vip_sod_revenue_cents/100:,.2f}")
print()

print("=" * 60)
print("BOD ANALYSIS")
print("=" * 60)
print(f"Lifetime BOD buyers:                       {len(bod_emails)}")
print(f"BOD buyers BEFORE Nov 2025:                {len(bod_before_nov)}")
print(f"BOD→SOD lifetime overlap:                  {len(bod_sod)}  ({len(bod_sod)/max(1,len(bod_emails))*100:.1f}%)")
print(f"BOD-before-Nov25 → SOD in Nov25–Feb26:     {len(bod_before_to_sod_window)}  ({len(bod_before_to_sod_window)/max(1,len(bod_before_nov))*100:.2f}%)")
print(f"BOD-before-Nov25 → SOD post-Oct-20:        {len(bod_before_to_sod_post)}  ({len(bod_before_to_sod_post)/max(1,len(bod_before_nov))*100:.2f}%)")
print()
print(f"VIP ∩ BOD (VIP buyers who also own BOD lifetime): {len(vip_bod_overlap)}")

# Save summary
summary = {
    "vip_fall25": {
        "unique_buyers": len(vip_emails),
        "transactions": len(vip_tx),
        "date_range": [vip_dates[0], vip_dates[-1]],
        "revenue_usd": sum(t.get('amount',0) for t in vip_tx)/100,
        "by_month": dict(vip_by_month),
    },
    "sod": {
        "lifetime_unique_buyers": len(sod_enrolled),
        "buyers_nov25_feb26": len(sod_window_emails),
        "buyers_since_2025_10_20": len(sod_post_vip_emails),
    },
    "vip_to_sod": {
        "overlap_window": len(vip_sod_window),
        "overlap_post_vip": len(vip_sod_post_vip),
        "overlap_lifetime": len(vip_sod_any),
        "vip_conv_rate_window_pct": vip_conv_w,
        "vip_conv_rate_post_pct": vip_conv_p,
        "non_vip_conv_rate_window_pct": nv_conv_w,
        "non_vip_conv_rate_post_pct": nv_conv_p,
        "multiplier_window": vip_conv_w/max(nv_conv_w,1e-9),
        "multiplier_post": vip_conv_p/max(nv_conv_p,1e-9),
        "vip_sod_revenue_post_usd": vip_sod_revenue_cents/100,
    },
    "bod": {
        "lifetime_buyers": len(bod_emails),
        "buyers_before_nov25": len(bod_before_nov),
        "bod_sod_lifetime_overlap": len(bod_sod),
        "bod_before_to_sod_window": len(bod_before_to_sod_window),
        "bod_before_to_sod_post": len(bod_before_to_sod_post),
        "vip_bod_overlap": len(vip_bod_overlap),
    },
    "assumptions": {
        "total_fall2025_challenge_reg": CHALLENGE_REG,
        "SOD_product_ids": sorted(SOD_IDS),
        "SOD_lookup_includes_name_match": True,
    },
}
with open("/Users/jjtomlin/Documents/HOD-FYP-mockups/analysis-summary.json", "w") as f:
    json.dump(summary, f, indent=2, default=str)
