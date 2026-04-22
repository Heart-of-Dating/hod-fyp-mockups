#!/usr/bin/env python3
"""Analyze: Fall 2025 VIP buyers vs SOD conversion."""
import json
from collections import defaultdict

DATA = "/Users/jjtomlin/Documents/HOD-FYP-mockups/thrivecart-data.json"
with open(DATA) as f:
    txs = json.load(f)["transactions"]

# Product IDs of interest
SOD_IDS = {"45"}              # The School of Dating - DCC (main SOD course)
SOD_UPSELL_IDS = {"29", "31", "19"}  # PRO upgrade + RSVP deposits (signals SOD intent/commitment)
VIP_FALL25_ID = "37"          # FYP VIP (Fall 2025)
BOD_ID = "24"                 # Basics of Dating
CHALLENGE_ID = "34"           # FYP Challenge Nov 2025 (free reg)

# Bucket charges only (exclude refunds/failed). type 'charge' is the paid tx.
def ok(t):
    return t.get("transaction_type") == "charge"

def email(t):
    return (t.get("customer", {}) or {}).get("email", "").strip().lower()

# Collect emails by product
buyers = defaultdict(set)           # item_id -> set of emails
first_buy_date = defaultdict(dict)  # item_id -> email -> date
for t in txs:
    if not ok(t): continue
    e = email(t)
    if not e: continue
    iid = str(t.get("item_id"))
    buyers[iid].add(e)
    d = t.get("date", "")
    cur = first_buy_date[iid].get(e)
    if cur is None or d < cur:
        first_buy_date[iid][e] = d

# Fall 2025 VIP buyers (product 37): filter by date to Oct 1 2025 - Jan 31 2026 (the Fall campaign)
vip_fall_emails = set()
vip_dates = []
for t in txs:
    if not ok(t): continue
    if str(t.get("item_id")) != VIP_FALL25_ID: continue
    d = t.get("date", "")
    if "2025-10-01" <= d <= "2026-01-31":
        vip_fall_emails.add(email(t))
        vip_dates.append(d)

# SOD buyers overall
sod_emails = buyers["45"]

# SOD purchases within Nov 2025 - Jan 2026 (challenge window)
sod_window_emails = set()
for t in txs:
    if not ok(t): continue
    if str(t.get("item_id")) != "45": continue
    d = t.get("date", "")
    if "2025-11-01" <= d <= "2026-02-28":
        sod_window_emails.add(email(t))

# SOD upsell/deposit signals in window
sod_signal_window = set()
for t in txs:
    if not ok(t): continue
    iid = str(t.get("item_id"))
    if iid not in SOD_UPSELL_IDS and iid != "45": continue
    d = t.get("date", "")
    if "2025-11-01" <= d <= "2026-02-28":
        sod_signal_window.add(email(t))

# BOD buyers
bod_emails = buyers[BOD_ID]
bod_window = set()
for t in txs:
    if not ok(t): continue
    if str(t.get("item_id")) != BOD_ID: continue
    d = t.get("date", "")
    if "2025-11-01" <= d <= "2026-02-28":
        bod_window.add(email(t))

# ---- Cross-reference ----
vip_to_sod = vip_fall_emails & sod_window_emails
vip_to_sod_all = vip_fall_emails & sod_emails  # lifetime SOD overlap
vip_to_sod_signal = vip_fall_emails & sod_signal_window
non_vip_sod_window = sod_window_emails - vip_fall_emails

# BOD ↔ SOD overlap (lifetime and window)
bod_to_sod = bod_emails & sod_emails
bod_to_sod_window = bod_emails & sod_window_emails

# Dates / price checks on VIP
vip_tx = [t for t in txs if ok(t) and str(t.get("item_id")) == VIP_FALL25_ID and "2025-10-01" <= t.get("date","") <= "2026-01-31"]
vip_amounts = [t.get("amount", 0) for t in vip_tx]
vip_date_min = min(vip_dates) if vip_dates else None
vip_date_max = max(vip_dates) if vip_dates else None

# Challenge (free) reg in thrivecart - product 34
challenge_emails = buyers.get("34", set())

# SOD lifetime
print("=== Product totals (unique buyer emails, charge only) ===")
key_products = {
    "37": "FYP VIP (Fall 2025 $5)",
    "45": "School of Dating - DCC",
    "24": "Basics of Dating",
    "29": "SOD PRO Upgrade",
    "31": "SOD PRO RSVP Deposit",
    "19": "SOD RSVP Deposit",
    "34": "FYP Challenge Nov 2025 (free reg)",
    "28": "FYP Challenge (older)",
    "15": "SOD Private Sale",
}
for pid, name in key_products.items():
    print(f"  [{pid}] {name}: {len(buyers.get(pid, set()))}")

print()
print("=== Fall 2025 VIP (product 37) ===")
print(f"  Unique VIP buyers Oct 2025–Jan 2026: {len(vip_fall_emails)}")
print(f"  Total VIP tx in window: {len(vip_tx)}")
print(f"  Date range: {vip_date_min} → {vip_date_max}")
print(f"  Amount distribution (cents): min={min(vip_amounts) if vip_amounts else '-'}, max={max(vip_amounts) if vip_amounts else '-'}")
# Revenue
print(f"  Total VIP revenue: ${sum(vip_amounts)/100:.2f}")

print()
print("=== SOD (product 45) purchase window Nov 2025 – Feb 2026 ===")
print(f"  Unique SOD buyers in window: {len(sod_window_emails)}")
print(f"  Lifetime SOD buyers: {len(sod_emails)}")
print(f"  SOD signals (main course + PRO upgrade + deposits) in window: {len(sod_signal_window)}")

print()
print("=== VIP → SOD Cross-reference ===")
print(f"  VIP buyers who bought SOD (in window): {len(vip_to_sod)}")
print(f"  VIP buyers who bought SOD (lifetime): {len(vip_to_sod_all)}")
print(f"  VIP buyers who triggered any SOD signal (main+upgrade+deposit, in window): {len(vip_to_sod_signal)}")
print(f"  Non-VIP SOD buyers in window: {len(non_vip_sod_window)}")

if vip_fall_emails:
    vip_conv = len(vip_to_sod)/len(vip_fall_emails)*100
    vip_conv_signal = len(vip_to_sod_signal)/len(vip_fall_emails)*100
    print(f"  VIP→SOD (main course) conversion: {vip_conv:.2f}%")
    print(f"  VIP→SOD (any signal)    conversion: {vip_conv_signal:.2f}%")

# Non-VIP denominator: total challenge registrants reported = 17,212
CHALLENGE_REG = 17212
non_vip_pool = CHALLENGE_REG - len(vip_fall_emails)
if non_vip_pool > 0:
    nonvip_conv = len(non_vip_sod_window)/non_vip_pool*100
    print(f"  Non-VIP→SOD conversion (denom=17,212 - VIP): {nonvip_conv:.3f}%")
    if vip_conv > 0 and nonvip_conv > 0:
        print(f"  *** MULTIPLIER (main): {vip_conv/nonvip_conv:.1f}x ***")

print()
print("=== BOD (product 24) ===")
print(f"  Lifetime BOD buyers: {len(bod_emails)}")
print(f"  BOD buyers Nov 2025–Feb 2026: {len(bod_window)}")
print(f"  BOD→SOD overlap (lifetime): {len(bod_to_sod)}  ({len(bod_to_sod)/max(1,len(bod_emails))*100:.1f}%)")
print(f"  BOD buyers who bought SOD in Nov25–Feb26 window: {len(bod_to_sod_window)}  ({len(bod_to_sod_window)/max(1,len(bod_emails))*100:.2f}%)")

# BOD buyers BEFORE Nov 2025 → SOD in window (is prior BOD a predictor of SOD?)
bod_before_nov = set()
for t in txs:
    if not ok(t): continue
    if str(t.get("item_id")) != BOD_ID: continue
    if t.get("date","") < "2025-11-01":
        bod_before_nov.add(email(t))
bod_before_to_sod = bod_before_nov & sod_window_emails
print(f"  BOD buyers BEFORE Nov 2025: {len(bod_before_nov)}")
print(f"  of those who bought SOD in Nov25–Feb26: {len(bod_before_to_sod)} ({len(bod_before_to_sod)/max(1,len(bod_before_nov))*100:.2f}%)")

print()
print("=== VIP ∩ BOD overlap ===")
print(f"  VIP buyers who also own BOD (lifetime): {len(vip_fall_emails & bod_emails)}")

# Write a summary JSON
summary = {
    "vip_fall25_buyers": len(vip_fall_emails),
    "vip_fall25_revenue_usd": sum(vip_amounts)/100,
    "vip_fall25_date_range": [vip_date_min, vip_date_max],
    "sod_window_buyers": len(sod_window_emails),
    "sod_lifetime_buyers": len(sod_emails),
    "vip_to_sod_window": len(vip_to_sod),
    "vip_to_sod_lifetime": len(vip_to_sod_all),
    "vip_to_sod_any_signal": len(vip_to_sod_signal),
    "non_vip_sod_window": len(non_vip_sod_window),
    "assumed_total_challenge_reg": CHALLENGE_REG,
    "bod_lifetime_buyers": len(bod_emails),
    "bod_to_sod_lifetime_overlap": len(bod_to_sod),
    "bod_before_nov25": len(bod_before_nov),
    "bod_before_to_sod_window": len(bod_before_to_sod),
    "vip_and_bod_overlap": len(vip_fall_emails & bod_emails),
}
with open("/Users/jjtomlin/Documents/HOD-FYP-mockups/analysis-summary.json", "w") as f:
    json.dump(summary, f, indent=2)
print("\nSummary JSON saved.")
