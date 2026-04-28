# Heart of Dating — FYP May 2026 Site

Static HTML site for the Find Your Person Challenge May 26–29, 2026.

**Live URL (target):** `https://heartofdating.com/fyp` (path-preserving proxy via Cloudflare Worker → Pages)
**Hosting:** Cloudflare Pages, deploys from `public/` on push to `main`.
**Setup brief:** see `HOSTING-SETUP.md`.

## Pages

| Path | Source | Purpose |
|---|---|---|
| `/fyp` | `public/fyp/index.html` | Landing — registration form |
| `/fyp/vip` | `public/fyp/vip/index.html` | VIP tripwire ($17) — ThriveCart embed |
| `/fyp/thank-you-vip` | `public/fyp/thank-you-vip/index.html` | Post-purchase confirmation |
| `/fyp/thank-you-free` | `public/fyp/thank-you-free/index.html` | Post-registration (free path) |
| `/api/register` | `public/functions/api/register.js` | Pages Function — proxies form to ActiveCampaign |
| `/fyp/calendar/night-{1-4}.ics` | `public/fyp/calendar/*.ics` | Add-to-calendar files |

## Required Cloudflare Pages env vars

- `AC_API_URL` — e.g. `https://kaitness.api-us1.com`
- `AC_API_KEY` — ActiveCampaign API key (Settings → Developer in AC)
- `AC_LIST_ID` — `28` (list "Find Your Person Challenge May 2026" — created 2026-04-28)

## Pre-launch checklist (May 11)

- [ ] CF Pages project deployed and `hod-fyp.pages.dev` renders all 4 pages
- [ ] CF Worker `hod-fyp-proxy` routes `heartofdating.com/fyp*` to Pages
- [ ] `AC_API_URL`, `AC_API_KEY`, `AC_LIST_ID` set in CF Pages env
- [ ] Test form submission creates AC contact + applies tag `FYP_May_2026_Registered`
- [ ] ThriveCart embed dropped into `public/fyp/vip/index.html` at `<section id="checkout">`
- [ ] BOD Mighty Networks URL set on `public/fyp/thank-you-vip/index.html` (replaces `data-needs-url="bod-mighty-networks-space"`)
- [ ] Remove `<meta name="robots" content="noindex,nofollow">` from all 4 pages
- [ ] CF Access policy lifted (or password-gate removed)
- [ ] `$1` test purchase completes the full chain: form → `/fyp/vip` → ThriveCart → `/fyp/thank-you-vip` with `FYP_May_2026_VIP_Buyer` tag applied
- [ ] Lighthouse mobile scan: LCP < 2.5s, no horizontal scroll at 360/390/414
- [ ] OG/Twitter meta validated via `opengraph.xyz`

## What lives where

- **Mockup HTMLs** (legacy, JJ's source-of-truth originals): root of repo (`fyp-landing-tier3-bold.html`, etc.)
- **Deployable site:** `public/`
- **Pages Functions:** `public/functions/`
- **Calendar files:** `public/fyp/calendar/`
- **Audit + analyses:** `MOCKUP-AUDIT.md`, `VIP-SOD-ANALYSIS.md`, etc.

## Local dev

```bash
# Serve public/ on localhost
cd public && python3 -m http.server 8000
# Then visit http://localhost:8000/fyp/
```

(Pages Function won't work locally without `wrangler` — but the static HTML and form UX render. Run `npx wrangler pages dev public` if you need the function locally.)
