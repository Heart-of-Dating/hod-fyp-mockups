// Email lookup for admin dashboard.
// GET /api/dashboard-search?email=foo@bar.com
// Returns contact info + relevant launch tags (FYP, VIP, channel, SMS opt-in).

async function ac(env, path) {
  const url = `${env.AC_API_URL.replace(/\/$/, "")}/api/3${path}`;
  const r = await fetch(url, {
    headers: { "Api-Token": env.AC_API_KEY, "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`AC ${r.status} on ${path}`);
  return r.json();
}

// Tag names we care about surfacing in search results
const RELEVANT_TAG_PATTERNS = [
  /^FYP/i,
  /^SMS_Optin/i,
  /^School of Dating/i,
  /VIP/i,
];

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const emailRaw = (url.searchParams.get("email") || "").trim().toLowerCase();

    if (!emailRaw || emailRaw.length < 3) {
      return new Response(JSON.stringify({ error: "email required (min 3 chars)" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Scope to FYP May 2026 overall tag (TAG ID 200 = FYP-Overall) — don't
    // surface contacts from previous challenges, podcast list, or other lists.
    const FYP_OVERALL_TAG_ID = 200;
    // AC supports exact email lookup; for partial/substring use search filter
    const isPartial = !emailRaw.includes("@") || emailRaw.endsWith("@");
    const path = isPartial
      ? `/contacts?search=${encodeURIComponent(emailRaw)}&tagid=${FYP_OVERALL_TAG_ID}&limit=10`
      : `/contacts?email=${encodeURIComponent(emailRaw)}&tagid=${FYP_OVERALL_TAG_ID}&limit=10`;

    const data = await ac(env, path);
    const contacts = data.contacts || [];

    if (!contacts.length) {
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Resolve tag names for each contact (parallel)
    const results = await Promise.all(contacts.map(async (c) => {
      // Pull contactTags for this contact
      const tagsResp = await ac(env, `/contacts/${c.id}/contactTags`);
      const contactTagLinks = tagsResp.contactTags || [];
      // Resolve tag IDs -> names
      const tagIds = contactTagLinks.map(ct => ct.tag);
      const tagNames = [];
      // AC returns tag list as `_links` or includes; we resolve via /tags/{id}
      // Cap to 30 tags to avoid runaway
      const idsToResolve = tagIds.slice(0, 30);
      const tagFetches = await Promise.all(idsToResolve.map(async (id) => {
        try {
          const tr = await ac(env, `/tags/${id}`);
          return tr.tag?.tag || null;
        } catch (_) { return null; }
      }));
      for (const name of tagFetches) {
        if (name) tagNames.push(name);
      }

      // Filter to relevant launch tags
      const relevantTags = tagNames.filter(t => RELEVANT_TAG_PATTERNS.some(rx => rx.test(t)));

      // Derive channel + VIP status from tags
      const channel = relevantTags.find(t => /FYP-Paid/i.test(t)) ? "paid"
        : relevantTags.find(t => /FYP-Organic/i.test(t)) ? "organic"
        : null;
      const isVip = relevantTags.some(t => /VIP May 2026/i.test(t));
      const smsOptin = relevantTags.some(t => /SMS_Optin_Yes/i.test(t));

      return {
        id: c.id,
        email: c.email,
        fname: c.firstName || "",
        lname: c.lastName || "",
        phone: c.phone || "",
        created: c.cdate,
        updated: c.udate,
        channel,
        is_vip: isVip,
        sms_optin: smsOptin,
        tags: relevantTags,
      };
    }));

    return new Response(JSON.stringify({ results }, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, max-age=0",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
