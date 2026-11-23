/**
 * Test-only API with deliberately vulnerable and safe twins, used by
 * test/injection-probes.test.ts. SQL routes run real PostgreSQL (PGlite) queries; NoSQL
 * routes evaluate MongoDB-style operator objects ($ne, $gt, $regex, $exists) the way an
 * unvalidated `Model.findOne(req.body)` would. Never deploy this.
 */
import express from "express";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  CREATE TABLE users (email TEXT, password TEXT);
  INSERT INTO users VALUES ('ali@shop.test', 'Correct-Horse-1');
  CREATE TABLE products (name TEXT);
  INSERT INTO products VALUES ('coffee'), ('tea'), ('juice');
  CREATE TABLE one_row (name TEXT);
  INSERT INTO one_row VALUES ('only');
`);

const users = [{ email: "ali@shop.test", password: "Correct-Horse-1" }];
const products = [{ name: "coffee" }, { name: "tea" }, { name: "juice" }];

/** MongoDB-like matching of one field against a value or an operator object. */
function matches(actual: unknown, cond: unknown): boolean {
  if (cond && typeof cond === "object" && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      if (op === "$ne") return actual !== v && !(v === "" && actual === undefined);
      if (op === "$gt") return typeof actual === typeof v && (actual as never) > (v as never);
      if (op === "$regex") return typeof actual === "string" && new RegExp(String(v)).test(actual);
      if (op === "$exists") return (actual !== undefined) === (v === true || v === "true");
      return false;
    });
  }
  return actual === cond;
}
const findOne = <T extends Record<string, unknown>>(rows: T[], filter: Record<string, unknown>) => rows.find((r) => Object.entries(filter).every(([k, c]) => matches(r[k], c)));

const app = express();
app.use(express.json());

// NoSQL
app.post("/nosql/login-vulnerable", (req, res) => {
  const u = findOne(users, { email: req.body.email, password: req.body.password });
  return u ? res.json({ success: true, data: { accessToken: "tok-" + u.email } }) : res.status(401).json({ success: false });
});
app.post("/nosql/login-safe", (req, res) => {
  const u = findOne(users, { email: String(req.body.email), password: String(req.body.password) });
  return u ? res.json({ success: true, data: { accessToken: "tok" } }) : res.status(401).json({ success: false });
});
app.post("/nosql/login-crash", (req, res) => {
  if (typeof req.body.email !== "string") return res.status(500).json({ success: false, message: "Internal error" });
  return res.status(401).json({ success: false });
});
app.get("/nosql/search-vulnerable", (req, res) => res.json({ data: products.filter((p) => matches(p.name, req.query.q)) }));

// SQL (string-built queries are the vulnerability)
app.post("/sql/login-vulnerable", async (req, res) => {
  try {
    const r = await db.query(`SELECT email FROM users WHERE email = '${req.body.email}' AND password = '${req.body.password}'`);
    return r.rows.length ? res.json({ success: true, data: { accessToken: "tok" } }) : res.status(401).json({ success: false });
  } catch { return res.status(401).json({ success: false }); }
});
app.get("/sql/search-vulnerable", async (req, res) => {
  try { return res.json({ data: (await db.query(`SELECT name FROM products WHERE name = '${req.query.q}'`)).rows }); }
  catch { return res.status(400).json({ data: [] }); }
});
app.get("/sql/search-errors", async (req, res) => {
  try { await db.query(`SELECT name FROM products WHERE name = '${req.query.q}' AND 1 = 0`); return res.json({ data: [] }); }
  catch (e) { return res.status(500).json({ error: (e as Error).message }); }
});
app.get("/sql/search-blind", async (req, res) => {
  try { await db.query(`SELECT name FROM one_row WHERE name = '${req.query.q}'`); } catch { /* hidden */ }
  return res.json({ data: [] });
});
app.get("/sql/search-safe", async (req, res) => {
  try { return res.json({ data: (await db.query("SELECT name FROM products WHERE name = $1", [String(req.query.q)])).rows }); }
  catch { return res.status(400).json({ data: [] }); }
});
// Traps for false positives: answers that change without any injection.
let flip = 0;
app.post("/nosql/flaky", (_req, res) => (flip++ % 2 === 1 ? res.json({ success: true, data: { accessToken: "tok" } }) : res.status(401).json({ success: false })));
app.get("/sql/quote-wildcard", (req, res) => res.json({ data: String(req.query.q).includes("'") || String(req.query.q).includes('"') ? products : products.filter((p) => p.name === req.query.q) }));
app.get("/sql/count", async (_req, res) => res.json({ users: (await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM users")).rows[0].n, products: (await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM products")).rows[0].n }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 4051);
app.listen(port, "127.0.0.1");
