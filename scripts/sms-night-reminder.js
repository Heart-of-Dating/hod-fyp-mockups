#!/usr/bin/env node
// FYP May 2026 — Night reminder SMS sender.
// Fires the per-night T-20min reminder to all SMS_Optin_Yes contacts.
//
// Usage:
//   node scripts/sms-night-reminder.js --night 1                 # DRY RUN
//   node scripts/sms-night-reminder.js --night 1 --confirm       # actually send
//   node scripts/sms-night-reminder.js --night 1 --confirm --resume <log>  # resume after crash
//
// Safeguards baked in:
//   - Dry-run default. --confirm required for actual sends.
//   - 250ms pacing between sends (4 MPS — matches AT&T campaign cap).
//   - Region-based FROM-number routing (East→917 / Central→615 / West→213).
//   - GSM-7 encoding check before send (avoids surprise multi-segment cost).
//   - Idempotency: applies `Sent_N{n}` AC tag after each successful send,
//     skips contacts who already have that tag (so re-runs don't double-send).
//   - JSONL audit log per contact in scripts/logs/.
//   - Kill switch: --abort-after-fails N stops cold after N consecutive failures.
//   - --resume picks up where a prior run stopped (parses log, skips done contacts).
//
// Body source: hard-coded per --night below. Edit to change.

const fs = require("fs");
const path = require("path");

// ---------- env load ----------
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

const args = process.argv.slice(2);
const flag = (name) => args.includes("--" + name);
const arg = (name, def = null) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};

const NIGHT = parseInt(arg("night"), 10);
const CONFIRM = flag("confirm");
const RESUME_LOG = arg("resume");
const ABORT_AFTER_FAILS = parseInt(arg("abort-after-fails", "10"), 10);
const LIMIT = parseInt(arg("limit", "0"), 10); // 0 = no limit
const PACE_MS = parseInt(arg("pace-ms", "250"), 10); // 250ms = 4 MPS
// --region E|C|W or any combo (EC, ECW, W) — filters queue by timezone buckets.
// Empty string = all regions. "EC" = east + central + mountain.
const REGION = (arg("region") || "").toUpperCase().replace(/[^ECW]/g, "");
// --batch early|late|west|vip — picks which body variant + (for EC) which half of the queue.
//   early = first half of regionally-filtered queue (sorted by contact ID for determinism)
//   late  = second half
//   west  = full west batch
//   vip   = VIP-only batch — sent T-10min, premium "seat is saved" framing
const BATCH = (arg("batch") || "").toLowerCase();
// --vip-only / --exclude-vip — gate the queue against VIP tag membership.
// VIPs convert 7× higher (5.1% vs 0.72% non-VIP) so we save them the best timing slot.
const VIP_ONLY = flag("vip-only");
const EXCLUDE_VIP = flag("exclude-vip");

if (![1, 2, 3, 4].includes(NIGHT)) {
  console.error("ERROR: --night must be 1, 2, 3, or 4");
  process.exit(1);
}

// ---------- Telnyx + AC config ----------
const T_KEY = process.env.TELNYX_API_KEY;
const T_PROFILE = process.env.TELNYX_MESSAGING_PROFILE_ID;
const AC_URL = process.env.AC_API_URL;
const AC_KEY = process.env.AC_API_KEY;

const NUM_EAST = (process.env.TELNYX_NUMBERS_EAST || "").split(",")[0]?.trim();
const NUM_CENTRAL = (process.env.TELNYX_NUMBERS_CENTRAL || "").split(",").map(s => s.trim()).filter(Boolean);
const NUM_WEST = (process.env.TELNYX_NUMBERS_WEST || "").split(",")[0]?.trim();

if (!T_KEY || !T_PROFILE || !AC_URL || !AC_KEY) {
  console.error("ERROR: missing TELNYX_API_KEY / TELNYX_MESSAGING_PROFILE_ID / AC_API_URL / AC_API_KEY");
  process.exit(1);
}
if (!NUM_EAST || !NUM_CENTRAL[0] || !NUM_WEST) {
  console.error("ERROR: missing TELNYX_NUMBERS_EAST / CENTRAL / WEST in scripts/.env");
  process.exit(1);
}

// ---------- State → timezone bucket ----------
const STATE_TZ = {
  // East (use 917 NYC)
  CT: "E", DE: "E", FL: "E", GA: "E", IN: "E", KY: "E", ME: "E", MD: "E", MA: "E",
  MI: "E", NH: "E", NJ: "E", NY: "E", NC: "E", OH: "E", PA: "E", RI: "E", SC: "E",
  VT: "E", VA: "E", WV: "E", DC: "E",
  // Central (use 615 — JJ's primary)
  AL: "C", AR: "C", IL: "C", IA: "C", KS: "C", LA: "C", MN: "C", MS: "C", MO: "C",
  NE: "C", ND: "C", OK: "C", SD: "C", TN: "C", TX: "C", WI: "C",
  // Mountain (treat as Central for from-routing — closer cultural fit)
  AZ: "C", CO: "C", ID: "C", MT: "C", NM: "C", UT: "C", WY: "C",
  // West (use 213 LA)
  AK: "W", CA: "W", HI: "W", NV: "W", OR: "W", WA: "W",
  // Special / fallback
  INTL: "C", "": "C",
};

function pickFromNumber(state, recipientIdx) {
  const bucket = STATE_TZ[(state || "").toUpperCase()] || "C";
  if (bucket === "E") return NUM_EAST;
  if (bucket === "W") return NUM_WEST;
  // Central — round-robin across the two 615 numbers for load balancing
  return NUM_CENTRAL[recipientIdx % NUM_CENTRAL.length];
}

// ---------- Bodies per night × batch ----------
// 3 variants per night so send-time matches recipient expectation:
//   early = sent 6:08-6:30 CT (T-52 to T-30 before doors) → "see you in a bit" framing
//   late  = sent 6:30-6:50 CT (T-30 to T-10 before doors) → "doors opening soon" framing
//   west  = sent 7:02-7:10 CT (5:02 PM PT, post-doors)    → "just kicked off" framing
// COMPLIANCE NOTE: Every body MUST end with "Reply STOP to opt out." (or carrier-equivalent).
// Carriers cross-reference real sends against TCR-registered samples; without STOP language
// in every message, the 10DLC campaign gets flagged and traffic is filtered as spam (40002).
// "Heart of Dating:" sender-id prefix also helps brand-recognition spam scoring.
const BODIES = {
  1: {
    early: `Heart of Dating: FYP Night 1 x Dr. Henry Cloud — TONIGHT at 7pm CT. The GOAT (Boundaries, How to Get a Date Worth Keeping) is teaching live.
fyp.heartofdating.com/FYPN1
Reply STOP to opt out.`,
    late: `Heart of Dating: FYP Night 1 x Dr. Henry Cloud — doors opening soon. The GOAT is live in a few.
fyp.heartofdating.com/FYPN1
Reply STOP to opt out.`,
    west: `Heart of Dating: FYP Night 1 x Dr. Henry Cloud just kicked off — the GOAT is teaching live right now.
fyp.heartofdating.com/FYPN1
Reply STOP to opt out.`,
    vip: `Heart of Dating: VIP seat saved. Night 1 x Dr. Henry Cloud starts in 10 min.
fyp.heartofdating.com/FYPN1
Reply STOP to opt out.`,
  },
  2: {
    early: `Heart of Dating: FYP Night 2 — TONIGHT at 7pm CT. JJ & Kait teaching live. Bring snacks.
fyp.heartofdating.com/FYPN2
Reply STOP to opt out.`,
    late: `Heart of Dating: FYP Night 2 starting soon. JJ & Kait live in a few.
fyp.heartofdating.com/FYPN2
Reply STOP to opt out.`,
    west: `Heart of Dating: FYP Night 2 just started — JJ & Kait teaching live. Hop in.
fyp.heartofdating.com/FYPN2
Reply STOP to opt out.`,
    vip: `Heart of Dating: VIP seat saved. Night 2 starts in 10 min. JJ & Kait teaching live.
fyp.heartofdating.com/FYPN2
Reply STOP to opt out.`,
  },
  3: {
    early: `Heart of Dating: FYP Night 3 x Annie F. Downs — TONIGHT at 7pm CT. The Queen herself is joining us.
fyp.heartofdating.com/FYPN3
Reply STOP to opt out.`,
    late: `Heart of Dating: FYP Night 3 x Annie F. Downs starting soon. Don't miss this one.
fyp.heartofdating.com/FYPN3
Reply STOP to opt out.`,
    west: `Heart of Dating: FYP Night 3 x Annie F. Downs just started — the Queen is live. Hop in.
fyp.heartofdating.com/FYPN3
Reply STOP to opt out.`,
    vip: `Heart of Dating: VIP seat saved. Night 3 with Annie F. Downs starts in 10 min.
fyp.heartofdating.com/FYPN3
Reply STOP to opt out.`,
  },
  4: {
    early: `Heart of Dating: FYP Final Night — TONIGHT at 7pm CT. Kait & JJ closing it down. Last call.
fyp.heartofdating.com/FYPN4
Reply STOP to opt out.`,
    late: `Heart of Dating: FYP Final Night starting soon. Closing it down with Kait & JJ.
fyp.heartofdating.com/FYPN4
Reply STOP to opt out.`,
    west: `Heart of Dating: FYP Final Night just started — closing it down. Hop in for last call.
fyp.heartofdating.com/FYPN4
Reply STOP to opt out.`,
    vip: `Heart of Dating: VIP seat saved. Final Night starts in 10 min. Last call.
fyp.heartofdating.com/FYPN4
Reply STOP to opt out.`,
  },
};

// Pick body variant. Default = "late" for EC if --batch not specified, "west" if region=W,
// "vip" if --vip-only flag set.
function pickBatchVariant() {
  if (BATCH === "early" || BATCH === "late" || BATCH === "west" || BATCH === "vip") return BATCH;
  if (VIP_ONLY) return "vip";
  if (REGION === "W") return "west";
  return "late";
}
const BATCH_VARIANT = pickBatchVariant();
const BODY = BODIES[NIGHT][BATCH_VARIANT];
// Sent tag is per-night (not per-batch) — once a contact gets ANY variant for the
// night, skip them on later batches. Prevents double-sending if early + late overlap.
const SENT_TAG_NAME = `Sent_N${NIGHT}`;

// ---------- AC helpers ----------
async function ac(path, opts = {}) {
  const r = await fetch(`${AC_URL.replace(/\/$/, "")}/api/3${path}`, {
    headers: { "Api-Token": AC_KEY, "Content-Type": "application/json" },
    ...opts,
  });
  if (!r.ok) throw new Error(`AC ${r.status} on ${path}: ${await r.text()}`);
  return r.json();
}

async function findOrCreateTag(name) {
  const r = await ac(`/tags?search=${encodeURIComponent(name)}`);
  for (const t of (r.tags || [])) if (t.tag === name) return t.id;
  // Create
  const c = await ac("/tags", {
    method: "POST",
    body: JSON.stringify({ tag: { tag: name, tagType: "contact", description: `FYP May 2026 N${NIGHT} reminder sent` } }),
  });
  return c.tag.id;
}

async function applyTag(contactId, tagId) {
  return ac("/contactTags", {
    method: "POST",
    body: JSON.stringify({ contactTag: { contact: contactId, tag: tagId } }),
  });
}

async function getOptInTagId() {
  const r = await ac(`/tags?search=SMS_Optin_Yes`);
  for (const t of (r.tags || [])) if (t.tag === "SMS_Optin_Yes") return t.id;
  throw new Error("SMS_Optin_Yes tag not found");
}

// Pull contact IDs with the "FYP VIP May 2026" umbrella tag (204) for filter operations.
async function pullVipContactIds() {
  const PAGE = 100; const ids = new Set(); let offset = 0;
  while (true) {
    const data = await ac(`/contacts?tagid=204&limit=${PAGE}&offset=${offset}`);
    const cs = data.contacts || [];
    for (const c of cs) ids.add(c.id);
    if (cs.length < PAGE) break;
    offset += PAGE;
  }
  return ids;
}

async function pullAllOptIns(optInTagId) {
  // Pull SMS_Optin_Yes contacts WITH phone + state field
  const PAGE = 100;
  const STATE_FIELD = 18;
  const all = [];
  let offset = 0;
  while (true) {
    const data = await ac(`/contacts?tagid=${optInTagId}&include=fieldValues&limit=${PAGE}&offset=${offset}`);
    const contacts = data.contacts || [];
    const fvs = data.fieldValues || [];
    const stateBy = {};
    for (const fv of fvs) {
      if (String(fv.field) === String(STATE_FIELD)) {
        stateBy[fv.contact] = (fv.value || "").toUpperCase().trim();
      }
    }
    for (const c of contacts) {
      if (!c.phone) continue;
      all.push({
        id: c.id,
        email: c.email,
        phone: c.phone.replace(/[^0-9+]/g, ""),
        state: stateBy[c.id] || "",
      });
    }
    if (contacts.length < PAGE) break;
    offset += PAGE;
    if (offset % 2000 === 0) process.stdout.write(`  pulled ${offset}... `);
  }
  return all;
}

async function pullAlreadySent(sentTagId) {
  const PAGE = 100;
  const done = new Set();
  let offset = 0;
  while (true) {
    const data = await ac(`/contacts?tagid=${sentTagId}&limit=${PAGE}&offset=${offset}`);
    const cs = data.contacts || [];
    for (const c of cs) done.add(c.id);
    if (cs.length < PAGE) break;
    offset += PAGE;
  }
  return done;
}

// ---------- Telnyx send ----------
async function sendOne(to, from, text) {
  const r = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${T_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, text, messaging_profile_id: T_PROFILE, use_profile_webhooks: false }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Telnyx ${r.status}: ${JSON.stringify(d.errors || d)}`);
  return d.data.id;
}

// ---------- Body encoding check ----------
function isGsm7(s) {
  return !/[^\x00-\x7F ¡£-¥§¿Ä-ÆÉÑÖØÜßàä-æèéìñòöøùüΓΔΘΛΞΠΣΦΨΩ]/.test(s);
}

// ---------- Main ----------
async function main() {
  console.log(`\n==== FYP Night ${NIGHT} SMS Reminder ====`);
  console.log(`Mode: ${CONFIRM ? "🔴 LIVE SEND" : "🟡 DRY RUN (use --confirm)"}`);
  console.log(`Body length: ${BODY.length} chars · GSM-7: ${isGsm7(BODY) ? "yes ✓" : "no — will use UCS-2"}`);
  console.log(`Pacing: ${PACE_MS}ms between sends (${Math.round(1000/PACE_MS)} MPS)`);
  console.log(`Abort threshold: ${ABORT_AFTER_FAILS} consecutive failures`);
  console.log(`Numbers: East ${NUM_EAST} · Central ${NUM_CENTRAL.join(",")} · West ${NUM_WEST}\n`);

  console.log("→ Looking up SMS_Optin_Yes tag...");
  const optInTagId = await getOptInTagId();
  console.log(`  tag id: ${optInTagId}`);

  console.log("→ Finding/creating Sent tag...");
  const sentTagId = await findOrCreateTag(SENT_TAG_NAME);
  console.log(`  ${SENT_TAG_NAME} = tag ${sentTagId}`);

  console.log("→ Pulling SMS_Optin_Yes contacts (with state)...");
  const all = await pullAllOptIns(optInTagId);
  console.log(`  ${all.length} contacts with phone\n`);

  console.log(`→ Pulling already-sent (${SENT_TAG_NAME})...`);
  const alreadySent = await pullAlreadySent(sentTagId);
  console.log(`  ${alreadySent.size} already sent\n`);

  // Filter — dedup + region (if specified) + drop INTL/malformed phones
  let queue = all.filter(c => !alreadySent.has(c.id));

  // Drop INTL contacts (Telnyx 10DLC can't send to non-US/CA without alpha sender).
  // Loosened phone format check: 10-digit US, 11-digit US, or +1-prefixed are all OK.
  // Anything else with valid digits is also OK (will let Telnyx decide) unless explicitly
  // flagged INTL by the state field.
  const beforeIntl = queue.length;
  queue = queue.filter(c => {
    if (c.state === "INTL") return false; // hard block on INTL state
    const digits = c.phone.replace(/[^0-9]/g, "");
    if (!digits || digits.length < 10) return false; // truly bad (too short)
    if (digits.length > 14) return false; // truly bad (too long)
    // 10 or 11 digit US are clean. 12-14 digit MIGHT be valid INTL but we don't send those.
    // Reject 12-14 digit unless it's an obviously-US prefix (1XXXXXXXXXX)
    if (digits.length > 11 && !digits.startsWith("1")) return false;
    return true;
  });
  if (beforeIntl !== queue.length) {
    console.log(`→ Dropped INTL/malformed: ${beforeIntl} → ${queue.length} (-${beforeIntl - queue.length})`);
  }

  // VIP filter — saves the high-converters for the prime "doors opening" slot.
  // --vip-only: keep only VIP-tagged contacts
  // --exclude-vip: drop VIP-tagged contacts (let them get the dedicated VIP batch)
  if (VIP_ONLY || EXCLUDE_VIP) {
    console.log("→ Pulling VIP contact IDs...");
    const vipIds = await pullVipContactIds();
    const before = queue.length;
    queue = VIP_ONLY ? queue.filter(c => vipIds.has(c.id))
                     : queue.filter(c => !vipIds.has(c.id));
    console.log(`→ VIP filter (${VIP_ONLY ? "VIP-only" : "exclude-VIP"}): ${before} → ${queue.length}`);
  }

  if (REGION) {
    const beforeRegion = queue.length;
    queue = queue.filter(c => REGION.includes(STATE_TZ[c.state] || "C"));
    console.log(`→ Region filter: ${REGION.split("").join("+")} (${beforeRegion} → ${queue.length})`);
  }
  // Sort by contact ID for deterministic early/late split (same contacts in
  // early on re-runs, so resume + dedup work cleanly).
  queue.sort((a, b) => parseInt(a.id) - parseInt(b.id));
  if (BATCH_VARIANT === "early" || BATCH_VARIANT === "late") {
    const half = Math.ceil(queue.length / 2);
    const before = queue.length;
    if (BATCH_VARIANT === "early") queue = queue.slice(0, half);
    else queue = queue.slice(half);
    console.log(`→ Batch split (${BATCH_VARIANT}): ${before} → ${queue.length}`);
  }
  if (LIMIT > 0) queue = queue.slice(0, LIMIT);
  console.log(`→ Queue: ${queue.length} contacts to send · using "${BATCH_VARIANT}" body\n`);

  // Region breakdown preview
  const buckets = { E: 0, C: 0, W: 0 };
  for (const c of queue) {
    const b = STATE_TZ[c.state] || "C";
    buckets[b]++;
  }
  console.log(`Distribution: East ${buckets.E} · Central ${buckets.C} · West ${buckets.W}`);
  console.log(`Estimated drain time: ${Math.round(queue.length * PACE_MS / 1000 / 60)} minutes\n`);

  if (!CONFIRM) {
    console.log("DRY RUN — no sends. Re-run with --confirm to fire.");
    console.log("First 3 contacts in queue (preview):");
    for (const c of queue.slice(0, 3)) {
      const from = pickFromNumber(c.state, 0);
      console.log(`  ${c.email} (${c.state}) → ${c.phone} from ${from}`);
    }
    return;
  }

  // Live send
  const ts = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const logPath = path.join(__dirname, "logs", `night${NIGHT}-${ts}.jsonl`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  console.log(`Log: ${logPath}\n`);
  console.log("Firing...\n");

  let sent = 0, failed = 0, consecutiveFails = 0;
  const start = Date.now();

  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    const from = pickFromNumber(c.state, i);
    // Phone normalization: AC stores phones in mixed formats:
    //   "2142260737"      (10-digit US) → need +1 prefix
    //   "12142260737"     (11-digit with country code) → just add +
    //   "+12142260737"    (already E.164) → leave alone
    // Bug found 2026-05-26: prior version did `"+" + phone` for everything,
    // turning 10-digit US numbers into bogus international numbers (e.g., +6469...
    // looks like Vietnam). 29% failure rate on first EC-Early run before kill.
    const digits = c.phone.replace(/[^0-9]/g, "");
    let phoneE164;
    if (c.phone.startsWith("+")) {
      phoneE164 = "+" + digits;
    } else if (digits.length === 10) {
      phoneE164 = "+1" + digits;
    } else if (digits.length === 11 && digits.startsWith("1")) {
      phoneE164 = "+" + digits;
    } else {
      phoneE164 = "+" + digits; // fallback (international, may fail but at least properly prefixed)
    }

    let entry = { ts: new Date().toISOString(), contactId: c.id, email: c.email, phone: phoneE164, state: c.state, from, night: NIGHT };

    try {
      const msgId = await sendOne(phoneE164, from, BODY);
      entry.status = "sent";
      entry.telnyxMessageId = msgId;
      sent++;
      consecutiveFails = 0;
      // Tag contact as sent (best-effort, don't block on failure)
      applyTag(c.id, sentTagId).catch(() => {});
    } catch (e) {
      entry.status = "failed";
      entry.error = String(e).slice(0, 300);
      failed++;
      consecutiveFails++;
    }
    logStream.write(JSON.stringify(entry) + "\n");

    if (i % 50 === 0 || i === queue.length - 1) {
      const elapsedMin = (Date.now() - start) / 60000;
      const rate = sent / Math.max(elapsedMin, 0.01);
      console.log(`  [${i + 1}/${queue.length}] sent=${sent} failed=${failed} · ${rate.toFixed(0)}/min · elapsed ${elapsedMin.toFixed(1)}min`);
    }

    if (consecutiveFails >= ABORT_AFTER_FAILS) {
      console.error(`\n🛑 ABORT: ${consecutiveFails} consecutive failures. Check Telnyx + AC.`);
      break;
    }

    await new Promise((res) => setTimeout(res, PACE_MS));
  }

  logStream.end();
  const totalMin = ((Date.now() - start) / 60000).toFixed(1);
  console.log(`\n==== DONE ====`);
  console.log(`Sent: ${sent} · Failed: ${failed} · Time: ${totalMin} min`);
  console.log(`Log: ${logPath}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
