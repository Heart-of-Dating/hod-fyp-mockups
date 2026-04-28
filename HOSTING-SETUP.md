# FYP May 2026 Hosting Setup — for JJ

**Owner:** JJ Tomlin
**Drafted by:** Pierre (Kait's Claude)
**Date:** 2026-04-28
**Status:** ready

## Decision

We're hosting the 4 FYP launch pages as **static HTML on Cloudflare Pages**, then reverse-proxying `heartofdating.com/fyp*` from Webflow to Pages via a Cloudflare Worker. Reasoning in `~/hod-brain/decisions/` (will write up after JJ confirms this approach).

This keeps the URL on the main domain, lets us iterate via git push (no Designer block needed), and preserves the mockup HTML pixel-for-pixel. The rest of `heartofdating.com` stays on Webflow.

## What's already done (this commit)

- 4 page shells deployable from `public/` directory:
  - `public/fyp/index.html` — landing
  - `public/fyp/vip/index.html` — tripwire
  - `public/fyp/thank-you-vip/index.html` — VIP TY
  - `public/fyp/thank-you-free/index.html` — Free TY
- Asset paths rewritten to absolute (`/assets/...`)
- Internal links rewritten (`vip-tripwire.html` → `/fyp/vip`, etc.)
- Per-page OG/Twitter/SEO meta tags
- `noindex,nofollow` on all pages until launch (remove on May 11)
- `_headers` with security + asset caching

## What's NOT done yet (next commits, blocks me)

| Blocker | Owner | Notes |
|---|---|---|
| Form wiring to ActiveCampaign | Pierre + Bandit | Need AC API key in env (or use AC hosted form action URL). I have AC connector — can test once endpoint confirmed. |
| ThriveCart embed on `/fyp/vip` | Pierre + Alana | Need final ThriveCart product embed code from Scout once she finalizes the VIP product. |
| AddEvent calendar URLs (4 nights) | Pierre + Alana | Create AddEvent events for each night, paste IDs into TY pages. |
| `/fyp/vip/thank-you` BOD button URL | Pierre + Kait/JJ | Mighty Networks BOD space URL — Kait creating. |
| `/fyp/thank-you-vip` VIP Q&A Zoom URL | Pierre + Alana | Generated week-of. |
| Pre-launch password gate | JJ | See "Step 4" below. |

## What you (JJ) need to do

### Step 1 — Cloudflare Pages project (5 min)

1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git
2. Repo: `Heart-of-Dating/hod-fyp-mockups`
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave blank)*
   - Build output directory: `public`
   - Root directory: `/`
4. Project name suggestion: `hod-fyp` → deployed at `hod-fyp.pages.dev`
5. Deploy. Verify `https://hod-fyp.pages.dev/fyp/` renders the landing page correctly.

### Step 2 — Cloudflare Worker for path-preserving proxy (10 min)

This makes `heartofdating.com/fyp*` actually serve from the Pages deployment while keeping the URL bar clean. Without this, users would see `hod-fyp.pages.dev` in the URL.

1. Cloudflare dashboard → Workers & Pages → Create → Worker
2. Name: `hod-fyp-proxy`
3. Paste:

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Match /fyp and /fyp/* — anything else passes through to Webflow
    if (pathname === '/fyp' || pathname.startsWith('/fyp/')) {
      const pagesUrl = new URL(pathname + url.search, 'https://hod-fyp.pages.dev');
      const proxied = await fetch(pagesUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      // Copy response, strip CF Pages headers that conflict
      const newResp = new Response(proxied.body, proxied);
      newResp.headers.delete('cf-ray');
      return newResp;
    }

    // Pass through to Webflow origin
    return fetch(request);
  }
};
```

4. Deploy.
5. Add a route: `heartofdating.com/fyp*` → bind to this Worker. (Workers & Pages → your Worker → Triggers → Routes → Add route.)

Test: `curl -sI https://heartofdating.com/fyp/` should return 200 and the HTML should match what's on `hod-fyp.pages.dev/fyp/`.

### Step 3 — Confirm `/challenge` redirect (existing Fall 2025 page)

The Webflow page at `heartofdating.com/challenge` is the Fall 2025 FYP landing. Per the spec it should redirect to `/fyp` once May 2026 goes live.

Two options:
- **Option A (Webflow):** In Webflow Project Settings → Hosting → Redirects, add `/challenge` → `/fyp` (301). Do this on May 11 at launch.
- **Option B (Worker):** Add a path match in the Worker above for `/challenge` → 301 redirect. I can write the snippet if you prefer this.

### Step 4 — Pre-launch access gate

Until May 11 we don't want random people stumbling on these pages. The HTML has `noindex,nofollow` meta but that only blocks search engines, not direct visitors.

Options (pick one):
- **Cloudflare Access** policy on `heartofdating.com/fyp*` requiring HOD team email login. Free tier supports this for small teams. ~5 min to set up.
- **HTTP Basic Auth** via the Worker (add a check before the proxy). I can write this snippet — just say which password.
- **Soft gate:** keep noindex, share the URL only with team. Simplest, slight risk.

My vote: Cloudflare Access. It's free, works for HOD team, no password to remember.

### Step 5 — Launch day (May 11)

- Remove `noindex,nofollow` meta from all 4 HTMLs (one git push — I'll do this)
- Disable Step 4 access gate
- Add `/challenge → /fyp` redirect (Step 3)
- Smoke test: hit each URL, submit a real form, run a $1 ThriveCart test

## Things to gut-check

- **Subdomain alternative:** if the Worker setup is more friction than you want, we can flip to `fyp.heartofdating.com` instead — DNS only, no Worker needed. The trade is the URL changes, ads/emails use the subdomain. Path-preserving proxy is cleaner for SEO + brand but the subdomain is 5 minutes vs 30. Your call.
- **AC form action URL:** I'll wire the form once you confirm whether to hit AC's hosted form action (`https://kaitness.activehosted.com/proc.php` style) or a Cloudflare Pages Function with the AC API key in env. Pages Functions = cleaner, no exposed key. Want me to use Pages Functions? You'd need to drop the AC API key in CF Pages env vars.

## What happens after JJ confirms hosting + provides creds

1. I deploy the form-wiring + ThriveCart embed (next commit, ~30 min)
2. Bandit and I test the full chain (form submit → AC tag → redirect to `/fyp/vip` → TC test purchase → success redirect to `/fyp/thank-you-vip`)
3. I announce in `_TOUCH-LOG.md` that the build is done + tested
4. JJ flips the access gate off May 11

— Pierre
