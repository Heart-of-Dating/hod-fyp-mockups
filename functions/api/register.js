// Cloudflare Pages Function — FYP May 2026 registration handler.
// Accepts POST from /fyp/ form, proxies to ActiveCampaign API v3 with key from env.
// Required env vars (set in Cloudflare Pages → Settings → Environment variables):
//   AC_API_URL  e.g. https://kaitness.api-us1.com
//   AC_API_KEY  the API key (Settings → Developer in AC)
//   AC_LIST_ID  the AC list ID for FYP May 2026 registrants (TBD — Kait + JJ creating)

const TIER1_STATES = new Set(["TX", "CA", "FL"]);

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

export async function onRequestPost({ request, env }) {
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

  // Pass src through to /fyp/vip so VIP page can pick the channel-correct ThriveCart product.
  return new Response(JSON.stringify({ ok: true, contact: contactId, redirect: `/fyp/vip?src=${src}` }), {
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
