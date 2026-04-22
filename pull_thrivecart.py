#!/usr/bin/env python3
"""Pull all ThriveCart transactions and save raw + derived analysis."""
import os, json, time, sys, urllib.request, urllib.error

API_KEY = os.environ["THRIVECART_API_KEY"]
BASE = "https://thrivecart.com/api/external/transactions"
OUT_RAW = "/Users/jjtomlin/Documents/HOD-FYP-mockups/thrivecart-data.json"

def fetch(page):
    req = urllib.request.Request(f"{BASE}?page={page}",
                                 headers={"Authorization": f"Bearer {API_KEY}"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode("utf-8", errors="replace")
            # Strip control chars that break json
            cleaned = "".join(ch for ch in raw if ch >= " " or ch in "\t\n\r")
            return json.loads(cleaned)
        except Exception as e:
            print(f"  page {page} attempt {attempt+1} err: {e}", file=sys.stderr)
            time.sleep(2)
    return {"transactions": []}

all_tx = []
page = 1
while True:
    d = fetch(page)
    t = d.get("transactions", [])
    if not t:
        break
    all_tx.extend(t)
    if page % 25 == 0:
        print(f"page {page}: total tx so far {len(all_tx)}, oldest {t[-1].get('date')}", file=sys.stderr)
    # Stop when we get to before 2024 (VIP was Fall 2025, any earlier irrelevant)
    if t[-1].get("date", "9999") < "2024-01-01":
        break
    page += 1
    if page > 400:
        break

print(f"TOTAL transactions pulled: {len(all_tx)}", file=sys.stderr)
with open(OUT_RAW, "w") as f:
    json.dump({"transactions": all_tx, "pulled_at": time.strftime("%Y-%m-%d %H:%M:%S")}, f)
print(f"Saved to {OUT_RAW}", file=sys.stderr)
