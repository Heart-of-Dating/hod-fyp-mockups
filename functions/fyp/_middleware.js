// LP A/B rotation middleware — serves /fyp/v1 or /fyp/v2 50/50 under the SAME
// /fyp/ URL. James keeps using one ad-set URL; the variant is decided
// server-side by sticky cookie so a returning visitor sees the same variant.
//
// Mechanics:
//   1. Request hits /fyp/ (only — subpaths like /fyp/vip pass through unchanged)
//   2. Check `lp_assigned` cookie; if present, honor it (sticky stays for 30d)
//   3. If not present, coin-flip v1 vs v2, set the cookie
//   4. v1: serve the original page (context.next())
//      v2: internally fetch /fyp/v2/ HTML and return it at the /fyp/ URL
//
// The form on each page already hardcodes data.lp_variant = 'v1' or 'v2' so the
// AC tag (LP-v1 / LP-v2) is set correctly regardless of routing.

const COOKIE_NAME = "lp_assigned";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function readCookie(req, name) {
  const header = req.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);

  // Only act on the bare /fyp/ root — let subpaths (vip, vip-paid, v2, thank-you-*, etc) pass through
  const isRoot = url.pathname === "/fyp" || url.pathname === "/fyp/" || url.pathname === "/fyp/index.html";
  if (!isRoot) return next();

  // Sticky assignment
  let variant = readCookie(request, COOKIE_NAME);
  if (variant !== "v1" && variant !== "v2") {
    variant = Math.random() < 0.5 ? "v1" : "v2";
  }

  let response;
  if (variant === "v2") {
    // Internal fetch of the v2 page; rewrite URL to /fyp/v2/ and pull HTML
    const v2Url = new URL(request.url);
    v2Url.pathname = "/fyp/v2/";
    const upstream = await fetch(v2Url.toString(), {
      headers: request.headers,
    });
    const body = await upstream.arrayBuffer();
    response = new Response(body, {
      status: upstream.status,
      headers: new Headers(upstream.headers),
    });
    // Force HTML content-type in case upstream had something weird
    response.headers.set("Content-Type", "text/html; charset=utf-8");
  } else {
    response = await next();
    // Clone so we can attach the cookie
    response = new Response(response.body, response);
  }

  // Set sticky cookie (only set if missing — don't refresh on every visit)
  if (!readCookie(request, COOKIE_NAME)) {
    response.headers.append(
      "Set-Cookie",
      `${COOKIE_NAME}=${variant}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; Secure`
    );
  }

  // Helpful diagnostic header (visible in dev tools, won't affect users)
  response.headers.set("X-LP-Variant", variant);

  return response;
}
