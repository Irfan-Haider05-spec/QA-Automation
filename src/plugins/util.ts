import picomatch from "picomatch";
import type { RouteInfo } from "../core/types.js";
import { routeKey } from "../discovery/express-routes.js";

export { routeKey };

/** Match "METHOD /path" keys against allowlist patterns (globs allowed, e.g. "GET /rules/*") */
export function keyMatcher(patterns: string[]) {
  const ms = patterns.map((p) => picomatch(p, { dot: true }));
  return (key: string) => ms.some((m) => m(key));
}

export const isMutating = (r: Pick<RouteInfo, "method">) => r.method !== "GET";
export const hasParams = (p: string) => /:[A-Za-z0-9_]+/.test(p);
export const where = (r: RouteInfo) => ({ file: r.source.file, line: r.source.line });

/** Find ids of the first array of objects inside a JSON response */
export function extractIds(json: any, max: number): string[] {
  const queue: any[] = [json?.data ?? json];
  let guard = 0;
  while (queue.length && guard++ < 200) {
    const cur = queue.shift();
    if (Array.isArray(cur)) {
      const ids = cur
        .map((x) => (x && typeof x === "object" ? x._id ?? x.id : undefined))
        .filter((x): x is string => typeof x === "string" && x.length >= 6);
      if (ids.length) return [...new Set(ids)].slice(0, max);
      for (const x of cur) if (x && typeof x === "object") queue.push(x);
    } else if (cur && typeof cur === "object") {
      for (const v of Object.values(cur)) if (v && typeof v === "object") queue.push(v);
    }
  }
  return [];
}

export const isNotMountedResponse = (status: number, text: string) => status === 404 && /API DOESN'T EXIST|Cannot (GET|POST|PATCH|PUT|DELETE)/i.test(text);
