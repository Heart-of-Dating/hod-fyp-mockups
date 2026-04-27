# Mockup → Live Tagging Audit

**Date:** 2026-04-27
**Convention:** per JJ's global CLAUDE.md
- `data-mock="wire"` — element with correct shape but fake value (becomes live data)
- `data-mock="delete"` — scaffolding/sample structure that gets replaced
- `data-mock="keep"` — intentionally static content
- `data-mock-src="/api/path:json.key"` — optional endpoint annotation

**Goal:** every fake placeholder is taggable so Webflow rebuild knows what's mock vs live.

---

## fyp-landing-tier3-bold.html — Most mockup work here

### WIRE (becomes live data)
| Element | Current value | Live source |
|---------|--------------|-------------|
| `<input name="fname">` | placeholder | ActiveCampaign field `firstname` |
| `<input name="lname">` | placeholder | AC field `lastname` |
| `<input name="email">` | placeholder | AC field `email` |
| `<input name="phone">` | placeholder | AC field `phone` + Community SMS opt-in |
| `<input name="sms">` checkbox | default checked | AC field `sms_optin` |
| Speaker night dates (`Tue · May 26 · Night 1` etc) | hardcoded text | Webflow CMS collection `speakers` |
| Speaker bios | hardcoded text | CMS `speakers.bio` |
| Speaker topic descriptions | hardcoded text | CMS `speakers.topic` |
| `20,000+` scale number | hardcoded | CMS site setting `expected_attendees` |
| Hero kicker dates (`4 NIGHTS · MAY 26-29 · 7 PM CT`) | hardcoded | CMS site setting `event_dates` |
| Form submit button text | hardcoded | CMS or Webflow form setting |

### DELETE (scaffolding to replace with Webflow component)
| Element | Why |
|---------|-----|
| `<form class="register-form">` (×2) | Replace with Webflow Form Block + AC integration |
| Speaker grid (4 cards) | Replace with Webflow Collection List bound to `speakers` CMS |
| Why Grid (6 cards) | Replace with Webflow Collection List bound to `audience_callouts` CMS |
| FAQ items (5 details/summary) | Replace with Webflow accordion component bound to `faqs` CMS |

### KEEP (intentional static)
| Element | Why |
|---------|-----|
| `<img>` HOD logo | Static brand asset |
| Background lifestyle imagery URLs | Static, served from Webflow Assets |
| Section headers ("Meet Your Hosts", "Quick questions") | Brand copy, not data |
| Color palette / typography | Style system |
| Footer | Static |

---

## vip-tripwire.html

### WIRE
| Element | Current | Live source |
|---------|---------|-------------|
| `$17` price (×4 instances) | hardcoded | ThriveCart product price (auto-pull) |
| `$468` value stack total | hardcoded | Computed from offer items |
| Individual offer values ($97, $147, $27, $197) | hardcoded | CMS `vip_offer_items.value` |
| BOD bonus copy | hardcoded | CMS `vip_bonus.description` |
| Testimonial quotes (Michelle, David, Joyce) | hardcoded | CMS `testimonials` (filterable by `vip=true`) |
| Testimonial names + meta | hardcoded | CMS `testimonials.name/age/location` |
| FAQ answers | hardcoded | CMS `faqs` (filtered by `page=vip`) |
| Order bump checkbox + price | hardcoded | ThriveCart bump config |

### DELETE
| Element | Why |
|---------|-----|
| `<a href="#">Yes, Upgrade Me to VIP — $17</a>` (×3) | Replace with ThriveCart embedded checkout |
| `<a href="free-thank-you.html">No thanks...</a>` (×3) | Replace with Webflow link to `/thank-you-free` |
| Testimonial cards (3) | Replace with Webflow Collection List bound to `testimonials` |
| Offer list items (LI tags) | Replace with Webflow Collection List bound to `vip_offer_items` |
| FAQ details/summary blocks (5) | Replace with Webflow accordion bound to `faqs` |

### KEEP
- HOD logo, background imagery, color palette, Kait note photo, Kait's note copy (intentionally personal/static)
- Confirmation banner
- Section headers
- Footer

---

## vip-thank-you.html

### WIRE
| Element | Current | Live source |
|---------|---------|-------------|
| Calendar buttons × 4 (Night 1-4) | static `href="#"` | Generated `.ics` URLs per night, OR Add to Calendar SDK |
| BOD course access link | static `href="#"` | ThriveCart fulfillment URL or LMS link |
| VIP Q&A Zoom link mention | static text | CMS `event.vip_qa_url` (sent via email week-of) |
| Order receipt details ("$17.00") | static | ThriveCart confirmation data |
| Speaker name in calendar buttons | hardcoded | CMS `speakers` |

### DELETE
| Element | Why |
|---------|-----|
| `<a href="#">Open BOD Course</a>` | Replace with real fulfillment link |
| Calendar buttons × 4 | Replace with proper calendar generator (AddEvent/AddToCalendar widget) |

### KEEP
- HOD logo, success seal, Kait note + photo, Kait sign-off, footer
- Step structure (visual layout)
- Color palette

---

## free-thank-you.html

### WIRE
| Element | Current | Live source |
|---------|---------|-------------|
| Calendar buttons × 4 | static `href="#"` | Generated `.ics` URLs per night |
| Community join link | static `href="#"` | Mighty Networks invite URL |
| SMS short code (214-225-7772) | hardcoded | Community SMS keyword config |
| VIP re-pitch CTA | static `href="vip-tripwire.html"` | Real VIP page URL when live |

### DELETE
- Same as VIP Thank You — calendar buttons, community link, VIP CTA need real wiring

### KEEP
- HOD logo, success seal, Kait note + photo + sign-off, footer
- Layout structure
- VIP re-pitch section content (intentional copy)

---

## Webflow CMS Collections to Build (derived from above)

1. **`speakers`** — name, photo, night, date, topic, bio
2. **`testimonials`** — name, age, location, quote, photo, page_filter (vip/sod/general)
3. **`faqs`** — page, question, answer, sort_order
4. **`vip_offer_items`** — title, description, dollar_value, sort_order, is_bonus
5. **`audience_callouts`** — headline, body (the "If [pain] is you" cards on FYP landing)
6. **`event`** — singleton site setting: dates, expected_attendees, vip_qa_url, zoom_link, etc.

---

## Sequencing for Webflow Rebuild

1. **Build CMS collections** (1-2 hrs in Webflow Designer)
2. **Build single page template** (FYP landing) with Collection Lists bound (3-4 hrs)
3. **Replicate to VIP + thank-you pages** (1-2 hrs each)
4. **Wire forms** to ActiveCampaign (Webflow has native AC connector — use it)
5. **Embed ThriveCart checkout** on VIP page (15 min — copy embed code)
6. **QA on mobile** at 360-390-414 viewports
7. **Publish** + verify redirects from old URLs

**Total estimate:** 8-12 hrs of Webflow Designer work, OR 4-6 hrs if handed to a Webflow specialist with this audit as the spec.
