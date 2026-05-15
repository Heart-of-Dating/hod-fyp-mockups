#!/usr/bin/env node
// FYP May 2026 — Telnyx welcome SMS backfill for existing AC registrants.
//
// Why this exists: registrations created before TELNYX_LIVE was flipped on never got the
// welcome SMS that the live /api/register.js path now sends. This script walks the AC
// `SMS_Optin_Yes` tag, double-checks custom field 19 (sms_optin == "yes"), normalizes
// phones with the same toE164US() logic as register.js, and sends the IDENTICAL
// WELCOME_SMS_BODY so backfill messages are indistinguishable from organic-flow messages.
//
// Default = dry run. Pass --confirm to actually hit Telnyx.
//
// Env vars (required):
//   AC_API_URL, AC_API_KEY                        — source ~/.claude/activecampaign.env
//   TELNYX_API_KEY, TELNYX_FROM_NUMBER,
//   TELNYX_MESSAGING_PROFILE_ID                   — supply via env or .env (do not hardcode)
//
// Usage:
//   node scripts/sms-backfill.js                                 # dry run
//   node scripts/sms-backfill.js --confirm                       # actually send
//   node scripts/sms-backfill.js --limit=10                      # cap for testing
//   node scripts/sms-backfill.js --tag=SMS_Optin_Yes             # override filter tag
//   node scripts/sms-backfill.js --resume=scripts/logs/foo.jsonl # skip already-sent

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ---- Constants (kept verbatim from functions/api/register.js) -------------------------

const WELCOME_SMS_BODY = "Heart of Dating: You're in for the Find Your Person Challenge! Save this number — we'll text you 1hr before each night. Reply STOP to opt out, HELP for help.";

const SMS_OPTIN_FIELD_ID = 19; // AC custom field id for sms_optin ("yes"/"no")

function toE164US(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (String(raw).trim().startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}

// ---- CLI ------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { confirm: false, tag: "SMS_Optin_Yes", limit: Infinity, resume: null };
  for (const a of argv.slice(2)) {
    if (a === "--confirm") out.confirm = true;
    else if (a.startsWith("--tag=")) out.tag = a.slice(6);
    else if (a.startsWith("--limit=")) {
      const n = parseInt(a.slice(8), 10);
      if (!Number.isFinite(n) || n <= 0) { console.error(`Bad --limit value: ${a}`); process.exit(2); }
      out.limit = n;
    } else if (a.startsWith("--resume=")) out.resume = a.slice(9);
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); printHelp(); process.exit(2); }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/sms-backfill.js [--confirm] [--tag=NAME] [--limit=N] [--resume=path]`);
}

// ---- Env ------------------------------------------------------------------------------

function requireEnv(name, { needForSend } = {}) {
  const v = process.env[name];
  if (!v) {
    const ctx = needForSend ? " (required when --confirm is passed)" : "";
    throw new Error(`Missing env var: ${name}${ctx}`);
  }
  return v;
}

// ---- AC fetch helper ------------------------------------------------------------------

async function ac(env, pathSuffix) {
  const url = `${env.AC_API_URL.replace(/\/$/, "")}/api/3${pathSuffix}`;
  const r = await fetch(url, {
    headers: { "Api-Token": env.AC_API_KEY, "Content-Type": "application/json" },
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`AC ${pathSuffix} → ${r.status}: ${text.slice(0, 400)}`);
  }
  try { return JSON.parse(text); } catch { throw new Error(`AC ${pathSuffix} returned non-JSON: ${text.slice(0, 200)}`); }
}

async function resolveTagId(env, tagName) {
  const data = await ac(env, `/tags?search=${encodeURIComponent(tagName)}`);
  const match = (data.tags || []).find(t => t.tag === tagName);
  if (!match) throw new Error(`Tag not found in AC: "${tagName}"`);
  return match.id;
}

// Page through contacts for a given tag id. Yields contacts in batches of up to 100.
async function* iterContactsByTag(env, tagId) {
  const pageSize = 100;
  let offset = 0;
  while (true) {
    const data = await ac(env, `/contacts?tagid=${tagId}&limit=${pageSize}&offset=${offset}`);
    const contacts = data.contacts || [];
    if (contacts.length === 0) return;
    yield contacts;
    if (contacts.length < pageSize) return;
    offset += pageSize;
  }
}

// Pull the sms_optin custom field for a single contact. AC returns these via /contacts/:id/fieldValues.
async function fetchSmsOptin(env, contactId) {
  const data = await ac(env, `/contacts/${contactId}/fieldValues`);
  const fv = (data.fieldValues || []).find(f => Number(f.field) === SMS_OPTIN_FIELD_ID);
  return fv ? String(fv.value || "").trim().toLowerCase() : "";
}

// ---- Telnyx send ----------------------------------------------------------------------

async function sendTelnyx(env, toE164) {
  const r = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.TELNYX_FROM_NUMBER,
      to: toE164,
      text: WELCOME_SMS_BODY,
      messaging_profile_id: env.TELNYX_MESSAGING_PROFILE_ID,
    }),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: r.ok, status: r.status, body };
}

// ---- Resume log parsing ---------------------------------------------------------------

async function loadResumeSet(resumePath) {
  const done = new Set();
  if (!resumePath) return done;
  if (!fs.existsSync(resumePath)) throw new Error(`--resume file not found: ${resumePath}`);
  const stream = fs.createReadStream(resumePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.contactId && (row.status === "sent" || row.status === "would-send")) {
        done.add(String(row.contactId));
      }
    } catch { /* skip malformed */ }
  }
  return done;
}

// ---- Log writer -----------------------------------------------------------------------

function makeLogger(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  return {
    write(obj) {
      stream.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
    },
    async close() {
      return new Promise(res => stream.end(res));
    },
  };
}

// ---- Main -----------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = Date.now();

  // Env
  const env = {
    AC_API_URL: requireEnv("AC_API_URL"),
    AC_API_KEY: requireEnv("AC_API_KEY"),
  };
  if (args.confirm) {
    env.TELNYX_API_KEY = requireEnv("TELNYX_API_KEY", { needForSend: true });
    env.TELNYX_FROM_NUMBER = requireEnv("TELNYX_FROM_NUMBER", { needForSend: true });
    env.TELNYX_MESSAGING_PROFILE_ID = requireEnv("TELNYX_MESSAGING_PROFILE_ID", { needForSend: true });
  }

  // Banner
  const ts = new Date();
  const stamp = ts.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const logPath = path.join(__dirname, "logs", `backfill-${stamp}.jsonl`);

  console.log("=".repeat(72));
  if (args.confirm) {
    console.log("LIVE MODE — messages WILL be sent via Telnyx.");
  } else {
    console.log("DRY RUN MODE — pass --confirm to actually send. No Telnyx calls will be made.");
  }
  console.log(`Tag filter:   ${args.tag}`);
  console.log(`Limit:        ${Number.isFinite(args.limit) ? args.limit : "unlimited"}`);
  console.log(`Resume from:  ${args.resume || "(none)"}`);
  console.log(`Log file:     ${logPath}`);
  console.log("=".repeat(72));

  // Resume set
  const alreadyDone = await loadResumeSet(args.resume);
  if (alreadyDone.size) console.log(`Resume: skipping ${alreadyDone.size} contacts already sent/would-send.`);

  const log = makeLogger(logPath);

  // Tallies
  let processed = 0, sent = 0, skipped = 0, failed = 0, wouldSend = 0;

  // SIGINT — flush + exit cleanly so partial runs remain resumable.
  let interrupted = false;
  process.on("SIGINT", () => {
    interrupted = true;
    console.log("\nSIGINT — flushing log and exiting...");
  });

  // Resolve tag → id
  const tagId = await resolveTagId(env, args.tag);
  console.log(`Resolved tag "${args.tag}" → id=${tagId}`);

  outer:
  for await (const page of iterContactsByTag(env, tagId)) {
    for (const c of page) {
      if (interrupted) break outer;
      if (processed >= args.limit) break outer;

      const contactId = String(c.id);
      const email = (c.email || "").toLowerCase();
      const rawPhone = c.phone || "";

      if (alreadyDone.has(contactId)) continue;

      processed++;

      // No phone → skip
      if (!rawPhone.trim()) {
        skipped++;
        log.write({ contactId, email, phoneE164: null, status: "skipped", reason: "no-phone" });
        maybeTick(processed, sent, skipped, failed, wouldSend);
        continue;
      }

      // Defense in depth: double-check sms_optin custom field
      let optin;
      try {
        optin = await fetchSmsOptin(env, contactId);
      } catch (e) {
        failed++;
        log.write({ contactId, email, phoneE164: null, status: "failed", reason: "ac-fieldvalues-fetch", error: e.message });
        maybeTick(processed, sent, skipped, failed, wouldSend);
        continue;
      }
      if (optin !== "yes") {
        skipped++;
        log.write({ contactId, email, phoneE164: null, status: "skipped", reason: "sms-optin-no" });
        maybeTick(processed, sent, skipped, failed, wouldSend);
        continue;
      }

      // Normalize phone
      const toE164 = toE164US(rawPhone);
      if (!toE164) {
        skipped++;
        log.write({ contactId, email, phoneE164: null, status: "skipped", reason: "phone-not-normalizable" });
        maybeTick(processed, sent, skipped, failed, wouldSend);
        continue;
      }

      // Dry-run path
      if (!args.confirm) {
        wouldSend++;
        log.write({
          contactId, email, phoneE164: toE164, status: "would-send",
          emailPrefix: email.slice(0, 6),
        });
        maybeTick(processed, sent, skipped, failed, wouldSend);
        continue;
      }

      // Live send
      try {
        const r = await sendTelnyx(env, toE164);
        if (r.ok) {
          sent++;
          const telnyxMessageId = r.body?.data?.id || null;
          log.write({ contactId, email, phoneE164: toE164, status: "sent", telnyxMessageId });
        } else {
          failed++;
          log.write({
            contactId, email, phoneE164: toE164, status: "failed",
            reason: `telnyx-${r.status}`,
            error: typeof r.body === "object" ? JSON.stringify(r.body).slice(0, 500) : String(r.body).slice(0, 500),
          });
        }
      } catch (e) {
        failed++;
        log.write({ contactId, email, phoneE164: toE164, status: "failed", reason: "telnyx-throw", error: e.message });
      }

      maybeTick(processed, sent, skipped, failed, wouldSend);

      // Rate limit: ~5 msg/sec
      await new Promise(r => setTimeout(r, 200));
    }
  }

  await log.close();

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("=".repeat(72));
  console.log(`Done. processed=${processed} sent=${sent} would-send=${wouldSend} skipped=${skipped} failed=${failed}`);
  console.log(`Elapsed: ${elapsed}s`);
  console.log(`Log:     ${logPath}`);
  if (interrupted) console.log("(Run was interrupted — rerun with --resume=<log> to continue.)");
  console.log("=".repeat(72));
}

function maybeTick(processed, sent, skipped, failed, wouldSend) {
  if (processed % 25 === 0) {
    console.log(`Processed ${processed}: sent=${sent} would-send=${wouldSend} skipped=${skipped} failed=${failed}`);
  }
}

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
