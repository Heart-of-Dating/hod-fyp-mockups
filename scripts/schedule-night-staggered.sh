#!/bin/bash
# Stagger SMS night reminders across 4 batches (N2+ ladder, VIP-prioritized):
#   1. EC-Early non-VIP (~5K, "see you in a bit") @ 5:30 PM CT
#   2. EC-Late non-VIP (~5K, "doors opening soon") @ 5:50 PM CT (parallel)
#   3. VIP all-region (~1.95K, "your seat is saved") @ 6:50 PM CT — best slot for highest converters
#   4. West non-VIP (~1.8K, "just kicked off") @ 7:02 PM CT
#
# Usage:
#   ./schedule-night-staggered.sh 2               # uses defaults
#   ./schedule-night-staggered.sh 2 17:30 17:50 18:50 19:02   # override all times
#
# What it does:
#   - Schedules 3 background processes via the existing schedule-night-reminder.sh pattern
#   - Each batch filters by --region E / C / W
#   - All PIDs + start times logged to scheduler-jobs.txt for visibility/cancel

set -e

NIGHT="${1:-1}"
TIME_EARLY="${2:-17:30}"   # 5:30 PM CT → EC-early non-VIP (~4K, "see you in a bit"), drains 5:50
TIME_LATE="${3:-17:50}"    # 5:50 PM CT → EC-late non-VIP (~4K, "doors opening soon"), parallel — drains 6:10
TIME_VIP="${4:-18:50}"     # 6:50 PM CT → VIP all-region (~2K, "your seat is saved"), drains 7:00 — JUST before doors
TIME_WEST="${5:-19:02}"    # 7:02 PM CT → West non-VIP (~1.5K, "just kicked off"), drains 7:10

if [[ ! "$NIGHT" =~ ^[1-4]$ ]]; then
  echo "ERROR: night must be 1, 2, 3, or 4"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEND_SCRIPT="$SCRIPT_DIR/sms-night-reminder.js"
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

NOW_EPOCH=$(date +%s)
TODAY=$(date +%Y-%m-%d)

schedule_batch() {
  local REGION="$1"
  local BATCH="$2"
  local TIME_LOCAL="$3"
  local LABEL="$4"
  local EXTRA_FLAGS="$5"   # e.g., "--exclude-vip" or "--vip-only"

  TARGET_EPOCH=$(date -j -f "%Y-%m-%d %H:%M" "$TODAY $TIME_LOCAL" +%s 2>/dev/null || echo "")
  if [[ -z "$TARGET_EPOCH" ]]; then
    echo "  ✗ $LABEL ($TIME_LOCAL): could not parse time"
    return 1
  fi
  SLEEP_SEC=$((TARGET_EPOCH - NOW_EPOCH))
  if [[ $SLEEP_SEC -le 0 ]]; then
    echo "  ⚠ $LABEL ($TIME_LOCAL): target is in the PAST — skipping"
    return 0
  fi

  LOG="$LOG_DIR/N${NIGHT}-${LABEL}-$(date +%Y%m%d-%H%M%S).log"
  (
    exec </dev/null
    sleep "$SLEEP_SEC"
    echo "[$(date)] Firing Night $NIGHT $LABEL (region=$REGION batch=$BATCH $EXTRA_FLAGS)..." >> "$LOG"
    cd "$SCRIPT_DIR/.."
    node "$SEND_SCRIPT" --night "$NIGHT" --region "$REGION" --batch "$BATCH" $EXTRA_FLAGS --confirm >> "$LOG" 2>&1
    echo "[$(date)] $LABEL complete. Exit code: $?" >> "$LOG"
  ) &
  PID=$!
  disown

  printf "  ✓ %-14s %s (in %d min) · PID %d · region=%s batch=%s %s\n" \
    "$LABEL" "$TIME_LOCAL" "$((SLEEP_SEC / 60))" "$PID" "$REGION" "$BATCH" "$EXTRA_FLAGS"
  echo "    Log: tail -f $LOG"
  echo "$PID|$TARGET_EPOCH|$NIGHT|${REGION}-${BATCH}|$LOG" >> "$LOG_DIR/scheduler-jobs.txt"
}

echo ""
echo "================================================="
echo "  FYP Night $NIGHT — Staggered SMS (4 batches, VIP-prioritized)"
echo "================================================="
echo "  Now: $(date '+%H:%M %Z')"
echo "  Event start: 7:00 PM CT ($TODAY)"
echo "  Batches (in fire order):"
echo "    EC-Early ($TIME_EARLY): non-VIP, \"see you in a bit\""
echo "    EC-Late  ($TIME_LATE):  non-VIP, \"doors opening soon\" (parallel w/ EC-Early)"
echo "    VIP      ($TIME_VIP):   ALL VIPs (all regions), \"your seat is saved\" — best slot 🔥"
echo "    West     ($TIME_WEST):  West non-VIP, \"just kicked off\""
echo ""

schedule_batch "EC"  "early" "$TIME_EARLY" "EC-EARLY" "--exclude-vip"
schedule_batch "EC"  "late"  "$TIME_LATE"  "EC-LATE"  "--exclude-vip"
schedule_batch "ECW" "vip"   "$TIME_VIP"   "VIP"      "--vip-only"
schedule_batch "W"   "west"  "$TIME_WEST"  "WEST"     "--exclude-vip"

echo ""
echo "All batches scheduled. Watch with:"
echo "  tail -f $LOG_DIR/N${NIGHT}-*.log"
echo ""
echo "Cancel ALL pending jobs for Night $NIGHT:"
echo "  awk -F'|' '\$3 == \"$NIGHT\" {print \$1}' $LOG_DIR/scheduler-jobs.txt | xargs -n1 kill 2>/dev/null"
echo ""
