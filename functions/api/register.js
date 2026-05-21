// Cloudflare Pages Function — FYP May 2026 registration handler.
// Accepts POST from /fyp/ form, proxies to ActiveCampaign API v3 with key from env.
// Required env vars (set in Cloudflare Pages → Settings → Environment variables):
//   AC_API_URL  e.g. https://kaitness.api-us1.com
//   AC_API_KEY  the API key (Settings → Developer in AC)
//   AC_LIST_ID  the AC list ID for FYP May 2026 registrants (TBD — Kait + JJ creating)
//   TELNYX_LIVE                  "true" to enable welcome SMS send (default off until campaign approval)
//   TELNYX_API_KEY               Telnyx API bearer token
//   TELNYX_FROM_NUMBER           E.164 sending number (+16154889970)
//   TELNYX_MESSAGING_PROFILE_ID  Telnyx messaging profile UUID

const TIER1_STATES = new Set(["TX", "CA", "FL"]);

// Welcome SMS — Bandit-drafted, 152 chars, 1 segment, Smart-Encoding-safe.
// Do not edit without confirming character count + segment count stays at 1.
const WELCOME_SMS_BODY = "Heart of Dating: You're in for the Find Your Person Challenge! Save this number — we'll text you 1hr before each night. Reply STOP to opt out, HELP for help.";

// Normalize a user-entered phone string to E.164 for US/CA numbers.
// Accepts: "(615) 555-1234", "615-555-1234", "6155551234", "+16155551234", "1-615-555-1234"
// Returns: "+16155551234" or null if it can't be confidently normalized.
function toE164US(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (String(raw).trim().startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}

// Fire-and-forget welcome SMS. Wrapped so caller can ctx.waitUntil() without blocking response.
// Skips silently when: flag off, no opt-in, no phone, missing config, or non-normalizable number.
async function sendWelcomeSMS(env, { phone, smsOptIn, contactId }) {
  if (env.TELNYX_LIVE !== "true") return; // gate — flip via `wrangler pages secret put TELNYX_LIVE`
  if (!smsOptIn) return;
  if (!env.TELNYX_API_KEY || !env.TELNYX_FROM_NUMBER || !env.TELNYX_MESSAGING_PROFILE_ID) {
    console.log(`telnyx welcome skipped (config missing) contact=${contactId}`);
    return;
  }
  const to = toE164US(phone);
  if (!to) {
    console.log(`telnyx welcome skipped (phone not E.164) contact=${contactId}`);
    return;
  }
  try {
    const r = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.TELNYX_FROM_NUMBER,
        to,
        text: WELCOME_SMS_BODY,
        messaging_profile_id: env.TELNYX_MESSAGING_PROFILE_ID,
      }),
    });
    if (!r.ok) {
      const errTxt = await r.text();
      console.log(`telnyx welcome send failed contact=${contactId} status=${r.status} body=${errTxt.slice(0, 300)}`);
    } else {
      console.log(`telnyx welcome sent contact=${contactId} to=${to}`);
    }
  } catch (e) {
    console.log(`telnyx welcome error contact=${contactId}: ${e.message}`);
  }
}

// Channel-aware tag set:
//   FYP-Overall  → every registration (single source-of-truth list for all FYP regs)
//   FYP-Paid     → ?src=paid (James / Meta ads)
//   FYP-Organic  → ?src=organic OR no src (Social Crewe / podcast / direct)
// VIP tags (VIP-Overall / VIP-Paid / VIP-Organic) fire from ThriveCart → AC integration on purchase,
// not from this Pages Function. Per-channel ThriveCart products handle that split.
const TAGS_ALWAYS = ["FYP-Overall"];
const CHANNEL_TAG = { paid: "FYP-Paid", organic: "FYP-Organic" };

const CUSTOM_FIELD_IDS = {
  birth_year: 17, // %BIRTH_YEAR%
  state: 18,      // %STATE%
  sms_optin: 19,  // %SMS_OPTIN% — "yes"/"no"
};

function bad(msg, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function ac(env, path, init = {}) {
  const url = `${env.AC_API_URL.replace(/\/$/, "")}/api/3${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      "Api-Token": env.AC_API_KEY,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: r.ok, status: r.status, body };
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.AC_API_URL || !env.AC_API_KEY) {
    return bad("Server not configured: AC_API_URL or AC_API_KEY missing", 500);
  }

  let payload;
  try {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      payload = await request.json();
    } else {
      const form = await request.formData();
      payload = Object.fromEntries(form.entries());
    }
  } catch {
    return bad("Could not parse request body");
  }

  const fname = (payload.fname || "").trim();
  const lname = (payload.lname || "").trim();
  const email = (payload.email || "").trim().toLowerCase();
  const phone = (payload.phone || "").trim();
  const byear = (payload.byear || "").trim();
  const state = (payload.state || "").trim().toUpperCase();
  const sms = payload.sms === "on" || payload.sms === true || payload.sms === "true" || payload.sms === "1";

  // Channel attribution: paid (James/Meta) | organic (Social Crewe/podcast/direct).
  // Accept EITHER ?src= (canonical) OR ?utm_medium= (UTM-convention fallback for James's brief).
  // No src + no utm_medium → organic (conservative default; safer to overcount organic).
  const srcRaw = (payload.src || payload.utm_medium || "").trim().toLowerCase();
  const src = srcRaw === "paid" ? "paid" : "organic";

  // LP A/B variant — pinned by the page that submitted (not by URL param).
  // Defaults to v1 (control). Tags LP-v1 or LP-v2 for downstream conv-rate analysis.
  const lpRaw = (payload.lp_variant || "v1").toString().trim().toLowerCase();
  const lpVariant = lpRaw === "v2" ? "v2" : "v1";

  if (!fname || !lname || !email || !phone || !byear || !state) {
    return bad("Missing required field");
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) return bad("Invalid email");
  if (!/^\d{4}$/.test(byear)) return bad("Birth year must be 4 digits");

  // 1) Create or update contact
  const contactResp = await ac(env, "/contact/sync", {
    method: "POST",
    body: JSON.stringify({
      contact: {
        email,
        firstName: fname,
        lastName: lname,
        phone,
        fieldValues: [
          { field: CUSTOM_FIELD_IDS.birth_year, value: byear },
          { field: CUSTOM_FIELD_IDS.state, value: state },
          { field: CUSTOM_FIELD_IDS.sms_optin, value: sms ? "yes" : "no" },
        ],
      },
    }),
  });

  if (!contactResp.ok) {
    return bad(`AC contact sync failed: ${contactResp.status}`, 502);
  }

  const contactId = contactResp.body?.contact?.id;
  if (!contactId) return bad("AC sync returned no contact id", 502);

  // 2) Subscribe to launch list (if AC_LIST_ID set)
  if (env.AC_LIST_ID) {
    await ac(env, "/contactLists", {
      method: "POST",
      body: JSON.stringify({
        contactList: { list: env.AC_LIST_ID, contact: contactId, status: 1 },
      }),
    });
  }

  // 3) Tag set
  const tagsToApply = [...TAGS_ALWAYS];
  tagsToApply.push(CHANNEL_TAG[src]);
  tagsToApply.push(TIER1_STATES.has(state) ? "Region_Tier1" : "Region_Tier2");
  if (sms) tagsToApply.push("SMS_Optin_Yes");
  tagsToApply.push(`LP-${lpVariant}`);  // LP-v1 (control) or LP-v2 (variant)

  // VIP A/B variant — deterministic 50/50 split via email hash so the same person
  // always lands on the same VIP page even if they re-register or come back later.
  // v1 = /fyp/vip (control, original creative). v2 = /fyp/vip-paid (Banjo's rebuilt
  // paid-traffic variant with testimonial wall + re-stacked offer).
  let emailHash = 0;
  for (let i = 0; i < email.length; i++) {
    emailHash = ((emailHash << 5) - emailHash + email.charCodeAt(i)) | 0;
  }
  const vipVariant = (Math.abs(emailHash) % 2) === 0 ? "v1" : "v2";
  const vipPath = vipVariant === "v2" ? "/fyp/vip-paid" : "/fyp/vip";
  tagsToApply.push(`VIP-${vipVariant}`);

  // AC tags require tag IDs, but we can also create via /contactTags with tag NAME using the
  // /tags?search= endpoint to resolve. For simplicity, use a single batch call with names.
  // (AC API needs tag IDs — resolve each name to id, create if missing.)
  await Promise.all(tagsToApply.map(async (tagName) => {
    let tagId;
    const search = await ac(env, `/tags?search=${encodeURIComponent(tagName)}`);
    const existing = (search.body?.tags || []).find(t => t.tag === tagName);
    if (existing) {
      tagId = existing.id;
    } else {
      const created = await ac(env, "/tags", {
        method: "POST",
        body: JSON.stringify({ tag: { tag: tagName, tagType: "contact", description: "FYP May 2026 auto-tag" } }),
      });
      tagId = created.body?.tag?.id;
    }
    if (tagId) {
      await ac(env, "/contactTags", {
        method: "POST",
        body: JSON.stringify({ contactTag: { contact: contactId, tag: tagId } }),
      });
    }
  }));

  // 4) Meta Conversions API — server-side CompleteRegistration event with same event_id as browser pixel.
  //    Captures iOS conversions the browser pixel misses (~60% of audience).
  //    Pass IP, UA, fbc/fbp cookies, hashed email + phone for highest match quality.
  if (env.META_CAPI_TOKEN && env.META_PIXEL_ID) {
    try {
      const eventId = (payload.event_id || `completeregistration_${email}_${Date.now()}`).slice(0, 256);
      const eventTime = Math.floor(Date.now() / 1000);
      const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
      const userAgent = request.headers.get("user-agent") || "";
      const sourceUrl = request.headers.get("referer") || "https://fyp.heartofdating.com/fyp/";

      const sha256Hex = async (s) => {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.toLowerCase().trim()));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
      };
      const normPhone = phone.replace(/\D/g, "");

      const userData = {
        em: [await sha256Hex(email)],
        ph: normPhone ? [await sha256Hex(normPhone)] : undefined,
        client_ip_address: clientIp,
        client_user_agent: userAgent,
        fbc: payload.fbc || undefined,
        fbp: payload.fbp || undefined,
      };
      // Strip undefined fields
      Object.keys(userData).forEach(k => userData[k] === undefined && delete userData[k]);

      const capiBody = {
        data: [{
          event_name: "CompleteRegistration",
          event_time: eventTime,
          event_id: eventId,
          action_source: "website",
          event_source_url: sourceUrl,
          user_data: userData,
          custom_data: {
            content_name: "FYP May 2026 Registration",
            content_category: src, // "paid" | "organic"
          },
        }],
      };

      const capiResp = await fetch(
        `https://graph.facebook.com/v19.0/${env.META_PIXEL_ID}/events?access_token=${env.META_CAPI_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(capiBody),
        }
      );
      // Don't fail the whole request if CAPI fails — log and move on
      if (!capiResp.ok) {
        console.log(`CAPI CompleteRegistration failed for contact ${contactId}: ${capiResp.status}`);
      }
    } catch (e) {
      console.log(`CAPI CompleteRegistration error for contact ${contactId}: ${e.message}`);
    }
  }

  // 5) Welcome SMS — fire-and-forget via waitUntil so response doesn't block on Telnyx latency.
  //    No-ops until env.TELNYX_LIVE === "true" (set via `wrangler pages secret put TELNYX_LIVE`).
  const smsTask = sendWelcomeSMS(env, { phone, smsOptIn: sms, contactId });
  if (typeof waitUntil === "function") {
    waitUntil(smsTask);
  } else {
    // Local dev / older runtimes: still let the promise run, just don't block the response.
    smsTask.catch(() => {});
  }

  // Pass src + variant through so the VIP page can pick the channel-correct ThriveCart product.
  return new Response(JSON.stringify({ ok: true, contact: contactId, redirect: `${vipPath}?src=${src}` }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
