#!/bin/bash
# Schedule a one-shot SMS night reminder.
# Usage:
#   ./scripts/schedule-night-reminder.sh 1 17:50    # Night 1, fires at 5:50 PM today (local time)
#   ./scripts/schedule-night-reminder.sh 2 17:50    # Night 2 ...
#
# What it does:
#   1. Computes seconds-until-target
#   2. Forks a background process that sleeps until target, then runs the send script
#   3. Logs the PID + target time so you can cancel via `kill <pid>` if needed
#   4. Tail the log to watch progress: tail -f scripts/logs/scheduler-N1.log

set -e

NIGHT="${1:-1}"
TARGET_LOCAL="${2:-17:50}"   # 5:50 PM local time default (so 12K finishes by 6:40)

if [[ ! "$NIGHT" =~ ^[1-4]$ ]]; then
  echo "ERROR: night must be 1, 2, 3, or 4"
  exit 1
fi
if [[ ! "$TARGET_LOCAL" =~ ^[0-9]{2}:[0-9]{2}$ ]]; then
  echo "ERROR: target time must be HH:MM (24hr local)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEND_SCRIPT="$SCRIPT_DIR/sms-night-reminder.js"
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

# Compute seconds until target local time TODAY
NOW_EPOCH=$(date +%s)
# macOS-friendly target computation
TARGET_EPOCH=$(date -j -f "%Y-%m-%d %H:%M" "$(date +%Y-%m-%d) $TARGET_LOCAL" +%s 2>/dev/null || echo "")

if [[ -z "$TARGET_EPOCH" ]]; then
  echo "ERROR: could not parse target time"
  exit 1
fi

SLEEP_SEC=$((TARGET_EPOCH - NOW_EPOCH))

if [[ $SLEEP_SEC -le 0 ]]; then
  echo "ERROR: target time $TARGET_LOCAL is in the past (now: $(date +%H:%M))"
  echo "       you can run the send NOW with: node scripts/sms-night-reminder.js --night $NIGHT --confirm"
  exit 1
fi

LOG="$LOG_DIR/scheduler-N${NIGHT}-$(date +%Y%m%d-%H%M%S).log"

echo ""
echo "========================================="
echo "  FYP Night $NIGHT — Scheduled SMS Send"
echo "========================================="
echo "  Target time: $TARGET_LOCAL ($(date -r $TARGET_EPOCH))"
echo "  Sleep until fire: $SLEEP_SEC seconds (~$((SLEEP_SEC / 60)) min)"
echo "  Send script: $SEND_SCRIPT"
echo "  Log: $LOG"
echo ""

# Fork: sleep, then run send. Use nohup + setsid-style trick so it survives terminal close.
(
  exec </dev/null
  sleep "$SLEEP_SEC"
  echo "[$(date)] Firing Night $NIGHT SMS send..." >> "$LOG"
  cd "$SCRIPT_DIR/.."
  node "$SEND_SCRIPT" --night "$NIGHT" --confirm >> "$LOG" 2>&1
  echo "[$(date)] Send complete. Exit code: $?" >> "$LOG"
) &

PID=$!
disown

echo "✓ Scheduled. Background PID: $PID"
echo ""
echo "Watch progress:"
echo "  tail -f $LOG"
echo ""
echo "Cancel:"
echo "  kill $PID"
echo ""
echo "Verify still alive (after some time):"
echo "  ps -p $PID"
echo ""

# Persist the PID + target for ops visibility
echo "$PID|$TARGET_EPOCH|$NIGHT|$LOG" >> "$LOG_DIR/scheduler-jobs.txt"
echo "Job recorded to: $LOG_DIR/scheduler-jobs.txt"
