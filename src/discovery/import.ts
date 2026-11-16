import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import type { RouteInfo } from "../core/types.js";

export function readDocument(file: string): Record<string, any> {
  if (fs.statSync(file).size > 10 * 1024 * 1024) throw new Error("API document exceeds 10 MiB");
  const doc = parseDocument(fs.readFileSync(file, "utf8"), { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`Invalid API document: ${doc.errors[0].message}`);
  const data: unknown = doc.toJS({ maxAliasCount: 50 });
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected an API document object");
  return data as Record<string, any>;
}

/** Only in-document references; no network, file loading or source execution. */
export function resolveRef(doc: Record<string, any>, value: any, visited = new Set<string>()): any {
  if (!value?.$ref) return value;
  const ref = value.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) throw new Error("Only local OpenAPI references are supported; bundle external references first");
  if (visited.has(ref)) throw new Error(`Cyclic OpenAPI reference: ${ref}`);
  visited.add(ref);
  let target: any = doc;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!target || !Object.hasOwn(target, key)) throw new Error(`Unresolved OpenAPI reference: ${ref}`);
    target = target[key];
  }
  return resolveRef(doc, target, visited);
}

const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const route = (method: string, p: string, file: string, order: number, authRequired: boolean, roles: string[], multipart = false): RouteInfo => {
  if (!p.startsWith("/") || p.startsWith("//") || /[\\\r\n]/.test(p)) throw new Error(`Invalid route path: ${p}`);
  return { method: method as RouteInfo["method"], path: p, apiPath: p, module: "imported", authRequired, roles, multipart,
    middlewares: [], source: { file, line: 0 }, order, routerFile: file };
};

export function importOpenApi(doc: Record<string, any>, file = "openapi.json"): RouteInfo[] {
  if (!/^3\.[01]\./.test(doc.openapi ?? "")) throw new Error("OpenAPI 3.0/3.1 required (convert Swagger 2 first)");
  if (!doc.paths || typeof doc.paths !== "object") throw new Error("OpenAPI paths missing");
  // Validate nested schemas too, before handing the preserved document to an
  // external consumer. Checking only path/requestBody refs leaves response and
  // component refs able to trigger network or filesystem reads downstream.
  const pending: Array<[unknown, number]> = [[doc, 0]];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length) {
    const [value, depth] = pending.pop()!;
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    if (++nodes > 100000 || depth > 100) throw new Error("OpenAPI document exceeds structural limits");
    seen.add(value);
    const object = value as Record<string, unknown>;
    for (const name of ["$ref", "$dynamicRef"]) {
      if (Object.hasOwn(object, name)) {
        if (typeof object[name] !== "string" || !object[name].startsWith("#/")) throw new Error("Only local OpenAPI references are supported; bundle external references first");
        resolveRef(doc, { $ref: object[name] });
      }
    }
    for (const child of Object.values(object)) pending.push([child, depth + 1]);
  }
  const routes: RouteInfo[] = [];
  for (const [p, item] of Object.entries(doc.paths)) {
    const entry = resolveRef(doc, item);
    for (const [method, raw] of Object.entries(entry)) {
      if (!methods.has(method.toUpperCase())) continue;
      const op = resolveRef(doc, raw);
      if (!op || typeof op !== "object") throw new Error(`Invalid operation: ${method} ${p}`);
      const security = op.security ?? doc.security ?? [];
      if (!Array.isArray(security)) throw new Error("OpenAPI security must be an array");
      const roles = op["x-veriq-roles"] ?? [];
      if (!Array.isArray(roles) || roles.some((v: unknown) => typeof v !== "string")) throw new Error("x-veriq-roles must be a string array");
      const body = resolveRef(doc, op.requestBody);
      const r = route(method.toUpperCase(), p.replace(/\{([^}]+)\}/g, ":$1"), file, routes.length,
        security.length > 0 && !security.some((s: object) => Object.keys(s).length === 0), roles, !!body?.content?.["multipart/form-data"]);
      if (body?.content && Object.values(body.content).some((v: any) => v?.schema)) r.middlewares.push("declared-request-schema");
      routes.push(r);
    }
  }
  return routes;
}

export function importPostman(doc: Record<string, any>, file = "postman.json"): RouteInfo[] {
  if (!doc.info?.schema?.includes("collection/v2.1.0")) throw new Error("Postman collection v2.1 required");
  const routes: RouteInfo[] = [];
  const walk = (items: any[], auth: any, depth: number) => {
    if (depth > 30 || !Array.isArray(items)) throw new Error("Invalid or excessively nested Postman collection");
    for (const item of items) {
      const inherited = item.auth ?? auth;
      if (item.item) { walk(item.item, inherited, depth + 1); continue; }
      const request = item.request;
      if (!request || !methods.has(request.method)) continue;
      const url = request.url;
      let p: string;
      if (typeof url === "object" && Array.isArray(url.path)) p = "/" + url.path.join("/");
      else {
        const raw = typeof url === "string" ? url : url?.raw;
        if (typeof raw !== "string") throw new Error("Postman request URL is missing");
        const normalized = raw.replace(/^\{\{[^}]+\}\}/, "https://placeholder.invalid").replace(/\{\{([^}]+)\}\}/g, ":$1");
        p = new URL(normalized).pathname;
      }
      p = p.replace(/\{\{([^}]+)\}\}/g, ":$1");
      const a = request.auth ?? inherited;
      routes.push(route(request.method, p, file, routes.length, !!a && a.type !== "noauth", [], request.body?.mode === "formdata"));
    }
  };
  walk(doc.item, doc.auth, 0);
  return routes;
}

export function importRoutes(configDir: string, config: { file: string; format: "openapi" | "postman" }) {
  const file = path.resolve(configDir, config.file);
  const document = readDocument(file);
  return { document, routes: config.format === "openapi" ? importOpenApi(document, file) : importPostman(document, file) };
}
