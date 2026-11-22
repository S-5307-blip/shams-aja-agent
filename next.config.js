/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  experimental: {
    // Next 16's CLI config reader can finish before it receives tsc stdout (same as the office app).
    useTypeScriptCli: false,
  },
  async headers() {
    const isProd = process.env.NODE_ENV === "production";
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "object-src 'none'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
      "connect-src 'self'",
      isProd ? "upgrade-insecure-requests" : "",
    ].filter(Boolean).join("; ");
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
      ],
    }];
  },
};

module.exports = nextConfig;
