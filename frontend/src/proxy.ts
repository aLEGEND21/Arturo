import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Page-level gate: a browser with no session cookie is sent to /login before
// any page renders. This checks presence only; the backend validates the
// session on every API call and answers 401, which lib/api.ts turns into the
// same redirect. API paths are left alone so the backend's own status codes
// reach the client (and so /api/auth/* can set the cookie in the first place).
const SESSION_COOKIE = "arturo_session";

export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except: API + health (proxied to the backend), the login page,
  // Next internals, and installable-app assets (manifest, icons).
  matcher: [
    "/((?!api/|health|login|_next/|icons/|manifest\\.webmanifest|icon\\.png|apple-icon\\.png|favicon\\.ico).*)",
  ],
};
