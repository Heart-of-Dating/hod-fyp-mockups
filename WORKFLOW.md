# hod-fyp-mockups — Developer / Agent Workflow

This repo powers `fyp.heartofdating.com` (the Find Your Person Challenge funnel) and is deployed via **Cloudflare Pages + Pages Functions**. Two agents work on it: **Bandit** (MacBook Air, daytime) and **Banjo** (Mac Mini, overnight). GitHub is the source of truth; both machines pull/push.

---

## 1. Repo overview

```
hod-fyp-mockups/
├── public/                  # Static site → deployed as Pages
│   ├── fyp/                 # Landing page + VIP + thank-you pages
│   │   └── index.html       # Main FYP landing (2 reg forms, top + bottom CTA)
│   ├── admin/               # Live dashboard
│   │   ├── index.html       # Dashboard UI
│   │   └── login.html       # Single-password login
│   ├── privacy.html         # TCR-compliant privacy policy (SMS clause)
│   ├── terms.html           # T&C
│   └── _headers             # CF Pages headers config
├── functions/               # Pages Functions (server-side)
│   ├── admin/
│   │   └── _middleware.js   # Cookie auth for /admin/*
│   └── api/
│       ├── register.js          # /api/register — AC contact + Meta CAPI + (future) Telnyx welcome SMS
│       ├── admin-login.js       # /api/admin-login — sets auth cookie
│       ├── dashboard.js         # /api/dashboard — admin data feed
│       ├── dashboard-search.js  # /api/dashboard-search?email=... — scoped to FYP-Overall tag
│       └── fyp-visits.js        # /api/fyp-visits — debug endpoint, /fyp/ path-only visits
└── _TOUCH-LOG.md            # Cross-machine collaboration log (see §6)
```

---

## 2. Prerequisites (one-time setup on a fresh machine)

### Node + wrangler

```bash
# Confirm Node 18+
node --version

# Wrangler CLI (used via npx, no global install needed)
# Just ensure npx is available:
which npx
```

### Cloudflare auth

Option A — interactive (browser, only on machines with a browser):
```bash
npx wrangler login
```

Option B — copy from another machine (headless setup):
```bash
# On Bandit (source):
scp ~/.wrangler/config/default.toml squiretomlin@192.168.1.189:~/.wrangler/config/
# Or via Tailscale: squiretomlin@100.116.220.70
```

### GitHub SSH

```bash
# Confirm GitHub SSH access:
ssh -T git@github.com
# Should return: "Hi <username>! You've successfully authenticated..."

# If not set up:
ssh-keygen -t ed25519 -C "banjo@hod"
cat ~/.ssh/id_ed25519.pub  # Add to GitHub → Settings → SSH keys
```

### Clone

```bash
cd ~/Documents
git clone git@github.com:Heart-of-Dating/hod-fyp-mockups.git
git clone git@github.com:Heart-of-Dating/hod-brain.git
```

### Local credentials (NOT in this repo — never commit)

`~/.claude/activecampaign.env` (used by Python scripts that pull AC data outside CF Functions):
```
export AC_URL="https://YOURACCOUNT.api-us1.com"
export AC_API_KEY="..."
```

Copy from Bandit if not present:
```bash
scp ~/.claude/activecampaign.env squiretomlin@192.168.1.189:~/.claude/
```

---

## 3. Cloudflare Pages — project info

| Field | Value |
|---|---|
| **Project name** | `hod-fyp` |
| **Production branch** | `main` |
| **Domains** | `hod-fyp.pages.dev`, `fyp.heartofdating.com` |
| **GitHub auto-deploy** | **DISCONNECTED** (manual deploys only — see §5) |
| **CF Account ID** | `7b868e14935cafbec1815d99b0f63de8` |

### Encrypted secrets stored on Cloudflare Pages (NOT in git)

These are read at runtime by Pages Functions via `env.<NAME>`. Manage via wrangler:

```bash
# Add or rotate:
npx wrangler pages secret put <NAME> --project-name=hod-fyp

# List:
npx wrangler pages secret list --project-name=hod-fyp
```

| Secret | Purpose |
|---|---|
| `AC_API_URL` | ActiveCampaign base URL |
| `AC_API_KEY` | ActiveCampaign API token |
| `AC_LIST_ID` | `28` (FYP May 2026 list) |
| `META_PIXEL_ID` | `869575087492502` |
| `META_CAPI_TOKEN` | Meta Conversions API token |
| `CF_ANALYTICS_TOKEN` | CF GraphQL API token (for dashboard pageview data) |
| `CF_ACCOUNT_ID` | `7b868e14935cafbec1815d99b0f63de8` |
| `TELNYX_API_KEY` | Telnyx SMS API key (post-campaign-approval) |
| `TELNYX_MESSAGING_PROFILE_ID` | Telnyx profile ID (post-approval) |
| `TELNYX_FROM_NUMBER` | `+16154889970` (615 number) |

**Never paste secrets into the chat.** Add via `wrangler pages secret put` and reference by name only.

---

## 4. Admin dashboard

- URL: `https://fyp.heartofdating.com/admin/`
- Auth: single password `jjcool` via `/admin/login.html` (cookie `hod_admin` set for 30 days)
- Source of truth for daily reg counts, conversion, VIP, top states, top referrers
- Backend: `functions/api/dashboard.js` (cached 60s in CF isolate to avoid CPU limit)
- Search backend: `functions/api/dashboard-search.js` (scoped to FYP-Overall tag ID `200` — won't surface contacts from prior challenges or podcast-only)

To change auth password: edit `PASSWORD` const in `functions/admin/_middleware.js` AND `functions/api/admin-login.js`. Cookie value also pinned there — bumping invalidates all current sessions.

---

## 5. Deploy

GitHub auto-deploy is currently disconnected. **All deploys are manual.**

```bash
cd ~/Documents/hod-fyp-mockups
git pull --rebase                            # ALWAYS pull first
# ...make edits...
npx wrangler pages deploy public \
  --project-name=hod-fyp \
  --branch=main \
  --commit-dirty=true
```

Notes:
- `--commit-dirty=true` lets you deploy with uncommitted changes (silences a warning). Use during rapid iteration, but **always commit + push before stepping away**.
- A successful deploy returns a preview URL like `https://abc123.hod-fyp.pages.dev` AND propagates to `fyp.heartofdating.com` within ~30s.
- If you get HTTP 503 with CF error 1102 on `/api/dashboard`, it's CPU-limit overflow. The dashboard.js has a 60s in-memory cache to mitigate — subsequent calls within the same isolate serve from cache.

---

## 6. Cross-machine coordination — _TOUCH-LOG.md

Same protocol as `hod-brain`:

**Before editing anything:**
1. `git pull --rebase`
2. Read the last 10 entries of `_TOUCH-LOG.md` so you know what the other machine just did
3. If the other agent touched a file you're about to edit in the last 30 min, read their diff first

**After committing:**
4. Append a line to `_TOUCH-LOG.md`:
   ```
   YYYY-MM-DD HH:MM TZ — <Agent> edited <path> (<one-line summary>)
   ```
5. Commit the touch-log entry with your code change (same commit is fine)
6. `git push` immediately — don't sit on changes

**Why this matters:** without it, Bandit and Banjo will silently revert each other's work via stale checkouts. The log makes collisions visible before merge time.

---

## 7. Common gotchas

- **Smart quotes break SMS segments.** If editing SMS message bodies, paste through a plain-text editor first. Curly quotes / em-dashes silently 2× the cost per text.
- **Pages Functions `env.VAR` is read-only at runtime.** Secrets must be set via `wrangler pages secret put` (NOT `.dev.vars` for production).
- **Dashboard regs use `udate` not `cdate`** for today's count — this catches re-subscribes from existing AC contacts whose original `cdate` is years old.
- **AC pagination caps at 100/page.** Any pull >100 contacts needs the `pullListWithMeta`-style loop in `dashboard.js`.
- **CF Web Analytics enabled May 13 2026 ~22:30 UTC** — pre-launch data is sparse for that window.
- **Custom field 19 = SMS opt-in (`yes`/`no`)**; **field 18 = state (2-letter)**. Used by registration form + dashboard.
- **Channel tagging:** `?src=paid` on the landing URL routes to `FYP-Paid` tag; everything else (including missing param) routes to `FYP-Organic`. Wired in `functions/api/register.js`.

---

## 8. Mockup → Live tagging rule (from JJ's global rules)

When generating new mockup UI, tag elements:
- `data-mock="wire"` — shape correct, value fake. Swap when API ships.
- `data-mock-src="/api/path:json.key"` — endpoint + path for auto-hydration.
- `data-mock="delete"` — entire structural block that will be replaced by differently-structured live version.
- `data-mock="keep"` — intentionally static placeholder (icons, "coming soon" copy).

Audit: `rg 'data-mock="wire"' public/` shows unwired fake data. Track partial-live pages in `MOCKS.md` (already in this repo).

---

## 9. Telnyx SMS (live as of campaign approval)

- **Provider:** Telnyx (NOT Twilio — see hod-brain `state/fyp-may-2026-launch-state.md` for the migration rationale)
- **From number:** +1-615-488-9970 (Nashville 615, tagged FYP2026 on Telnyx)
- **Brand:** Heart of Dating (verified May 14 2026)
- **Campaign:** Mixed (Marketing + Account Notification) — TCR review pending after May 15 resubmission
- **Throughput:** Standard tier post-approval, ~10 MPS = 25K subs in ~42 min per blast
- **Blast send timing rule:** start at **T-65 min** before event (not T-60) for queue drain headroom
- **Cost:** ~$0.0065/segment all-in (Telnyx + carrier fees). 25K × 4 reminders ≈ $550–650

Implementation pending (see brain state file for current status).

---

## 10. Quick reference — commands

| What | Command |
|---|---|
| Pull latest | `git pull --rebase` |
| Deploy to prod | `npx wrangler pages deploy public --project-name=hod-fyp --branch=main --commit-dirty=true` |
| List CF secrets | `npx wrangler pages secret list --project-name=hod-fyp` |
| Add/rotate CF secret | `npx wrangler pages secret put <NAME> --project-name=hod-fyp` |
| Tail Pages Functions logs | `npx wrangler pages deployment tail --project-name=hod-fyp` |
| Check dashboard live | `curl -b "hod_admin=ok-jjcool-2026" https://fyp.heartofdating.com/api/dashboard` |

---

*Maintained by Bandit 🦝 (MacBook Air) + Banjo 🦝 (Mac Mini). When practices change, update this doc in the same commit.*
