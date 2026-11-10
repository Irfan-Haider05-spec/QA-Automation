/**
 * Environments and domain-ownership verification.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, signup, addMember, type TestApi } from "./helpers.js";

let api: TestApi;
let o: Awaited<ReturnType<typeof signup>>;
let projectId: string;
let target: http.Server;
let targetUrl: string;
let served = "";

before(async () => {
  api = await startApi();
  o = await signup(api, "env");
  projectId = (await api.call("POST", `/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Web" } })).body.project.id;
  // A stand-in for the customer's staging server
  target = http.createServer((req, res) => {
    if (req.url === "/.well-known/qa-verification.txt" && served) { res.end(served); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
});
after(async () => { await api.close(); target.close(); });

const envPath = () => `/orgs/${o.orgId}/projects/${projectId}/environments`;

test("verify via /.well-known file; wrong content is rejected", async () => {
  const e = await api.call("POST", envPath(), { token: o.token, body: { name: "staging", apiBaseUrl: `${targetUrl}/api`, webApps: [{ name: "admin", baseUrl: `${targetUrl}/admin` }] } });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  const id = e.body.environment.id;
  const ins = await api.call("GET", `${envPath()}/${id}/verification`, { token: o.token });
  assert.equal(ins.body.verified, false);
  served = "wrong-token";
  const fail = await api.call("POST", `${envPath()}/${id}/verify`, { token: o.token });
  assert.equal(fail.status, 422);
  served = ins.body.instructions.file.content;
  const ok = await api.call("POST", `${envPath()}/${id}/verify`, { token: o.token });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.method, "file");
  // Changing the host resets verification
  const moved = await api.call("PATCH", `${envPath()}/${id}`, { token: o.token, body: { apiBaseUrl: "https://elsewhere.example.com", webApps: [] } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.environment.verifiedAt, null);
});

test("http verification is refused unless explicitly allowed", async () => {
  const strict = await startApi({ ALLOW_HTTP_VERIFICATION: "false" });
  try {
    const u = await signup(strict, "strict");
    const p = (await strict.call("POST", `/orgs/${u.orgId}/projects`, { token: u.token, body: { name: "P" } })).body.project.id;
    const e = (await strict.call("POST", `/orgs/${u.orgId}/projects/${p}/environments`, { token: u.token, body: { name: "s", apiBaseUrl: targetUrl } })).body.environment;
    served = e ? "" : "";
    const ins = await strict.call("GET", `/orgs/${u.orgId}/projects/${p}/environments/${e.id}/verification`, { token: u.token });
    served = ins.body.instructions.file.content;
    const r = await strict.call("POST", `/orgs/${u.orgId}/projects/${p}/environments/${e.id}/verify`, { token: u.token });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /https/);
  } finally {
    await strict.close();
  }
});

test("one host per environment; only admins mark environments disposable", async () => {
  const two = await api.call("POST", envPath(), { token: o.token, body: { name: "mixed", apiBaseUrl: "https://a.example.com", webApps: [{ name: "w", baseUrl: "https://b.example.com" }] } });
  assert.equal(two.status, 400);
  assert.equal(two.body.error.code, "multiple_domains");
  const d = await addMember(api, o, "developer");
  assert.equal((await api.call("POST", envPath(), { token: d.token, body: { name: "pr-db", apiBaseUrl: "https://pr.example.com", disposable: true } })).status, 403);
  assert.equal((await api.call("POST", envPath(), { token: d.token, body: { name: "pr-db", apiBaseUrl: "https://pr.example.com" } })).status, 201);
  assert.equal((await api.call("POST", envPath(), { token: o.token, body: { name: "ci", apiBaseUrl: "https://ci.example.com", disposable: true } })).status, 201);
});
