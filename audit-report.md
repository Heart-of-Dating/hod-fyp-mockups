# Mockup QA Audit — 2026-04-22

Audited 4 files for mobile rendering at 360–390px (primary conversion viewport). Files are otherwise solid; issues below are real, not padding.

---

## CRITICAL (fix before showing Kait)

- **fyp-landing-tier3-bold.html:594 and :784** — Submit `<button>` sits **outside** the surrounding `<form>` element (form closes on the previous line at `</form>`, button is a sibling). Clicking it will NOT submit the form. Both CTAs on the page have this bug. Fix: move `</form>` after the button, OR add `form="<id>"` attribute to button.

- **fyp-landing-tier3-bold.html:222 (`.scale-number`)** — `font-size: clamp(72px, 12vw, 140px)` with min 72px. The text "20,000+" at 72px Fraunces serif is ≈340px wide. On a 360px viewport (minus 48px container padding = 312px content), this will **overflow horizontally**. Drop min to 56–60px, or reduce letter-spacing, or allow it to wrap.

- **vip-tripwire.html:451–453 (`.proof-avatar-1/2/3`)** — Unsplash stock-photo headshots paired with fully attributed testimonials ("Michelle, 32, Dallas, Now in SOD" / "Joyce, 47, Atlanta" / "Kayla, 29, Nashville, Engaged"). This is a **brand/integrity risk** — the quotes may be real but the faces aren't. If Kait spots this before we do, it's a trust hit. Either use real attendee photos, remove the avatars and keep text-only, or remove the specific metadata (age/city).

- **Logo transparency (all 3 dark-header files: Tier 1, Tier 2, vip-tripwire header is cream so OK)** — I verified `assets/hod-logo.png` IS fully transparent (corners alpha=0, 37% of canvas transparent, opaque pixels are 100% brand terracotta `rgb(221,103,79)`). Logo will render correctly with transparent BG on dark headers. **BUT** the terracotta-on-near-black contrast is borderline (Tier 1 bg `#0F0E0D`, Tier 2 bg `#141211`). Recommend either: (a) use a white/cream variant of the logo for dark sections, or (b) accept the brand-tone-on-dark look. **JJ's "white box" flag appears to be incorrect for this source file** — no white box will render. Worth confirming JJ wasn't looking at a different logo asset or a cached OG image.

---

## HIGH PRIORITY (fix today)

- **fyp-landing-tier1-refresh.html:620** — Countdown timer `"<span>00</span> : <span>00</span> : <span>00</span> : <span>00</span>"` at `clamp(36px, 5vw, 56px)` (min 36px). On 360px viewport (content ~312px), 12 chars of Poppins 800 at 36px with 0.04em letter-spacing ≈ 320–340px — **likely overflows**. Either reduce min to 28px on a mobile breakpoint, or stack units vertically, or shrink letter-spacing on mobile.

- **fyp-landing-tier1-refresh.html:503–518 (`.email-capture form`)** — `display: flex` input + button side-by-side with max-width 480px. At 360px no mobile stacking rule — input crushes to ~180px and "Sign Up" button pushes tight. Add `@media (max-width: 480px) { .email-capture form { flex-direction: column; } }`.

- **fyp-landing-tier2-upgrade.html:664–679 (`.email-capture form`)** — Same issue as Tier 1: flex row with no mobile breakpoint. Stack on narrow.

- **fyp-landing-tier1-refresh.html:566** — Header uses `display: flex; justify-content: space-between` between logo and menu label "FIND YOUR PERSON · SPRING 2026". At 360px, long menu text may wrap or squeeze logo. Consider hiding `.menu` under 600px.

- **fyp-landing-tier2-upgrade.html:729** — Same header layout risk with "Free Event · May 26–29" on right. Text is shorter so likely OK, but verify at 360px.

- **fyp-landing-tier3-bold.html:137 (`.register-form`)** — `grid-template-columns: 1fr 1fr` for first/last name inputs. At 360px inside the 520px-max register card with 28px padding × 2 = 56px, each input column ≈ 148px. **Placeholder text "First name" / "Last name" will fit**, but `padding: 14px 16px` eats 32px from each column → usable text area ~116px. Tight but functional. Consider `1fr` (single column stacked) under 420px for comfort.

- **vip-tripwire.html:178–179 (`.offer-list li`)** — `grid-template-columns: 28px 1fr auto`. Right column is value-tag ($97/$147/$197). At 360px viewport inside hero container (24px padding) inside offer-card (no extra horizontal outside, but offer-body padding 36px × 2 = 72px) → content column ~216px. After 28px icon + 14px gap + auto value-tag (~38px) + 14px gap = middle text gets ~122px. Readable but cramped. Consider collapsing value-tag under the text on mobile.

- **vip-tripwire.html:155 & 212–218** — `.offer-body { padding: 36px 36px 32px }` is heavy on mobile. Combined with hero `padding: 60px 24px 80px`, the offer card's content is very narrow at 360px. Consider reducing offer-body padding to `24px 20px` under 480px. The `.showstopper` negative margins (`margin: 12px -36px`) depend on this padding matching — update both together.

---

## POLISH (nice-to-have)

- **All 4 files — External Unsplash dependencies.** Hero, guarantee, ark, and final CTA backgrounds all pull from `images.unsplash.com` URLs. If Unsplash rate-limits, changes URLs, or is slow, sections render with plain gradients only. **Low-risk but real.** Recommend downloading to `assets/` before launch:
  - `vip-tripwire.html:81, 451-453, 476, 576`
  - `fyp-landing-tier1-refresh.html:96`
  - `fyp-landing-tier2-upgrade.html:151, 471, 579`
  - `fyp-landing-tier3-bold.html:59, 403, 524`

- **fyp-landing-tier2-upgrade.html:118** — `h1.hero-title` `clamp(48px, 7vw, 88px)` with `letter-spacing: -0.035em`. Word "Challenge." at 48px Fraunces ≈ 260px — fits 312px but close. At 390px fine. OK.

- **fyp-landing-tier3-bold.html:95** — `h1.hero-title` `clamp(48px, 8vw, 96px)`, line-height 1. "Find Your *Person.*" breaks naturally. OK on mobile.

- **fyp-landing-tier2-upgrade.html:586** — `font-size: clamp(42px, 6vw, 80px)` final h2 "Are you *ready?*" — min 42px fits. OK.

- **vip-tripwire.html:676 (`.offer-ribbon`)** — "$468 Value · Never-Before Bundle · Today $17" at 13px with 0.08em letter-spacing in a 14px padding box. Will wrap to 2 lines on mobile — readable but designers may want a mobile-specific shorter copy.

- **fyp-landing-tier3-bold.html:689** — `.why-grid` inline style `padding: 0;` override on `.container-narrow` — works but prefer extracting to a class for maintainability.

- **fyp-landing-tier1-refresh.html:147–150, tier2:233–236, tier3:325–334** — `.speaker-photo` uses CSS `background-image` instead of `<img>`. This means: (1) no `alt` text for accessibility, (2) no lazy-loading, (3) images always download even if offscreen. Consider `<img loading="lazy" alt="Dr. Henry Cloud headshot">`.

- **Tier 2 hero-img line 146–154** — `aspect-ratio: 16/9` with external Unsplash BG. If image fails, a large empty box shows. Add a fallback color stop.

- **Touch targets** — All primary `.btn` elements across files are `padding: 18–20px × 36–48px` → ~50–60px tall. Clear ✓. FAQ summaries on vip-tripwire and tier3 are ~40px tall — **borderline 44px minimum**. Consider `padding: 22px 0` on `.faq-item`.

- **vip-tripwire.html:866** — `.bump label` has no explicit min-height/padding. Tap target on the checkbox+label row is ~38px tall — under 44px. Add `padding: 4px 0` on label or increase checkbox to 24×24.

- **fyp-landing-tier1-refresh.html:57** — Header `.menu` is decorative copy — should probably be `aria-hidden="true"` if it's not a link.

---

## CLEAN (passed checks)

- **All 4 files** — local asset references (`assets/hod-logo.png`, `assets/kait-solo.png`, `assets/kait-jj-couple.png`, `assets/dr-cloud.jpg`, `assets/annie-downs.jpg`) all exist on disk ✓.

- **All 4 files** — CSS syntactically valid, no malformed rules, selectors properly closed, braces balanced.

- **All 4 files** — Speaker grids (`grid-template-columns: repeat(2, 1fr)`) have proper `@media (max-width:720px) { ... 1fr }` collapse rules. ✓

- **All 4 files** — Testimonial 3-col grids collapse to 1fr at 820px. ✓

- **All 4 files** — Viewport meta tag present and correct. ✓

- **All 4 files** — Hero `h1.hero-title` uses `clamp()` with sane minimums (34–48px) that fit 312px-content at 360px viewport (largest single words like "Challenge" and "Person" fit). ✓

- **fyp-landing-tier2-upgrade.html** — Typography hierarchy clean, Fraunces-Inter pairing consistent.

- **fyp-landing-tier3-bold.html** — Light-theme design avoids the logo-on-dark contrast concern entirely.

- **vip-tripwire.html** — Confirmation banner, offer card, note-card, and guarantee sections have proper 780px breakpoint for single-column stacking.

- **fyp-landing-tier1-refresh.html** — Footer `.foot-grid` (2fr 2fr 1fr) collapses to 1fr at 720px. ✓

- **Logo source file** — `assets/hod-logo.png` is 1218×528 RGBA with proper alpha channel; 37% transparent, opaque pixels are 100% brand terracotta. Renders clean on any BG. JJ's "white box" concern does not match the source file — please confirm what he was looking at.
