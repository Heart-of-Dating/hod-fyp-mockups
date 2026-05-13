// Sets auth cookie if password matches. Called from /admin/login.html
const PASSWORD = "jjcool";
const COOKIE_NAME = "hod_admin";
const COOKIE_VALUE = "ok-jjcool-2026";

export async function onRequestPost({ request }) {
  let payload;
  try {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      payload = await request.json();
    } else {
      const form = await request.formData();
      payload = Object.fromEntries(form.entries());
    }
  } catch (_) {
    payload = {};
  }

  const pass = (payload.password || "").trim();
  if (pass !== PASSWORD) {
    return new Response(JSON.stringify({ ok: false, error: "wrong password" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 30 days
  const maxAge = 60 * 60 * 24 * 30;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
