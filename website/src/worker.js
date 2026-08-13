const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
};

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === "www.keelnotes.com") {
      url.hostname = "keelnotes.com";
      return Response.redirect(url.toString(), 301);
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    if (url.pathname.startsWith("/assets/")) {
      headers.set("Cache-Control", "public, max-age=3600, must-revalidate");
    } else if (url.pathname === "/og.png") {
      headers.set("Cache-Control", "public, max-age=86400");
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

export default worker;
