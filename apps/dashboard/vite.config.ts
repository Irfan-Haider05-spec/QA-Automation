import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard calls the API on the same origin (/api/...). In dev and preview,
// Vite forwards those calls to the API server; in production the host does it
// (or set CORS_ORIGINS on the API and serve both behind one domain).
const target = process.env.VITE_API_PROXY ?? "http://127.0.0.1:4100";
const proxy = { "/api": { target, changeOrigin: false }, "/health": { target } };

/**
 * Cloudflare Pages: security headers as a _headers file in dist/ (Pages serves index.html
 * for app routes by itself when there's no 404.html). Vercel uses vercel.json instead.
 * With VITE_API_URL (API on another domain) the CSP allows calls to that origin.
 */
const apiOrigin = process.env.VITE_API_URL ? new URL(process.env.VITE_API_URL).origin : "";
const staticHostFiles = (): Plugin => ({
  name: "static-host-files",
  apply: "build",
  generateBundle() {
    const csp = `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ""}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;
    const headers = ["/*", "  X-Content-Type-Options: nosniff", "  X-Frame-Options: DENY", "  Referrer-Policy: strict-origin-when-cross-origin", "  Permissions-Policy: camera=(), microphone=(), geolocation=()", `  Content-Security-Policy: ${csp}`, "", "/assets/*", "  Cache-Control: public, max-age=31536000, immutable", "", "/r/*", "  X-Robots-Tag: noindex, nofollow", ""].join("\n");
    this.emitFile({ type: "asset", fileName: "_headers", source: headers });
  },
});

export default defineConfig({
  plugins: [react(), staticHostFiles()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  // No public source maps in builds (set VITE_SOURCEMAP=true for a debug build)
  build: { sourcemap: process.env.VITE_SOURCEMAP === "true" },
});
