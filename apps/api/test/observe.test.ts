/**
 * Request ids, request logs and /metrics.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, signup, type TestApi } from "./helpers.js";

const TOKEN = "metrics-token-0123456789abcdef";
let api: TestApi;
const lines: string[] = [];
const realLog = console.log;

before(async () => {
  api = await startApi({ METRICS_TOKEN: TOKEN, LOG_FORMAT: "json" });
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
});
after(async () => {
  console.log = realLog;
  await api.close();
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${api.url}${path}`, { headers });

test("every response carries a request id; a safe incoming one is kept", async () => {
  const a = await get("/health");
  assert.match(a.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
  const b = await get("/api/v1/auth/options", { "x-request-id": "edge-abc-123456" });
  assert.equal(b.headers.get("x-request-id"), "edge-abc-123456");
  const c = await get("/api/v1/auth/options", { "x-request-id": "bad id with spaces <script>" });
  assert.notEqual(c.headers.get("x-request-id"), "bad id with spaces <script>");
});

test("request logs are JSON lines with the route template, no emails or tokens", async () => {
  const u = await signup(api, "logs");
  await api.call("GET", `/orgs/${u.orgId}/projects`, { token: u.token });
  await new Promise((r) => setTimeout(r, 50));
  const recs = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const list = recs.find((r) => r.route === "/api/v1/orgs/:orgId/projects" && r.method === "GET");
  assert.ok(list, JSON.stringify(recs.slice(-3)));
  assert.equal(list.status, 200);
  assert.equal(list.orgId, u.orgId);
  assert.equal(typeof list.ms, "number");
  assert.match(list.requestId, /^[0-9a-f-]{36}$/);
  const all = lines.join("\n");
  assert.equal(all.includes(u.email), false, "no email addresses in logs");
  assert.equal(all.includes(u.token), false, "no tokens in logs");
  assert.equal(recs.some((r) => r.route === "/health"), false, "health checks aren't logged");
});

test("/metrics needs the token and reports requests, durations and platform counts", async () => {
  assert.equal((await get("/metrics")).status, 401);
  assert.equal((await get("/metrics", { authorization: "Bearer wrong-token-0123456789abc" })).status, 401);
  const r = await get("/metrics", { authorization: `Bearer ${TOKEN}` });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /qa_http_requests_total\{method="GET",route="\/api\/v1\/orgs\/:orgId\/projects",status="200"\} \d+/);
  assert.match(text, /qa_http_request_duration_seconds_bucket\{method="GET",route="\/api\/v1\/orgs\/:orgId\/projects",le="\+Inf"\} \d+/);
  assert.match(text, /qa_users \d+/);
  assert.match(text, /qa_db_up 1/);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), false, "no ids in metric labels");
});

test("/metrics is off without METRICS_TOKEN", async () => {
  const off = await startApi();
  try {
    assert.equal((await fetch(`${off.url}/metrics`)).status, 404);
  } finally {
    await off.close();
  }
});
