/**
 * Static route discovery for Express + TypeScript backends.
 * Reads the routes index (the apiRoutes array / router.use calls), follows each
 * imported router file, and records method, full path, auth roles, validation
 * schema and upload middleware for every route, with file:line.
 * Pure AST work: the backend is never started or imported here.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { RouteInfo } from "../core/types.js";

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export interface DiscoveryResult {
  routes: RouteInfo[];
  warnings: string[];
}

interface Ctx {
  backendDir: string;
  warnings: string[];
  routes: RouteInfo[];
  visited: Set<string>;
}

const read = (file: string) => ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

function resolveImport(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(fromFile), spec);
  // ESM TypeScript projects import "./x.js" while the file on disk is "./x.ts"
  const tsTwin = base.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts").replace(/\.cjs$/, ".cts");
  for (const c of [base, tsTwin, `${base}.ts`, `${base}.js`, path.join(base, "index.ts"), path.join(base, "index.js")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return undefined;
}

function importsOf(sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const target = resolveImport(sf.fileName, st.moduleSpecifier.text);
    if (!target || !st.importClause) continue;
    if (st.importClause.name) map.set(st.importClause.name.text, target);
    const nb = st.importClause.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) map.set(el.name.text, target);
    if (nb && ts.isNamespaceImport(nb)) map.set(nb.name.text, target);
  }
  return map;
}

const joinPath = (...parts: string[]) => {
  const p = ("/" + parts.join("/")).replace(/\/+/g, "/");
  return p.length > 1 ? p.replace(/\/$/, "") : p;
};

const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

const calleeName = (e: ts.Expression): string => {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return `${calleeName(e.expression)}.${e.name.text}`;
  if (ts.isCallExpression(e)) return calleeName(e.expression);
  return e.getText();
};

/** Names of variables in this file created with Router() / express.Router() */
function routerVars(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && /\bRouter\s*\(/.test(n.initializer.getText(sf))) {
      names.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/** Resolve `const ADMIN_ROLES = [USER_ROLES.ADMIN, ...]` used as auth(...ADMIN_ROLES) */
function constArrayRoles(sf: ts.SourceFile, name: string): string[] | undefined {
  let found: string[] | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && ts.isArrayLiteralExpression(n.initializer)) {
      found = n.initializer.elements.map((e) => roleText(e, sf)).flat();
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function roleText(e: ts.Expression, sf: ts.SourceFile): string[] {
  if (ts.isPropertyAccessExpression(e)) return [e.name.text];
  if (ts.isStringLiteralLike(e)) return [e.text];
  if (ts.isSpreadElement(e) && ts.isIdentifier(e.expression)) return constArrayRoles(sf, e.expression.text) ?? [`?${e.expression.text}`];
  return [`?${e.getText(sf)}`];
}

function analyseHandlers(args: readonly ts.Expression[], sf: ts.SourceFile, imports: Map<string, string>) {
  const out = { authRequired: false, roles: [] as string[], multipart: false, validation: undefined as RouteInfo["validation"], middlewares: [] as string[] };
  for (const a of args) {
    if (ts.isCallExpression(a)) {
      const name = calleeName(a.expression);
      const short = name.split(".").pop()!;
      out.middlewares.push(short);
      if (/^auth/i.test(short)) {
        out.authRequired = true;
        for (const arg of a.arguments) out.roles.push(...roleText(arg as ts.Expression, sf));
      } else if (/^validate/i.test(short) && a.arguments[0] && ts.isPropertyAccessExpression(a.arguments[0])) {
        const pa = a.arguments[0];
        const exportName = pa.expression.getText(sf);
        const file = imports.get(exportName.split(".")[0]);
        if (file) out.validation = { file, exportName, key: pa.name.text };
      }
      if (/upload|multer/i.test(name) || /\.(single|array|fields|any)$/.test(name)) out.multipart = true;
    } else if (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) {
      out.middlewares.push(a.getText(sf));
    } else {
      out.middlewares.push("inline");
    }
  }
  out.roles = [...new Set(out.roles)];
  return out;
}

function parseRouterFile(file: string, mount: string, module: string, ctx: Ctx) {
  const key = `${file}@${mount}`;
  if (ctx.visited.has(key)) return;
  ctx.visited.add(key);
  const sf = read(file);
  const imports = importsOf(sf);
  const routers = routerVars(sf);
  let order = 0;

  const addRoute = (method: string, routePath: string, handlerArgs: readonly ts.Expression[], node: ts.Node) => {
    const h = analyseHandlers(handlerArgs, sf, imports);
    const full = joinPath(mount, routePath);
    ctx.routes.push({
      method: method.toUpperCase() as RouteInfo["method"],
      path: full,
      apiPath: full,
      module,
      authRequired: h.authRequired,
      roles: h.roles,
      multipart: h.multipart,
      validation: h.validation,
      middlewares: h.middlewares,
      source: { file: path.relative(ctx.backendDir, file).replace(/\\/g, "/"), line: lineOf(sf, node) },
      order: order++,
      routerFile: file,
    });
  };

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const target = n.expression.expression;
      // router.get('/x', ...)
      if (ts.isIdentifier(target) && (routers.has(target.text) || routers.size === 0) && METHODS.has(method)) {
        const [first, ...rest] = n.arguments;
        if (first && ts.isStringLiteralLike(first)) addRoute(method, first.text, rest, n);
        else if (first) ctx.warnings.push(`${path.relative(ctx.backendDir, file)}:${lineOf(sf, n)} non-literal route path skipped`);
      }
      // router.route('/x').get(...).post(...)
      if (METHODS.has(method)) {
        let inner: ts.Expression = target;
        while (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && METHODS.has(inner.expression.name.text)) inner = inner.expression.expression;
        if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === "route" && inner.arguments[0] && ts.isStringLiteralLike(inner.arguments[0])) {
          addRoute(method, inner.arguments[0].text, n.arguments, n);
        }
      }
      // router.use('/sub', SubRoutes)
      if (method === "use" && ts.isIdentifier(target) && routers.has(target.text)) {
        const [first, ...rest] = n.arguments;
        if (first && ts.isStringLiteralLike(first)) {
          for (const r of rest) {
            if (ts.isIdentifier(r) && imports.has(r.text)) parseRouterFile(imports.get(r.text)!, joinPath(mount, first.text), module, ctx);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function moduleNameFor(file: string, backendDir: string) {
  const rel = path.relative(backendDir, file).replace(/\\/g, "/");
  const m = rel.match(/modules\/(.+)\/[^/]+$/);
  return m ? m[1] : path.basename(file).replace(/\..*$/, "");
}

export function discoverRoutes(opts: { backendDir: string; routesIndex: string; apiPrefix: string; appFile?: string }): DiscoveryResult {
  const ctx: Ctx = { backendDir: opts.backendDir, warnings: [], routes: [], visited: new Set() };
  const indexFile = path.resolve(opts.backendDir, opts.routesIndex);
  if (!fs.existsSync(indexFile)) throw new Error(`Routes index not found: ${indexFile}`);
  const sf = read(indexFile);
  const imports = importsOf(sf);
  const mounts: Array<{ path: string; ident: string }> = [];

  const visit = (n: ts.Node) => {
    // { path: "/x", route: XRoutes }
    if (ts.isObjectLiteralExpression(n)) {
      let p: string | undefined, r: string | undefined;
      for (const prop of n.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        if (prop.name.text === "path" && ts.isStringLiteralLike(prop.initializer)) p = prop.initializer.text;
        if (prop.name.text === "route" && ts.isIdentifier(prop.initializer)) r = prop.initializer.text;
      }
      if (p !== undefined && r) mounts.push({ path: p, ident: r });
    }
    // router.use("/x", XRoutes)
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "use") {
      const [first, second] = n.arguments;
      if (first && second && ts.isStringLiteralLike(first) && ts.isIdentifier(second)) mounts.push({ path: first.text, ident: second.text });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  for (const m of mounts) {
    const file = imports.get(m.ident);
    if (!file) {
      ctx.warnings.push(`routes index: cannot resolve import for ${m.ident}`);
      continue;
    }
    parseRouterFile(file, joinPath(opts.apiPrefix, m.path), moduleNameFor(file, opts.backendDir), ctx);
  }

  // App-level routes (health check etc.)
  if (opts.appFile) {
    const appFile = path.resolve(opts.backendDir, opts.appFile);
    if (fs.existsSync(appFile)) {
      const asf = read(appFile);
      const visitApp = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "app" && METHODS.has(n.expression.name.text)) {
          const [first, ...rest] = n.arguments;
          if (first && ts.isStringLiteralLike(first) && first.text !== "*") {
            const h = analyseHandlers(rest, asf, importsOf(asf));
            ctx.routes.push({
              method: n.expression.name.text.toUpperCase() as RouteInfo["method"],
              path: joinPath(first.text), apiPath: joinPath(first.text), module: "app",
              authRequired: h.authRequired, roles: h.roles, multipart: h.multipart, validation: h.validation, middlewares: h.middlewares,
              source: { file: path.relative(opts.backendDir, appFile).replace(/\\/g, "/"), line: lineOf(asf, n) },
              order: 0, routerFile: appFile,
            });
          }
        }
        ts.forEachChild(n, visitApp);
      };
      visitApp(asf);
    }
  }

  const prefix = opts.apiPrefix.replace(/\/$/, "");
  for (const r of ctx.routes) r.apiPath = r.path.startsWith(prefix + "/") ? r.path.slice(prefix.length) : r.path;
  return { routes: ctx.routes, warnings: ctx.warnings };
}

/** "METHOD /path" key used in config allowlists */
export const routeKey = (r: Pick<RouteInfo, "method" | "apiPath">) => `${r.method} ${r.apiPath}`;
