/**
 * JSON assertions shared by API scenarios (and later database checks): a small JSON path,
 * declarative value assertions, a strict JSON Schema subset and snapshot normalisation.
 * Everything is bounded and never uses eval; unknown schema keywords are rejected rather
 * than ignored, so a schema can never pass because a keyword was silently skipped.
 */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const MAX_DEPTH = 64;

// ---------- JSON path ----------

type Segment = { key: string } | { index: number };

/** `$`, `$.a.b`, `$.items[0]`, `$.items[-1]`, `$["odd key"]`, `$.items.length`. */
export function parsePath(path: string): Segment[] {
  if (!path.startsWith("$")) throw new Error(`JSON path ${path} must start with $`);
  const out: Segment[] = [];
  let i = 1;
  while (i < path.length) {
    if (path[i] === ".") {
      const m = /^[A-Za-z0-9_$-]+/.exec(path.slice(i + 1));
      if (!m) throw new Error(`Invalid JSON path ${path} at position ${i}`);
      out.push({ key: m[0] }); i += 1 + m[0].length;
    } else if (path[i] === "[") {
      const num = /^\[(-?\d{1,6})\]/.exec(path.slice(i));
      const str = /^\["((?:[^"\\]|\\.){1,200})"\]/.exec(path.slice(i));
      if (num) { out.push({ index: Number(num[1]) }); i += num[0].length; }
      else if (str) { out.push({ key: JSON.parse(`"${str[1]}"`) }); i += str[0].length; }
      else throw new Error(`Invalid JSON path ${path} at position ${i}`);
    } else throw new Error(`Invalid JSON path ${path} at position ${i}`);
    if (out.length > MAX_DEPTH) throw new Error(`JSON path ${path} is too deep`);
  }
  return out;
}

/** Own properties only: `__proto__`, `constructor` and other inherited names are never reached. */
export function getPath(value: unknown, path: string): { found: boolean; value?: unknown } {
  let cur: unknown = value;
  for (const seg of parsePath(path)) {
    if ("index" in seg) {
      if (!Array.isArray(cur)) return { found: false };
      const i = seg.index < 0 ? cur.length + seg.index : seg.index;
      if (i < 0 || i >= cur.length) return { found: false };
      cur = cur[i];
    } else if ((Array.isArray(cur) || typeof cur === "string") && seg.key === "length") cur = cur.length;
    else if (cur !== null && typeof cur === "object" && !Array.isArray(cur) && Object.hasOwn(cur, seg.key)) cur = (cur as Record<string, unknown>)[seg.key];
    else return { found: false };
  }
  return { found: true, value: cur };
}

/** Remove the value at a path (used to ignore volatile fields in snapshots). */
function deletePath(value: unknown, path: string) {
  const segs = parsePath(path);
  if (!segs.length) return;
  let cur: unknown = value;
  for (const seg of segs.slice(0, -1)) {
    if ("index" in seg) { if (!Array.isArray(cur)) return; cur = cur[seg.index < 0 ? cur.length + seg.index : seg.index]; }
    else if (cur && typeof cur === "object" && Object.hasOwn(cur, seg.key)) cur = (cur as Record<string, unknown>)[seg.key];
    else return;
  }
  const last = segs[segs.length - 1];
  if ("key" in last && cur && typeof cur === "object" && !Array.isArray(cur)) delete (cur as Record<string, unknown>)[last.key];
  else if ("index" in last && Array.isArray(cur)) cur.splice(last.index < 0 ? cur.length + last.index : last.index, 1);
}

/** `$.items[*].updatedAt` style paths: expand `[*]` over arrays. */
function expandWildcards(value: unknown, path: string): string[] {
  const at = path.indexOf("[*]");
  if (at < 0) return [path];
  const head = path.slice(0, at), tail = path.slice(at + 3);
  const arr = getPath(value, head);
  if (!arr.found || !Array.isArray(arr.value)) return [];
  return arr.value.flatMap((_, i) => expandWildcards(value, `${head}[${i}]${tail}`));
}

// ---------- assertions ----------

const TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"] as const;
const regex = z.string().min(1).max(200).refine((r) => { try { new RegExp(r); return true; } catch { return false; } }, "Invalid regular expression");

export interface Assertion {
  path: string; exists?: boolean; equals?: unknown; notEquals?: unknown; contains?: unknown; notContains?: unknown; matches?: string;
  type?: (typeof TYPES)[number]; gt?: number; gte?: number; lt?: number; lte?: number; length?: number; minLength?: number; maxLength?: number;
  oneOf?: unknown[]; every?: Assertion[]; some?: Assertion[];
}
export const assertionSchema: z.ZodType<Assertion> = z.lazy(() => z.object({
  path: z.string().min(1).max(500).refine((p) => { try { parsePath(p); return true; } catch { return false; } }, "Invalid JSON path (use $.a.b[0])"),
  exists: z.boolean().optional(), equals: z.unknown().optional(), notEquals: z.unknown().optional(),
  contains: z.unknown().optional(), notContains: z.unknown().optional(), matches: regex.optional(),
  type: z.enum(TYPES).optional(), gt: z.number().optional(), gte: z.number().optional(), lt: z.number().optional(), lte: z.number().optional(),
  length: z.number().int().min(0).optional(), minLength: z.number().int().min(0).optional(), maxLength: z.number().int().min(0).optional(),
  oneOf: z.array(z.unknown()).min(1).max(100).optional(),
  every: z.array(assertionSchema).min(1).max(50).optional(), some: z.array(assertionSchema).min(1).max(50).optional(),
}).strict().refine((a) => Object.keys(a).some((k) => k !== "path"), "Give the assertion an operator (equals, exists, type, …)")) as z.ZodType<Assertion>;

export const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[_-]?key|otp|cvv|pin$/i;

/** A short, safe rendering of a value for a failure message. */
export function show(v: unknown, path = ""): string {
  if (SENSITIVE_KEY.test(path.split(/[.[\]"]/).filter(Boolean).pop() ?? "")) return "[redacted]";
  let s: string;
  try { s = v === undefined ? "missing" : JSON.stringify(v, (k, x) => (k && SENSITIVE_KEY.test(k) ? "[redacted]" : x)); } catch { s = String(v); }
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

function containsValue(hay: unknown, needle: unknown): boolean {
  if (typeof hay === "string") return typeof needle === "string" && hay.includes(needle);
  if (Array.isArray(hay)) return hay.some((x) => isDeepStrictEqual(x, needle) || (isObj(needle) && isObj(x) && subset(x, needle)));
  if (isObj(hay) && isObj(needle)) return subset(hay, needle);
  return false;
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const subset = (obj: Record<string, unknown>, part: Record<string, unknown>): boolean =>
  Object.entries(part).every(([k, v]) => Object.hasOwn(obj, k) && (isObj(v) && isObj(obj[k]) ? subset(obj[k] as Record<string, unknown>, v) : isDeepStrictEqual(obj[k], v)));

/** Failure messages for one assertion (empty = passed). */
export function check(root: unknown, a: Assertion, depth = 0): string[] {
  if (depth > 8) return [`${a.path}: assertions nested too deeply`];
  const { found, value } = getPath(root, a.path);
  const p = a.path, errs: string[] = [];
  if (a.exists !== undefined) { if (found !== a.exists) errs.push(`${p}: expected ${a.exists ? "to exist" : "to be absent"}${found ? `, got ${show(value, p)}` : ""}`); if (!found) return errs; }
  if (!found) return [`${p}: not found in the response`];
  const num = typeof value === "number" ? value : undefined;
  const len = typeof value === "string" || Array.isArray(value) ? value.length : undefined;
  if (Object.hasOwn(a, "equals") && !isDeepStrictEqual(value, a.equals)) errs.push(`${p}: expected ${show(a.equals, p)}, got ${show(value, p)}`);
  if (Object.hasOwn(a, "notEquals") && isDeepStrictEqual(value, a.notEquals)) errs.push(`${p}: expected anything but ${show(a.notEquals, p)}`);
  if (Object.hasOwn(a, "contains") && !containsValue(value, a.contains)) errs.push(`${p}: expected to contain ${show(a.contains, p)}, got ${show(value, p)}`);
  if (Object.hasOwn(a, "notContains") && containsValue(value, a.notContains)) errs.push(`${p}: expected not to contain ${show(a.notContains, p)}`);
  if (a.matches !== undefined && !(typeof value === "string" && value.length <= 10_000 && new RegExp(a.matches).test(value))) errs.push(`${p}: expected to match /${a.matches}/, got ${show(value, p)}`);
  if (a.type) {
    const t = typeOf(value);
    const ok = a.type === "integer" ? Number.isInteger(value) : t === a.type;
    if (!ok) errs.push(`${p}: expected type ${a.type}, got ${t}`);
  }
  for (const [op, limit, test] of [["gt", a.gt, (x: number, l: number) => x > l], ["gte", a.gte, (x: number, l: number) => x >= l], ["lt", a.lt, (x: number, l: number) => x < l], ["lte", a.lte, (x: number, l: number) => x <= l]] as const) {
    if (limit === undefined) continue;
    if (num === undefined || !test(num, limit)) errs.push(`${p}: expected ${op} ${limit}, got ${show(value, p)}`);
  }
  if (a.length !== undefined && len !== a.length) errs.push(`${p}: expected length ${a.length}, got ${len ?? typeOf(value)}`);
  if (a.minLength !== undefined && (len === undefined || len < a.minLength)) errs.push(`${p}: expected length at least ${a.minLength}, got ${len ?? typeOf(value)}`);
  if (a.maxLength !== undefined && (len === undefined || len > a.maxLength)) errs.push(`${p}: expected length at most ${a.maxLength}, got ${len ?? typeOf(value)}`);
  if (a.oneOf && !a.oneOf.some((x) => isDeepStrictEqual(x, value))) errs.push(`${p}: expected one of ${show(a.oneOf)}, got ${show(value, p)}`);
  if (a.every || a.some) {
    if (!Array.isArray(value)) errs.push(`${p}: expected an array for every/some, got ${typeOf(value)}`);
    else {
      if (a.every) value.forEach((el, i) => { for (const inner of a.every!) errs.push(...check(el, inner, depth + 1).map((e) => `${p}[${i}]${e.slice(1)}`)); });
      if (a.some && !value.some((el) => a.some!.every((inner) => check(el, inner, depth + 1).length === 0))) errs.push(`${p}: no element matches ${show(a.some)}`);
    }
  }
  return errs.slice(0, 20);
}

// ---------- JSON Schema subset ----------

const SCHEMA_KEYS = new Set(["type", "enum", "const", "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "format", "anyOf", "oneOf", "allOf", "not",
  "title", "description", "examples", "default", "$comment"]);
const FORMATS: Record<string, RegExp> = {
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  objectid: /^[0-9a-f]{24}$/i,
  uri: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i,
};

/** Reject keywords this validator does not implement ($ref, patternProperties, …). */
export function checkSchemaKeywords(schema: unknown, at = "schema", depth = 0): void {
  if (depth > MAX_DEPTH) throw new Error(`${at}: schema nested too deeply`);
  if (typeof schema === "boolean") return;
  if (!isObj(schema)) throw new Error(`${at}: a schema must be an object`);
  for (const k of Object.keys(schema)) if (!SCHEMA_KEYS.has(k)) throw new Error(`${at}: unsupported JSON Schema keyword "${k}"`);
  if (schema.format !== undefined && !(typeof schema.format === "string" && FORMATS[schema.format])) throw new Error(`${at}: unsupported format ${show(schema.format)} (use ${Object.keys(FORMATS).join(", ")})`);
  if (schema.pattern !== undefined) regex.parse(schema.pattern);
  if (isObj(schema.properties)) for (const [k, s] of Object.entries(schema.properties)) checkSchemaKeywords(s, `${at}.properties.${k}`, depth + 1);
  if (schema.items !== undefined) checkSchemaKeywords(schema.items, `${at}.items`, depth + 1);
  if (isObj(schema.additionalProperties)) checkSchemaKeywords(schema.additionalProperties, `${at}.additionalProperties`, depth + 1);
  for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(schema[k])) (schema[k] as unknown[]).forEach((s, i) => checkSchemaKeywords(s, `${at}.${k}[${i}]`, depth + 1));
  if (schema.not !== undefined) checkSchemaKeywords(schema.not, `${at}.not`, depth + 1);
}

/** Validation errors (empty = valid). Paths are reported as JSON paths. */
export function validateSchema(value: unknown, schema: unknown, at = "$", depth = 0): string[] {
  if (depth > MAX_DEPTH) return [`${at}: value nested too deeply`];
  if (schema === true) return [];
  if (schema === false) return [`${at}: no value is allowed here`];
  const s = schema as Record<string, any>;
  const errs: string[] = [];
  const t = typeOf(value);
  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((x) => (x === "integer" ? Number.isInteger(value) : x === "number" ? typeof value === "number" : x === t))) return [`${at}: expected type ${types.join(" or ")}, got ${t}`];
  }
  if (s.enum && !s.enum.some((x: unknown) => isDeepStrictEqual(x, value))) errs.push(`${at}: expected one of ${show(s.enum)}, got ${show(value, at)}`);
  if (Object.hasOwn(s, "const") && !isDeepStrictEqual(s.const, value)) errs.push(`${at}: expected ${show(s.const, at)}, got ${show(value, at)}`);
  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < s.minLength) errs.push(`${at}: shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && value.length > s.maxLength) errs.push(`${at}: longer than ${s.maxLength}`);
    if (s.pattern !== undefined && !(value.length <= 10_000 && new RegExp(s.pattern).test(value))) errs.push(`${at}: does not match /${s.pattern}/`);
    if (s.format !== undefined && !FORMATS[s.format].test(value)) errs.push(`${at}: not a valid ${s.format}`);
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) errs.push(`${at}: below minimum ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) errs.push(`${at}: above maximum ${s.maximum}`);
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) errs.push(`${at}: must be greater than ${s.exclusiveMinimum}`);
    if (s.exclusiveMaximum !== undefined && value >= s.exclusiveMaximum) errs.push(`${at}: must be less than ${s.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) errs.push(`${at}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) errs.push(`${at}: more than ${s.maxItems} items`);
    if (s.uniqueItems && value.some((x, i) => value.slice(0, i).some((y) => isDeepStrictEqual(x, y)))) errs.push(`${at}: items are not unique`);
    if (s.items !== undefined) value.slice(0, 1000).forEach((x, i) => errs.push(...validateSchema(x, s.items, `${at}[${i}]`, depth + 1)));
  }
  if (isObj(value)) {
    for (const k of s.required ?? []) if (!Object.hasOwn(value, k)) errs.push(`${at}: missing required property ${k}`);
    const props = isObj(s.properties) ? s.properties : {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) errs.push(...validateSchema(v, props[k], `${at}.${k}`, depth + 1));
      else if (s.additionalProperties === false) errs.push(`${at}: unexpected property ${k}`);
      else if (isObj(s.additionalProperties)) errs.push(...validateSchema(v, s.additionalProperties, `${at}.${k}`, depth + 1));
    }
  }
  if (s.allOf) for (const sub of s.allOf) errs.push(...validateSchema(value, sub, at, depth + 1));
  if (s.anyOf && !s.anyOf.some((sub: unknown) => validateSchema(value, sub, at, depth + 1).length === 0)) errs.push(`${at}: matches none of anyOf`);
  if (s.oneOf && s.oneOf.filter((sub: unknown) => validateSchema(value, sub, at, depth + 1).length === 0).length !== 1) errs.push(`${at}: must match exactly one of oneOf`);
  if (s.not !== undefined && validateSchema(value, s.not, at, depth + 1).length === 0) errs.push(`${at}: must not match the "not" schema`);
  return errs.slice(0, 50);
}

// ---------- snapshots ----------

/**
 * The value stored and compared for a snapshot: ignored paths removed (`[*]` allowed),
 * sensitive keys redacted, and in "shape" mode every leaf replaced by its type.
 */
export function snapshotValue(value: unknown, ignore: string[], mode: "values" | "shape"): unknown {
  const copy = value === undefined ? null : JSON.parse(JSON.stringify(value));
  for (const p of ignore) for (const concrete of expandWildcards(copy, p).reverse()) deletePath(copy, concrete);
  const walk = (v: unknown, key: string, depth: number): unknown => {
    if (depth > MAX_DEPTH) return "[too deep]";
    if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
    if (Array.isArray(v)) return v.map((x) => walk(x, "", depth + 1));
    if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk(v[k], k, depth + 1)]));
    return mode === "shape" ? typeOf(v) : v;
  };
  return walk(copy, "", 0);
}

/** Differences between a stored snapshot and the current value, as JSON paths. */
export function diffValues(expected: unknown, actual: unknown, at = "$", out: string[] = [], depth = 0): string[] {
  if (out.length >= 20 || depth > MAX_DEPTH) return out;
  if (isObj(expected) && isObj(actual)) {
    for (const k of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (!Object.hasOwn(actual, k)) out.push(`${at}.${k}: missing (was ${show(expected[k], k)})`);
      else if (!Object.hasOwn(expected, k)) out.push(`${at}.${k}: new property (${show(actual[k], k)})`);
      else diffValues(expected[k], actual[k], `${at}.${k}`, out, depth + 1);
    }
  } else if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) out.push(`${at}: ${expected.length} item(s) before, ${actual.length} now`);
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) diffValues(expected[i], actual[i], `${at}[${i}]`, out, depth + 1);
  } else if (!isDeepStrictEqual(expected, actual)) out.push(`${at}: was ${show(expected, at)}, now ${show(actual, at)}`);
  return out;
}
