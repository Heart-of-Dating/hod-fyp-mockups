// Custom cookie-based auth — gates /admin/* behind a single password field.
// Set the auth cookie via POST to /api/admin-login.

const PASSWORD = "jjcool";
const COOKIE_NAME = "hod_admin";
const COOKIE_VALUE = "ok-jjcool-2026"; // changes invalidate sessions

export async function onRequest({ request, next }) {
  const url = new URL(request.url);

  // Allow the login page through without auth
  if (url.pathname.endsWith("/login.html") || url.pathname.endsWith("/login")) {
    return next();
  }

  // Check cookie
  const cookies = request.headers.get("Cookie") || "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (match && match[1] === COOKIE_VALUE) {
    return next();
  }

  // No valid cookie — redirect to login page
  return Response.redirect(new URL("/admin/login.html", request.url).toString(), 302);
}
