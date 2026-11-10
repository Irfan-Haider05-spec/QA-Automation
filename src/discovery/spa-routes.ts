/**
 * Static route discovery for React dashboards (React Router):
 *   { path: "/promotions", element: ... }   and   <Route path="/promotions" ... />
 * Only absolute, parameter-free paths are returned; nested relative routes and
 * ":id" routes are reached by following links during the crawl instead.
 */
import fs from "node:fs";
import path from "node:path";

function walk(dir: string, out: string[] = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "build", ".git"].includes(e.name) || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|jsx|ts|js)$/.test(e.name) && !/\.(test|spec|stories)\./.test(e.name)) out.push(p);
  }
  return out;
}

export function discoverSpaRoutes(sourceDir: string): string[] {
  const root = fs.existsSync(path.join(sourceDir, "src")) ? path.join(sourceDir, "src") : sourceDir;
  const found = new Set<string>();
  for (const f of walk(root)) {
    const text = fs.readFileSync(f, "utf8");
    if (!/Route|createBrowserRouter|path\s*:/.test(text)) continue;
    const patterns = [/\bpath\s*:\s*["'`](\/[^"'`]*)["'`]/g, /<Route\b[^>]*\bpath\s*=\s*["'{`]+(\/[^"'`}]*)["'`}]/g];
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const p = m[1].trim();
        if (!p || p.includes(":") || p.includes("*") || p.includes("${")) continue;
        found.add(p.length > 1 ? p.replace(/\/+$/, "") : p);
      }
    }
  }
  return [...found].sort();
}
