import { NextResponse, type NextRequest } from "next/server";

// Per-request, nonce-based Content-Security-Policy for pages. Only scripts
// Next stamps with this request's nonce can run ('strict-dynamic' lets them
// load the rest of the bundle, like the lazily imported Mapbox GL), so an
// injected <script> can't execute in a page that holds camera/mic access.
// Beyond our own origin, Pulse only talks to Mapbox (styles, tiles, sprites,
// telemetry) and runs Mapbox's workers from blob: URLs.
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  const csp = [
    "default-src 'self'",
    // React needs eval in dev for its debugging aids; never in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Dev-mode CSS hot reload injects <style> tags without a nonce.
    `style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    // React style props and Mapbox's marker positioning are style attributes.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.mapbox.com",
    "font-src 'self'",
    "connect-src 'self' https://*.mapbox.com",
    "worker-src 'self' blob:",
    "child-src blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: API routes return JSON, static assets need no CSP.
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
