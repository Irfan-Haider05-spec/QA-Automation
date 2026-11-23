/**
 * Static discovery of Mongoose models, their declared indexes, and the queries the code
 * runs against them. Pure AST work: the backend is never started or imported.
 *
 * Indexes come from schema field options (`index`, `unique`, `expires`, `text`) and
 * `schema.index({...})` calls. Queries are `Model.find/findOne/... (filter)`, `distinct`,
 * the first `$match` of `Model.aggregate([...])`, and a chained `.sort({...})`.
 * Anything the code builds at runtime (a filter variable, a spread, a computed key) is
 * counted as dynamic and never guessed.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { resolveImport } from "./express-routes.js";

export type Direction = 1 | -1 | "text" | "2dsphere" | "2d" | "hashed";
export interface IndexKey { field: string; dir: Direction }
export interface IndexDef {
  keys: IndexKey[]; unique: boolean; sparse: boolean; partial: boolean; source: string;
  /** Why MongoDB refuses to build this index; Mongoose only logs that, so the index never exists. */
  unbuildable?: string;
}
export interface ModelDef { name: string; file: string; line: number; collection?: string; indexes: IndexDef[] }
export interface QueryUse { model: string; method: string; branches: string[][]; sort: string[]; source: string }
export interface MongooseDiscovery {
  files: number; models: ModelDef[]; queries: QueryUse[];
  skipped: { dynamic: number; unfiltered: number; text: number };
  warnings: string[];
}

const QUERY_METHODS = new Set(["find", "findOne", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "findOneAndRemove",
  "updateOne", "updateMany", "deleteOne", "deleteMany", "replaceOne", "countDocuments", "exists", "distinct", "aggregate"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", "test", "tests", "__tests__"]);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;

/** Parser mode by extension (JSX/TSX need their own, or `<div>` would be read as a type cast). */
export const scriptKind = (file: string) =>
  file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".jsx") ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
const read = (file: string) => ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, scriptKind(file));
const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

/** Backend source files (TS/JS), skipping dependencies, builds, tests and type declarations. */
export function sourceFiles(dir: string, warnings: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 20) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(full, depth + 1); continue; }
      if (!e.isFile() || !/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name) || /\.d\.ts$|\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) continue;
      if (out.length >= MAX_FILES) { warnings.push(`Stopped after ${MAX_FILES} source files`); return; }
      try { if (fs.statSync(full).size <= MAX_FILE_BYTES) out.push(full); else warnings.push(`${path.relative(dir, full)} skipped: larger than 1 MiB`); } catch { /* vanished */ }
    }
  };
  walk(dir, 0);
  return out.sort();
}

const propName = (n: ts.PropertyName | undefined): string | undefined =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) ? n.text : undefined;
const unwrap = (e: ts.Expression): ts.Expression => {
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
};
const prop = (o: ts.ObjectLiteralExpression, key: string) => {
  for (const p of o.properties) if (ts.isPropertyAssignment(p) && propName(p.name) === key) return unwrap(p.initializer);
  return undefined;
};
const isTrue = (e: ts.Expression | undefined) => !!e && e.kind === ts.SyntaxKind.TrueKeyword;

/**
 * Operators MongoDB rejects in a partialFilterExpression ("Expression not supported in partial
 * index"). Only operators that are refused on every supported server are listed, so a newer
 * server's additions cannot turn into false reports. `$exists: false` is refused too.
 */
const PARTIAL_UNSUPPORTED = new Set(["$ne", "$nin", "$not", "$nor", "$regex", "$expr", "$where", "$elemMatch", "$size", "$all", "$mod", "$text"]);
function partialProblem(expr: ts.Expression | undefined, depth = 0): string | undefined {
  if (!expr || depth > 20) return undefined;
  expr = unwrap(expr);
  if (ts.isArrayLiteralExpression(expr)) { for (const el of expr.elements) { const r = partialProblem(el as ts.Expression, depth + 1); if (r) return r; } return undefined; }
  if (!ts.isObjectLiteralExpression(expr)) return undefined;
  for (const p of expr.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = propName(p.name);
    const value = unwrap(p.initializer);
    if (key && PARTIAL_UNSUPPORTED.has(key)) return `${key} is not supported in a partialFilterExpression`;
    if (key === "$exists" && value.kind === ts.SyntaxKind.FalseKeyword) return "$exists: false is not supported in a partialFilterExpression";
    const inner = partialProblem(value, depth + 1);
    if (inner) return inner;
  }
  return undefined;
}
const partialOf = (o: ts.ObjectLiteralExpression | undefined) => {
  const expr = o && prop(o, "partialFilterExpression");
  const problem = partialProblem(expr);
  return { partial: !!expr, ...(problem ? { unbuildable: problem } : {}) };
};

function direction(e: ts.Expression): Direction | undefined {
  e = unwrap(e);
  if (ts.isNumericLiteral(e)) return Number(e.text) === 1 ? 1 : Number(e.text) === -1 ? -1 : undefined;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand) && e.operand.text === "1") return -1;
  if (ts.isStringLiteral(e) && ["text", "2dsphere", "2d", "hashed"].includes(e.text)) return e.text as Direction;
  if (ts.isStringLiteral(e) && (e.text === "1" || e.text === "asc" || e.text === "ascending")) return 1;
  if (ts.isStringLiteral(e) && (e.text === "-1" || e.text === "desc" || e.text === "descending")) return -1;
  return undefined;
}

const isNewSchema = (e: ts.Expression): e is ts.NewExpression => {
  e = unwrap(e);
  if (!ts.isNewExpression(e)) return false;
  const c = e.expression;
  return (ts.isIdentifier(c) && c.text === "Schema") || (ts.isPropertyAccessExpression(c) && c.name.text === "Schema");
};

/** Field-level index options, recursing into nested paths. Sub-schema variables are not followed. */
function fieldIndexes(obj: ts.ObjectLiteralExpression, prefix: string, sf: ts.SourceFile, out: IndexDef[]) {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const name = propName(p.name);
    if (!name) continue;
    let value = unwrap(p.initializer);
    if (ts.isArrayLiteralExpression(value) && value.elements.length === 1) value = unwrap(value.elements[0] as ts.Expression);
    if (!ts.isObjectLiteralExpression(value)) continue;
    const field = prefix + name;
    if (!prop(value, "type")) { fieldIndexes(value, `${field}.`, sf, out); continue; }
    const index = prop(value, "index"), unique = isTrue(prop(value, "unique")), sparse = isTrue(prop(value, "sparse"));
    const source = `${sf.fileName}:${lineOf(sf, p)}`;
    if (isTrue(prop(value, "text"))) out.push({ keys: [{ field, dir: "text" }], unique: false, sparse: false, partial: false, source });
    if (index && ts.isStringLiteral(index) && direction(index)) out.push({ keys: [{ field, dir: direction(index)! }], unique, sparse, partial: false, source });
    else if (index && ts.isObjectLiteralExpression(index)) out.push({ keys: [{ field, dir: 1 }], unique: unique || isTrue(prop(index, "unique")), sparse: sparse || isTrue(prop(index, "sparse")), ...partialOf(index), source });
    else if (isTrue(index) || unique || prop(value, "expires")) out.push({ keys: [{ field, dir: 1 }], unique, sparse, partial: false, source });
  }
}

function compoundIndex(call: ts.CallExpression, sf: ts.SourceFile): IndexDef | undefined {
  const spec = call.arguments[0] && unwrap(call.arguments[0]);
  if (!spec || !ts.isObjectLiteralExpression(spec)) return undefined;
  const keys: IndexKey[] = [];
  for (const p of spec.properties) {
    if (!ts.isPropertyAssignment(p)) return undefined;
    const field = propName(p.name), dir = direction(p.initializer);
    if (!field || !dir) return undefined;
    keys.push({ field, dir });
  }
  if (!keys.length) return undefined;
  const opts = call.arguments[1] && unwrap(call.arguments[1]);
  const o = opts && ts.isObjectLiteralExpression(opts) ? opts : undefined;
  return { keys, unique: isTrue(o && prop(o, "unique")), sparse: isTrue(o && prop(o, "sparse")), ...partialOf(o), source: `${sf.fileName}:${lineOf(sf, call)}` };
}

const modelCall = (e: ts.Expression): ts.CallExpression | undefined => {
  e = unwrap(e);
  if (ts.isBinaryExpression(e)) return modelCall(e.right) ?? modelCall(e.left); // mongoose.models.X || model(...)
  if (!ts.isCallExpression(e)) return undefined;
  const c = e.expression;
  const isModel = (ts.isIdentifier(c) && c.text === "model") || (ts.isPropertyAccessExpression(c) && c.name.text === "model");
  return isModel && e.arguments[0] && ts.isStringLiteral(unwrap(e.arguments[0])) ? e : undefined;
};

interface FileModels { byVar: Map<string, string>; defaultModel?: string }

/** Filter keys per $or branch, or "dynamic" when the code builds the filter at runtime. */
export function filterBranches(e: ts.Expression): string[][] | "dynamic" | "text" {
  e = unwrap(e);
  if (!ts.isObjectLiteralExpression(e)) return "dynamic";
  const base: string[] = [];
  let branches: string[][] = [[]];
  for (const p of e.properties) {
    if (ts.isShorthandPropertyAssignment(p)) { base.push(p.name.text); continue; }
    if (!ts.isPropertyAssignment(p)) return "dynamic"; // spread, method, accessor
    const key = propName(p.name);
    if (key === undefined) return "dynamic"; // computed key
    if (!key.startsWith("$")) { base.push(key); continue; }
    if (key === "$text") return "text";
    const list = unwrap(p.initializer);
    if (key === "$and" || key === "$or") {
      if (!ts.isArrayLiteralExpression(list)) return "dynamic";
      const parts = list.elements.map((x) => filterBranches(x as ts.Expression));
      if (parts.some((x) => x === "dynamic")) return "dynamic";
      if (parts.some((x) => x === "text")) return "text";
      const typed = parts as string[][][];
      if (key === "$or") branches = branches.flatMap((b) => typed.flat().map((x) => [...b, ...x]));
      else for (const part of typed) branches = branches.flatMap((b) => part.map((x) => [...b, ...x]));
      if (branches.length > 64) return "dynamic";
    }
    // $nor, $expr, $where, $comment: no field an index could start from
  }
  return branches.map((b) => [...new Set([...base, ...b])]);
}

function sortAfter(call: ts.CallExpression): string[] {
  let node: ts.Node = call;
  for (let i = 0; i < 6; i++) {
    const access = node.parent;
    if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== node) return [];
    const next = access.parent;
    if (!next || !ts.isCallExpression(next) || next.expression !== access) return [];
    if (access.name.text === "sort") {
      const arg = next.arguments[0] && unwrap(next.arguments[0]);
      if (arg && ts.isObjectLiteralExpression(arg)) return arg.properties.map((p) => (ts.isPropertyAssignment(p) ? propName(p.name) : undefined)).filter((x): x is string => !!x);
      if (arg && ts.isStringLiteral(arg)) return arg.text.split(/\s+/).filter(Boolean).map((k) => k.replace(/^[-+]/, ""));
      return [];
    }
    node = next;
  }
  return [];
}

export function discoverMongoose(backendDir: string): MongooseDiscovery {
  const warnings: string[] = [];
  const files = sourceFiles(backendDir, warnings);
  const parsed = new Map<string, ts.SourceFile>();
  for (const f of files) {
    try { parsed.set(f, read(f)); } catch { warnings.push(`${path.relative(backendDir, f)} could not be parsed`); }
  }
  const rel = (s: string) => {
    const [file, line] = [s.slice(0, s.lastIndexOf(":")), s.slice(s.lastIndexOf(":") + 1)];
    return `${path.relative(backendDir, file).split(path.sep).join("/")}:${line}`;
  };

  // Pass 1: schemas, their indexes and the models built from them.
  const models = new Map<string, ModelDef>();
  const fileModels = new Map<string, FileModels>();
  for (const [file, sf] of parsed) {
    const schemas = new Map<string, { indexes: IndexDef[]; collection?: string }>();
    const fm: FileModels = { byVar: new Map() };
    const schemaInfo = (n: ts.NewExpression) => {
      const indexes: IndexDef[] = [];
      const fields = n.arguments?.[0] && unwrap(n.arguments[0]);
      if (fields && ts.isObjectLiteralExpression(fields)) fieldIndexes(fields, "", sf, indexes);
      const opts = n.arguments?.[1] && unwrap(n.arguments[1]);
      const coll = opts && ts.isObjectLiteralExpression(opts) ? prop(opts, "collection") : undefined;
      return { indexes, collection: coll && ts.isStringLiteral(coll) ? coll.text : undefined };
    };
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isNewSchema(node.initializer)) schemas.set(node.name.text, schemaInfo(unwrap(node.initializer) as ts.NewExpression));
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "index" && ts.isIdentifier(node.expression.expression)) {
        const schema = schemas.get(node.expression.expression.text);
        const idx = schema && compoundIndex(node, sf);
        if (idx) schema!.indexes.push(idx);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    const bind = (call: ts.CallExpression, variable: string | undefined, isDefault: boolean) => {
      const name = (unwrap(call.arguments[0]) as ts.StringLiteral).text;
      const schemaArg = call.arguments[1] && unwrap(call.arguments[1]);
      const schema = schemaArg && ts.isIdentifier(schemaArg) ? schemas.get(schemaArg.text) : schemaArg && isNewSchema(schemaArg) ? schemaInfo(schemaArg) : undefined;
      if (!schema) { warnings.push(`${rel(`${file}:${lineOf(sf, call)}`)}: model ${name} uses a schema defined elsewhere; its indexes are not known statically`); }
      const third = call.arguments[2] && unwrap(call.arguments[2]);
      const existing = models.get(name);
      if (!existing) models.set(name, { name, file: rel(`${file}:0`).replace(/:0$/, ""), line: lineOf(sf, call), collection: third && ts.isStringLiteral(third) ? third.text : schema?.collection, indexes: (schema?.indexes ?? []).map((i) => ({ ...i, source: rel(i.source) })) });
      if (variable) fm.byVar.set(variable, name);
      if (isDefault) fm.defaultModel = name;
    };
    const findModels = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) { const c = modelCall(node.initializer); if (c) bind(c, node.name.text, false); }
      if (ts.isExportAssignment(node)) { const c = modelCall(node.expression); if (c) bind(c, undefined, true); else if (ts.isIdentifier(node.expression)) fm.defaultModel = fm.byVar.get(node.expression.text) ?? fm.defaultModel; }
      ts.forEachChild(node, findModels);
    };
    findModels(sf);
    fileModels.set(file, fm);
  }

  // Pass 2: queries through local or imported model bindings.
  const queries: QueryUse[] = [];
  const skipped = { dynamic: 0, unfiltered: 0, text: 0 };
  for (const [file, sf] of parsed) {
    const local = new Map(fileModels.get(file)?.byVar ?? []);
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue;
      const target = resolveImport(file, st.moduleSpecifier.text);
      const fm = target ? fileModels.get(target) : undefined;
      if (!fm) continue;
      if (st.importClause.name && fm.defaultModel) local.set(st.importClause.name.text, fm.defaultModel);
      const nb = st.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) {
        const exported = (el.propertyName ?? el.name).text;
        const model = exported === "default" ? fm.defaultModel : fm.byVar.get(exported);
        if (model) local.set(el.name.text, model);
      }
    }
    if (!local.size) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && QUERY_METHODS.has(node.expression.name.text) && local.has(node.expression.expression.text)) {
        const method = node.expression.name.text, model = local.get(node.expression.expression.text)!;
        let filter: ts.Expression | undefined = method === "distinct" ? node.arguments[1] : node.arguments[0];
        if (method === "aggregate") {
          const pipeline = filter && unwrap(filter);
          const first = pipeline && ts.isArrayLiteralExpression(pipeline) ? pipeline.elements[0] : undefined;
          const stage = first && unwrap(first as ts.Expression);
          filter = stage && ts.isObjectLiteralExpression(stage) ? prop(stage, "$match") : undefined;
          if (!pipeline || !ts.isArrayLiteralExpression(pipeline)) { skipped.dynamic++; ts.forEachChild(node, visit); return; }
        }
        const sort = sortAfter(node);
        const branches = filter ? filterBranches(filter) : [[]];
        if (branches === "dynamic") skipped.dynamic++;
        else if (branches === "text") skipped.text++;
        else if (branches.every((b) => !b.length) && !sort.length) skipped.unfiltered++;
        else queries.push({ model, method, branches, sort, source: rel(`${file}:${lineOf(sf, node)}`) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { files: files.length, models: [...models.values()].sort((a, b) => a.name.localeCompare(b.name)), queries, skipped, warnings };
}

// An index MongoDB refuses to build serves no query.
const usable = (i: IndexDef) => i.keys[0].dir !== "text" && !i.unbuildable;
const signature = (i: IndexDef) => i.keys.map((k) => `${k.field}:${k.dir}`).join(",");

/** Branches no index can start from. An index is usable when its first field is in the branch (or, with no filter, the first sort field). */
export function uncoveredBranches(q: QueryUse, indexes: IndexDef[]): string[][] {
  const all = [{ keys: [{ field: "_id", dir: 1 as const }], unique: true, sparse: false, partial: false, source: "_id" }, ...indexes].filter(usable);
  return q.branches.filter((b) => {
    if (!b.length) return !q.sort.length ? false : !all.some((i) => i.keys[0].field === q.sort[0]);
    return !all.some((i) => b.includes(i.keys[0].field));
  });
}

/** Indexes declared twice, and non-unique plain indexes that are a prefix of another index. */
export function indexProblems(indexes: IndexDef[]) {
  const duplicates: [IndexDef, IndexDef][] = [];
  const redundant: [IndexDef, IndexDef][] = [];
  const unbuildable = indexes.filter((i) => i.unbuildable);
  indexes.forEach((a, i) => {
    if (a.unbuildable) return;
    const dup = indexes.slice(0, i).find((b) => signature(b) === signature(a));
    if (dup) { duplicates.push([a, dup]); return; }
    if (a.unique || a.sparse || a.partial || !usable(a) || a.keys.some((k) => typeof k.dir === "string")) return;
    const wider = indexes.find((b) => b !== a && !b.sparse && !b.partial && !b.unbuildable && b.keys.length > a.keys.length && signature(b).startsWith(signature(a) + ","));
    if (wider) redundant.push([a, wider]);
  });
  return { duplicates, redundant, unbuildable };
}
