import fs from "node:fs";
import path from "node:path";
import { MongoClient, type Document } from "mongodb";
import { z } from "zod";
import type { RunContext } from "../../core/context.js";
import { SkipError, type Finding } from "../../core/types.js";
import { discoverMongoose, indexProblems, uncoveredBranches, type Direction, type IndexDef, type ModelDef, type QueryUse } from "../../discovery/mongoose-models.js";
import { checkedPlugin, issue } from "./support.js";

/**
 * MongoDB index and query check.
 *
 * Static (no database): Mongoose models, their declared indexes and the queries in the
 * backend source; a query whose filter fields start no index is reported.
 * Live (optional, read-only): the real indexes, `explain("queryPlanner")` of the same
 * query shapes with placeholder values, `$indexStats` usage, and full collection scans
 * already recorded by the database profiler. VeriQ never writes, never enables the
 * profiler and never reads document values; profiler filters are reduced to field names.
 */

const keySpec = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.$]+(:(-1|1|text|2dsphere|2d|hashed))?$/, "Use field or field:-1");
export const mongoIndexesSchema = z.object({
  static: z.boolean().default(true),
  knownIndexes: z.array(z.object({ model: z.string().min(1).max(200), keys: z.array(keySpec).min(1).max(32), unique: z.boolean().default(false) }).strict()).max(500).default([]),
  ignoreModels: z.array(z.string().min(1).max(200)).max(500).default([]),
  live: z.object({
    uriEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "Name of an environment variable, e.g. QA_MONGO_URI").default("QA_MONGO_URI"),
    database: z.string().min(1).max(64).optional(),
    maxCollections: z.number().int().min(1).max(2000).default(200),
    profiler: z.boolean().default(true),
    minDocsExamined: z.number().int().min(1).default(1000),
    unusedAfterDays: z.number().int().min(1).max(365).default(7),
    timeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
  }).strict().optional(),
}).strict().refine((c) => c.static || c.live, "Enable static analysis, live checks, or both");
type Config = z.output<typeof mongoIndexesSchema>;

const LOCATIONS = 10;
const PROBE = "__veriq_probe__";

// Mongoose's default collection naming (lower case, English plural).
const UNCOUNTABLE = new Set(["advice", "energy", "excretion", "digestion", "cooperation", "health", "justice", "labour", "machinery", "equipment", "information", "pollution", "sewage", "paper", "money", "species", "series", "rain", "rice", "fish", "sheep", "moose", "deer", "news", "expertise", "status", "media"]);
const PLURAL_RULES: [RegExp, string][] = [
  [/(m)an$/i, "$1en"], [/(pe)rson$/i, "$1ople"], [/(child)$/i, "$1ren"], [/^(ox)$/i, "$1en"], [/(ax|test)is$/i, "$1es"],
  [/(octop|vir)us$/i, "$1i"], [/(alias|status|canvas)$/i, "$1es"], [/(bu)s$/i, "$1ses"], [/(buffal|tomat|potat)o$/i, "$1oes"],
  [/([ti])um$/i, "$1a"], [/sis$/i, "ses"], [/(?:([^f])fe|([lr])f)$/i, "$1$2ves"], [/(hive)$/i, "$1s"], [/([^aeiouy]|qu)y$/i, "$1ies"],
  [/(x|ch|ss|sh)$/i, "$1es"], [/(matr|vert|ind)ix|ex$/i, "$1ices"], [/([ml])ouse$/i, "$1ice"], [/(kn|w|l)ife$/i, "$1ives"],
  [/(quiz)$/i, "$1zes"], [/s$/i, "s"], [/([^a-z])$/i, "$1"], [/$/, "s"],
];
export function mongooseCollectionName(model: string): string {
  const s = model.toLowerCase();
  if (UNCOUNTABLE.has(s)) return s;
  const rule = PLURAL_RULES.find(([re]) => re.test(s));
  return rule ? s.replace(rule[0], rule[1]) : s;
}

const parseKey = (k: string): IndexDef["keys"][number] => {
  const [field, dir] = k.split(":");
  return { field, dir: (dir === undefined ? 1 : dir === "-1" ? -1 : dir === "1" ? 1 : dir) as Direction };
};

/** listIndexes documents as index definitions. */
export function liveIndexDefs(docs: Document[]): (IndexDef & { name: string; ttl: boolean })[] {
  return docs.filter((d) => d && typeof d.key === "object").map((d) => ({
    name: String(d.name),
    keys: Object.entries(d.key as Record<string, unknown>).map(([field, v]) => ({ field, dir: (v === -1 ? -1 : typeof v === "string" ? v : 1) as Direction })),
    unique: d.unique === true, sparse: d.sparse === true, partial: !!d.partialFilterExpression, ttl: typeof d.expireAfterSeconds === "number",
    source: `index ${String(d.name)}`,
  }));
}

/** Does the winning plan read the whole collection? Classic and slot-based (SBE) plan shapes. */
export function planUsesCollscan(explain: Document): boolean {
  const qp = explain?.queryPlanner ?? explain?.stages?.[0]?.$cursor?.queryPlanner;
  const plan = qp?.winningPlan?.queryPlan ?? qp?.winningPlan;
  if (!plan) throw new Error("Explain output has no winning plan");
  const walk = (n: unknown, depth: number): boolean => {
    if (!n || typeof n !== "object" || depth > 50) return false;
    const o = n as Record<string, unknown>;
    if (o.stage === "COLLSCAN") return true;
    return ["inputStage", "inputStages", "outerStage", "innerStage", "queryPlan"].some((k) =>
      Array.isArray(o[k]) ? (o[k] as unknown[]).some((x) => walk(x, depth + 1)) : walk(o[k], depth + 1));
  };
  return walk(plan, 0);
}

/** Indexes with no recorded use, observed for at least `days`. _id, unique and TTL indexes enforce behaviour and are never reported. */
export function unusedIndexes(stats: Document[], indexes: ReturnType<typeof liveIndexDefs>, nowMs: number, days: number) {
  const byName = new Map(indexes.map((i) => [i.name, i]));
  return stats.flatMap((s) => {
    const idx = byName.get(String(s.name));
    const since = s.accesses?.since ? new Date(s.accesses.since).getTime() : NaN;
    const ops = Number(s.accesses?.ops ?? NaN);
    if (!idx || idx.name === "_id_" || idx.unique || idx.ttl || !Number.isFinite(since) || ops !== 0) return [];
    return nowMs - since >= days * 86_400_000 ? [{ name: idx.name, since: new Date(since).toISOString() }] : [];
  });
}

/** Field names in a filter (values dropped), per $or branch. */
export function filterKeys(filter: unknown, depth = 0): string[][] {
  if (!filter || typeof filter !== "object" || Array.isArray(filter) || depth > 10) return [[]];
  const base: string[] = [];
  let branches: string[][] = [[]];
  for (const [k, v] of Object.entries(filter as Record<string, unknown>)) {
    if (!k.startsWith("$")) { base.push(k); continue; }
    if ((k === "$or" || k === "$and") && Array.isArray(v)) {
      const parts = v.map((x) => filterKeys(x, depth + 1));
      branches = k === "$or" ? branches.flatMap((b) => parts.flat().map((x) => [...b, ...x])) : parts.reduce((acc, p) => acc.flatMap((b) => p.map((x) => [...b, ...x])), branches);
      branches = branches.slice(0, 64);
    }
  }
  return branches.map((b) => [...new Set([...base, ...b])].sort());
}

/** Full collection scans already recorded by the profiler, grouped by collection, operation and filter fields. */
export function profilerShapes(entries: Document[], minDocsExamined: number) {
  const groups = new Map<string, { ns: string; op: string; keys: string[]; count: number; maxDocs: number; maxMs: number }>();
  for (const e of entries) {
    if (e?.planSummary !== "COLLSCAN" || Number(e.docsExamined) < minDocsExamined) continue;
    const c = e.command ?? {};
    const filter = c.filter ?? c.q ?? c.query ?? (Array.isArray(c.pipeline) ? c.pipeline[0]?.$match : undefined) ?? (Array.isArray(c.updates) ? c.updates[0]?.q : undefined) ?? (Array.isArray(c.deletes) ? c.deletes[0]?.q : undefined);
    const keys = [...new Set(filterKeys(filter).flat())].sort();
    const op = String(e.op ?? "query");
    const id = `${e.ns}|${op}|${keys.join(",")}`;
    const g = groups.get(id) ?? { ns: String(e.ns), op, keys, count: 0, maxDocs: 0, maxMs: 0 };
    g.count++; g.maxDocs = Math.max(g.maxDocs, Number(e.docsExamined) || 0); g.maxMs = Math.max(g.maxMs, Number(e.millis) || 0);
    groups.set(id, g);
  }
  return [...groups.values()].sort((a, b) => b.maxDocs - a.maxDocs);
}

/** The query shape with placeholder values, for explain. */
export function probeQuery(q: QueryUse): { filter: Document; sort?: Document } {
  const branch = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, PROBE]));
  const nonEmpty = q.branches.filter((b) => b.length);
  const filter = nonEmpty.length === 0 ? {} : nonEmpty.length === 1 ? branch(nonEmpty[0]) : { $or: nonEmpty.map(branch) };
  return { filter, ...(q.sort.length ? { sort: Object.fromEntries(q.sort.map((k) => [k, 1])) } : {}) };
}

/** Never let a connection string (or its password) reach a report or log. */
export const scrubMongoError = (msg: string) => msg.replace(/mongodb(\+srv)?:\/\/[^\s]+/gi, "mongodb://[redacted]").replace(/\/\/[^/\s:@]+:[^@\s]+@/g, "//[redacted]@").slice(0, 300);

const indexText = (i: Pick<IndexDef, "keys">) => `{ ${i.keys.map((k) => `${k.field}: ${typeof k.dir === "string" ? `"${k.dir}"` : k.dir}`).join(", ")} }`;
const shapeText = (keys: string[]) => (keys.length ? `{ ${keys.join(", ")} }` : "{ } (sort only)");

interface Group { model: string; collection?: string; keys: string[]; sort: string[]; locations: string[]; methods: Set<string> }
function groupQueries(items: { q: QueryUse; branch: string[] }[]) {
  const groups = new Map<string, Group>();
  for (const { q, branch } of items) {
    const keys = [...branch].sort();
    const id = `${q.model}|${keys.join(",")}|${branch.length ? "" : q.sort[0] ?? ""}`;
    const g = groups.get(id) ?? { model: q.model, keys, sort: branch.length ? [] : q.sort, locations: [], methods: new Set<string>() };
    g.locations.push(q.source); g.methods.add(q.method);
    groups.set(id, g);
  }
  return [...groups.values()].sort((a, b) => b.locations.length - a.locations.length || a.model.localeCompare(b.model));
}

/** Each query shape is its own problem: the model alone would merge every shape of a model into one finding. */
const groupTarget = (g: Group) => `${g.model} ${shapeText(g.keys)}${g.sort.length ? ` sorted by ${g.sort.join(", ")}` : ""}`;
const describeGroup = (g: Group) => `${g.model}.${[...g.methods].sort().join("/")} filters on ${shapeText(g.keys)}${g.sort.length ? ` sorted by ${g.sort.join(", ")}` : ""} in ${g.locations.length} place(s):\n${g.locations.slice(0, LOCATIONS).join("\n")}${g.locations.length > LOCATIONS ? `\n…and ${g.locations.length - LOCATIONS} more` : ""}`;
const suggestion = (g: Group) => `Add an index that starts with the most selective equality field, e.g. schema.index({ ${(g.keys.length ? g.keys : g.sort).map((k) => `${k}: 1`).join(", ")} }), or record an index created elsewhere in knownIndexes.`;

export async function mongoIndexes(ctx: RunContext, c: Config) {
  const findings: Finding[] = [];
  const stats: Record<string, number | string> = {};
  const report: Record<string, unknown> = {};
  let models: ModelDef[] = [];
  let queries: QueryUse[] = [];
  // Indexes as declared in the models; live mode replaces model.indexes with the real ones.
  const declared = new Map<string, IndexDef[]>();
  const confirmedMissing = new Set<IndexDef>();

  if (c.static) {
    if (ctx.config.backend.none) throw new SkipError("No backend source to analyse (backend: false); use live checks only with static: false");
    const d = discoverMongoose(ctx.config.backend.dir);
    const ignored = new Set(c.ignoreModels);
    models = d.models.filter((m) => !ignored.has(m.name));
    queries = d.queries.filter((q) => !ignored.has(q.model));
    for (const k of c.knownIndexes) {
      const m = models.find((x) => x.name === k.model);
      if (!m) throw new Error(`knownIndexes names model ${k.model}, which was not found in the backend`);
      m.indexes.push({ keys: k.keys.map(parseKey), unique: k.unique, sparse: false, partial: false, source: "knownIndexes" });
    }
    for (const m of models) declared.set(m.name, [...m.indexes]);
    Object.assign(stats, { sourceFiles: d.files, models: models.length, queriesAnalysed: queries.length, dynamicQueries: d.skipped.dynamic, unfilteredQueries: d.skipped.unfiltered, textQueries: d.skipped.text });
    report.warnings = d.warnings.slice(0, 200);
    if (!models.length && !c.live) throw new SkipError(`No Mongoose models found in ${d.files} source file(s)`);
  }

  // Live: real indexes per collection, replacing declared ones where the collection is found.
  const liveCollections = new Set<string>();
  if (c.live) {
    const uri = process.env[c.live.uriEnv];
    if (!uri) throw new Error(`Live MongoDB checks need ${c.live.uriEnv} (a read-only connection string) in the environment`);
    if (!/^mongodb(\+srv)?:\/\//.test(uri)) throw new Error(`${c.live.uriEnv} is not a MongoDB connection string`);
    const client = new MongoClient(uri, { appName: "veriq-qa", serverSelectionTimeoutMS: c.live.timeoutMs, connectTimeoutMS: c.live.timeoutMs, socketTimeoutMS: c.live.timeoutMs * 2, maxPoolSize: 2, retryWrites: false });
    try {
      try { await client.connect(); } catch (e) { throw new Error(`Cannot connect to MongoDB: ${scrubMongoError((e as Error).message)}`); }
      const db = client.db(c.live.database);
      const names = (await db.listCollections({ type: "collection" }, { nameOnly: true, authorizedCollections: true }).toArray())
        .map((x) => String(x.name)).filter((n) => !n.startsWith("system.")).sort();
      if (names.length > c.live.maxCollections) stats.collectionsNotChecked = names.length - c.live.maxCollections;
      const checked = names.slice(0, c.live.maxCollections);
      const byCollection = new Map(models.map((m) => [m.collection ?? mongooseCollectionName(m.name), m]));
      let unusedChecked = 0, unusedDenied = 0, explained = 0;
      const now = Date.now();
      const liveFindings: { unused: string[]; duplicate: string[]; redundant: string[] } = { unused: [], duplicate: [], redundant: [] };
      const missing: { model: string; collection: string; index: IndexDef }[] = [];
      for (const name of checked) {
        const coll = db.collection(name);
        const indexes = liveIndexDefs(await coll.listIndexes().toArray());
        liveCollections.add(name);
        const model = byCollection.get(name);
        if (model) {
          // A declared index that is not in the database was never built: Mongoose only logs a
          // failed build (unsupported options, duplicate values under a unique key, autoIndex off).
          const present = new Set(indexes.map((i) => indexText(i)));
          const hasText = indexes.some((i) => i.keys.some((k) => k.field === "_fts"));
          for (const want of declared.get(model.name) ?? []) {
            if (want.source === "knownIndexes" || present.has(indexText(want))) continue;
            if (want.keys.some((k) => k.dir === "text") && hasText) continue;
            if (want.unbuildable) confirmedMissing.add(want);
            else missing.push({ model: model.name, collection: name, index: want });
          }
          model.indexes = indexes;
        }
        const problems = indexProblems(indexes.filter((i) => i.name !== "_id_"));
        for (const [a, b] of problems.redundant) liveFindings.redundant.push(`${name}: ${indexText(a)} (${(a as { name?: string }).name}) is a prefix of ${indexText(b)} (${(b as { name?: string }).name})`);
        try {
          const usage = await coll.aggregate([{ $indexStats: {} }]).toArray();
          unusedChecked++;
          for (const u of unusedIndexes(usage, indexes, now, c.live.unusedAfterDays)) liveFindings.unused.push(`${name}: ${u.name} (no use recorded since ${u.since})`);
        } catch { unusedDenied++; }
        if (model) {
          const mine = queries.filter((q) => q.model === model.name);
          for (const q of mine) {
            const probe = probeQuery(q);
            let cursor = coll.find(probe.filter, { maxTimeMS: c.live.timeoutMs });
            if (probe.sort) cursor = cursor.sort(probe.sort);
            let collscan: boolean;
            try { collscan = planUsesCollscan(await cursor.explain("queryPlanner")); explained++; }
            catch (e) { throw new Error(`explain failed on ${name}: ${scrubMongoError((e as Error).message)}`); }
            (q as QueryUse & { collscan?: boolean }).collscan = collscan;
          }
        }
      }
      Object.assign(stats, { collections: checked.length, explained, indexStatsCollections: unusedChecked, indexStatsDenied: unusedDenied, declaredMissing: missing.length + confirmedMissing.size });
      for (const { model, collection, index } of missing) {
        const target = `${model} ${indexText(index)}`;
        findings.push({ ...issue("mongo-indexes", "Declared index is missing from the database", target,
          `${indexText(index)}${index.unique ? " (unique)" : ""}, declared at ${index.source}, is not among the indexes of ${collection}. Mongoose logs a failed index build and carries on, so queries${index.unique ? " and the unique rule" : ""} rely on an index that does not exist.`,
          index.unique ? "high" : "medium", "quality"), key: target, confidence: "high",
          remediation: index.unique ? "Find duplicate values first, then build the index (Model.syncIndexes() or createIndex) and check the result." : "Build the index (Model.syncIndexes() or createIndex) and check the server log for a build error." });
      }
      if (liveFindings.unused.length) findings.push(issue("mongo-indexes", "Indexes with no recorded use", "database", `${liveFindings.unused.length} index(es):\n${liveFindings.unused.slice(0, 30).join("\n")}\nUsage counters reset when a server restarts; confirm on every node before dropping.`, "low", "quality"));
      if (liveFindings.redundant.length) findings.push(issue("mongo-indexes", "Redundant indexes in the database", "database", liveFindings.redundant.slice(0, 30).join("\n"), "low", "quality"));

      if (c.live.profiler) {
        const exists = (await db.listCollections({ name: "system.profile" }, { nameOnly: true }).toArray()).length > 0;
        if (!exists) stats.profiler = "not enabled";
        else {
          const entries = await db.collection("system.profile").find({ planSummary: "COLLSCAN", docsExamined: { $gte: c.live.minDocsExamined } },
            { projection: { ns: 1, op: 1, command: 1, docsExamined: 1, millis: 1, planSummary: 1 }, sort: { ts: -1 }, limit: 1000, maxTimeMS: c.live.timeoutMs }).toArray();
          const shapes = profilerShapes(entries, c.live.minDocsExamined);
          stats.profilerScans = shapes.length;
          report.profiler = shapes;
          for (const s of shapes.slice(0, 20)) {
            findings.push({ ...issue("mongo-indexes", "Full collection scans recorded by the profiler", `${s.ns} ${s.op} ${shapeText(s.keys)}`,
              `${s.count} ${s.op} operation(s) filtering on ${shapeText(s.keys)} read up to ${s.maxDocs} documents (slowest ${s.maxMs} ms) without an index.`, "medium", "quality"),
              key: `${s.ns} ${s.op} ${shapeText(s.keys)}`, remediation: `Add an index on ${s.ns.split(".").slice(1).join(".")} that starts with one of ${s.keys.join(", ") || "the filtered fields"}.` });
          }
        }
      }
    } finally { await client.close().catch(() => undefined); }
  }

  // Query coverage: explained shapes where the collection was found live, declared indexes otherwise.
  if (c.static) {
    const uncovered: { q: QueryUse; branch: string[] }[] = [], scanning: { q: QueryUse; branch: string[] }[] = [];
    for (const q of queries) {
      const model = models.find((m) => m.name === q.model);
      if (!model) continue;
      const coll = model.collection ?? mongooseCollectionName(model.name);
      const live = (q as QueryUse & { collscan?: boolean }).collscan;
      if (liveCollections.has(coll) && live !== undefined) { if (live) for (const b of q.branches) scanning.push({ q, branch: b }); }
      else for (const b of uncoveredBranches(q, model.indexes)) uncovered.push({ q, branch: b });
    }
    for (const g of groupQueries(scanning)) findings.push({ ...issue("mongo-indexes", "Query plan scans the whole collection", groupTarget(g), describeGroup(g), "medium", "quality"), key: groupTarget(g), confidence: "high", remediation: suggestion(g) });
    for (const g of groupQueries(uncovered)) findings.push({ ...issue("mongo-indexes", "Query has no supporting index", groupTarget(g), describeGroup(g), "medium", "quality"), key: groupTarget(g), confidence: "medium", remediation: suggestion(g) });
    for (const m of models) for (const index of (declared.get(m.name) ?? []).filter((i) => i.unbuildable)) {
      const target = `${m.name} ${indexText(index)}`;
      findings.push({ ...issue("mongo-indexes", "Index can never be built", target,
        `${indexText(index)}${index.unique ? " (unique)" : ""} at ${index.source}: ${index.unbuildable}. MongoDB refuses to build it ("Expression not supported in partial index") and Mongoose only logs that, so the index does not exist${index.unique ? " and duplicate values are not prevented" : ""}; queries on it scan the collection.${confirmedMissing.has(index) ? " Confirmed: it is not in the live database." : ""}`,
        index.unique ? "high" : "medium", "quality"), key: target, confidence: "high",
        remediation: "Use only supported operators in partialFilterExpression: for \"present and not null\" use { field: { $type: \"string\" } } (or the field's type), or $exists: true. Check existing data for duplicates before building a unique index." });
    }
    for (const m of models) {
      if (c.live && liveCollections.has(m.collection ?? mongooseCollectionName(m.name))) continue; // live duplicates are not possible; redundancy already reported
      const p = indexProblems(m.indexes);
      for (const [a, b] of p.duplicates) findings.push({ ...issue("mongo-indexes", "Index declared twice", `${m.name} ${indexText(a)}`, `${indexText(a)} at ${a.source} repeats ${b.source}. Mongoose warns and builds one index; remove one declaration.`, "low", "quality"), key: `${m.name} ${indexText(a)}` });
      for (const [a, b] of p.redundant) findings.push({ ...issue("mongo-indexes", "Redundant index", `${m.name} ${indexText(a)}`, `${indexText(a)} at ${a.source} is a prefix of ${indexText(b)} at ${b.source}; the wider index serves the same queries.`, "low", "quality"), key: `${m.name} ${indexText(a)} < ${indexText(b)}` });
    }
    stats.unindexedShapes = groupQueries(uncovered).length + groupQueries(scanning).length;
    report.models = models.map((m) => ({ name: m.name, collection: m.collection ?? mongooseCollectionName(m.name), live: liveCollections.has(m.collection ?? mongooseCollectionName(m.name)), indexes: m.indexes.map((i) => ({ keys: indexText(i), unique: i.unique, source: i.source })) }));
  }

  fs.mkdirSync(ctx.outDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.outDir, "mongo-indexes.json"), JSON.stringify({ stats, ...report }, null, 2));
  return { findings, stats };
}

export const mongoIndexesPlugin = checkedPlugin("mongo-indexes", "static", "Mongoose queries without a supporting index, duplicate and redundant indexes; optionally the real database's plans, unused indexes and profiler scans (read-only)",
  mongoIndexesSchema, (ctx, c) => mongoIndexes(ctx, c));
