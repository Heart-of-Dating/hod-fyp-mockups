// One-shot bulk dump: email + birth_year + tags for all FYP-Overall contacts.
// Returns CSV. Auth-gated by admin middleware.
// Created 2026-06-16 by Pierre to unblock May 2026 age × ROAS analysis.

const FYP_OVERALL_TAG_ID = 192;
const BIRTH_YEAR_FIELD_ID = "17";
const STATE_FIELD_ID = "18";

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
  if (!r.ok) throw new Error(`AC ${path} → ${r.status}`);
  return r.json();
}

export async function onRequestGet({ request, env }) {
  if (!env.AC_API_URL || !env.AC_API_KEY) {
    return new Response("AC creds not configured", { status: 500 });
  }

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get("limit") || "20000", 10);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  // Paginate through FYP-Overall tagged contacts, include fieldValues inline
  const rows = [];
  let cursor = offset;
  const pageSize = 100;
  let hasMore = true;
  let total = null;

  while (hasMore && rows.length < limit) {
    const data = await ac(env, `/contacts?tagid=${FYP_OVERALL_TAG_ID}&include=fieldValues&limit=${pageSize}&offset=${cursor}`);
    const contacts = data.contacts || [];
    const fvs = data.fieldValues || [];
    if (total === null) total = data.meta?.total || null;

    // Index fieldValues by contact id
    const fvByContact = {};
    for (const fv of fvs) {
      if (!fvByContact[fv.contact]) fvByContact[fv.contact] = {};
      fvByContact[fv.contact][fv.field] = fv.value;
    }

    for (const c of contacts) {
      const fields = fvByContact[c.id] || {};
      rows.push({
        id: c.id,
        email: c.email || "",
        byear: fields[BIRTH_YEAR_FIELD_ID] || "",
        state: fields[STATE_FIELD_ID] || "",
      });
    }

    cursor += pageSize;
    if (contacts.length < pageSize) hasMore = false;
  }

  // Build CSV
  const csv = ["id,email,birth_year,state"];
  for (const r of rows) {
    csv.push(`${r.id},${r.email},${r.byear},${r.state}`);
  }

  return new Response(csv.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Cache-Control": "no-store",
      "Content-Disposition": "attachment; filename=fyp-birth-years.csv",
      "X-Total-Returned": String(rows.length),
      "X-Total-AC": String(total || ""),
    },
  });
}
