#!/usr/bin/env node
// One-off: send Banjo opener + 4 night-of reminder previews to Alana, Kait, Keyla
// so JJ can validate the SMS pipeline + link mechanics before the live launch.
//
// Run: node scripts/sms-team-preview.js          (dry-run, prints what would send)
//      node scripts/sms-team-preview.js --confirm (actually sends)
//
// Required env (auto-loaded from scripts/.env):
//   TELNYX_API_KEY, TELNYX_MESSAGING_PROFILE_ID
//   TELNYX_NUMBERS_EAST, TELNYX_NUMBERS_CENTRAL (uses first one)

const fs = require("fs");
const path = require("path");

// Load .env
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

const CONFIRM = process.argv.includes("--confirm");
const API_KEY = process.env.TELNYX_API_KEY;
const PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;
const NUM_EAST = (process.env.TELNYX_NUMBERS_EAST || "").split(",")[0];
const NUM_CENTRAL = (process.env.TELNYX_NUMBERS_CENTRAL || "").split(",");

// Recipients with timezone-routed FROM number
const recipients = [
  { name: "Alana", to: "+18642803833", from: NUM_EAST },               // SC = East → 917 NYC
  { name: "Kait",  to: "+12146761013", from: NUM_CENTRAL[0] },         // TX = Central → 615-9970
  { name: "Keyla", to: "+16153087854", from: NUM_CENTRAL[1] || NUM_CENTRAL[0] }, // TN = Central → 615-9956
];

const messages = [
  // 1. Banjo opener
  `hey its banjo - i hijacked jjs laptop (dont tell him or he hides the trashcan from me). sending you the 4 FYP night previews - tap each link pls. love u`,

  // 2. Night 1 — Cloud
  `FYP Night 1 x the Dr. Henry Cloud... Doors open in 20 min. The guy who wrote Boundaries, How to Get a Date Worth Keeping.. The GOAT.. See you sooN!
fyp.heartofdating.com/FYPN1

Kait & JJ`,

  // 3. Night 2 — Kait & JJ
  `FYP Night 2. It's me JJ tonight.. oh and Kait.. Bring snacks, listening ears, receipts. All of it. 20 min out. Love u.
fyp.heartofdating.com/FYPN2

- JJ (& Kait)`,

  // 4. Night 3 — AFD
  `FYP Night 3 x Annie F. Downs. Yes, the Queen herself. She is joining and we're still not over it.
fyp.heartofdating.com/FYPN3

Kait & JJ`,

  // 5. Night 4 — Finale
  `FYP Final Night: It's closing time... If you don't get married from this challenge I will personally refund your expensive ticket it cost to register. Love u.
fyp.heartofdating.com/FYPN4

Kait & Awesome JJ`,
];

async function sendOne({ to, from, text, recipient, msgIdx }) {
  const body = {
    from,
    to,
    text,
    messaging_profile_id: PROFILE_ID,
    use_profile_webhooks: false,
  };
  const r = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(data)}`);
  return data.data?.id;
}

async function main() {
  if (!API_KEY || !PROFILE_ID || !NUM_EAST || !NUM_CENTRAL[0]) {
    console.error("Missing env. Need TELNYX_API_KEY + TELNYX_MESSAGING_PROFILE_ID + TELNYX_NUMBERS_EAST + TELNYX_NUMBERS_CENTRAL");
    process.exit(1);
  }

  console.log(`Mode: ${CONFIRM ? "LIVE SEND" : "DRY-RUN (use --confirm to actually send)"}`);
  console.log(`Recipients: ${recipients.length} · Messages each: ${messages.length} · Total sends: ${recipients.length * messages.length}\n`);

  for (const r of recipients) {
    console.log(`--- ${r.name} (${r.to}) from ${r.from} ---`);
    for (let i = 0; i < messages.length; i++) {
      const text = messages[i];
      const label = i === 0 ? "BANJO" : `N${i}`;
      console.log(`  [${label}] ${text.split("\n")[0].slice(0, 70)}...`);
      if (CONFIRM) {
        try {
          const id = await sendOne({ to: r.to, from: r.from, text, recipient: r.name, msgIdx: i });
          console.log(`    ✓ telnyx id: ${id}`);
        } catch (e) {
          console.log(`    ✗ ERROR: ${e.message}`);
        }
        // Pace at ~2 msg/sec to stay well under campaign cap
        await new Promise((res) => setTimeout(res, 500));
      }
    }
    console.log("");
  }
  console.log(CONFIRM ? "✓ Done. Check phones." : "(dry-run complete)");
}

main().catch((e) => { console.error(e); process.exit(1); });
