// Basic auth middleware — gates /admin/* behind a password.
// Username can be anything. Password = "cooljj".
// Browser prompts for credentials via WWW-Authenticate header.

const PASSWORD = "cooljj";

export async function onRequest({ request, next }) {
  const auth = request.headers.get("Authorization");

  if (auth) {
    // "Basic base64(username:password)"
    const match = /^Basic\s+(.+)$/i.exec(auth);
    if (match) {
      try {
        const decoded = atob(match[1]);
        const idx = decoded.indexOf(":");
        if (idx >= 0) {
          const pass = decoded.slice(idx + 1);
          if (pass === PASSWORD) {
            return next();
          }
        }
      } catch (_) { /* fall through */ }
    }
  }

  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="FYP Admin", charset="UTF-8"',
      "Content-Type": "text/plain",
    },
  });
}
