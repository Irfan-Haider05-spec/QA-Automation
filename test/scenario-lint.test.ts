/**
 * scenario-lint: API scenario files checked against the backend's discovered routes, without
 * a target. Uses the fixture backend's real route discovery and its zod-derived OpenAPI.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import type { Finding, RouteInfo } from '../src/core/types.js';
import { discoverRoutes } from '../src/discovery/express-routes.js';
import { buildOpenApi } from '../src/discovery/openapi.js';
import { lintScenarios, matchRoute, scenarioLintPlugin, bodySchemasFrom } from '../src/plugins/expanded/scenario-lint.js';
import { loadScenarios } from '../src/plugins/expanded/api-scenarios.js';

let routes: RouteInfo[];
let openapi: string;
let dir: string;
let base: RunContext;
const accounts = { merchantA: 'MERCHANT', merchantB: 'MERCHANT', customer: 'USER', admin: 'SUPER_ADMIN' };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-lint-'));
  const { config } = await loadConfig('test/fixture.config.ts', {});
  routes = discoverRoutes({ backendDir: config.backend.dir, routesIndex: config.backend.routesIndex, apiPrefix: config.backend.apiPrefix, appFile: config.backend.appFile }).routes;
  openapi = (await buildOpenApi(routes, { title: 'fixture', outFile: path.join(dir, 'openapi.json') })).file;
  base = { config, configDir: dir, outDir: dir, suite: 'pr', routes, targetRoutes: routes, selectedPlugins: [], changedFiles: null, updateVisual: false, openapiPath: openapi, log: { info() {}, warn() {}, debug() {} } } as unknown as RunContext;
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name: string, text: string) => { fs.writeFileSync(path.join(dir, name), text); return name; };
const lint = (yaml: string) => {
  const file = write(`s${Math.random().toString(36).slice(2)}.yaml`, yaml);
  return lintScenarios(loadScenarios(dir, [file]), { routes, accounts, bodySchemas: bodySchemasFrom(openapi, routes) }).map((p) => `${p.step}: ${p.message}`);
};

test('Scenario paths are matched like Express matches them', () => {
  const m = (method: string, p: string) => { const r = matchRoute(method, p, routes); return r ? `${r.method} ${r.apiPath}` : undefined; };
  assert.equal(m('GET', '/api/v1/promotion/{{promoId}}'), 'GET /promotion/:id', 'a template fills a parameter');
  assert.equal(m('GET', '/promotion/{{promoId}}'), 'GET /promotion/:id', 'relative to the API prefix when the target URL ends with it');
  assert.equal(m('GET', '/api/v1/promotion/search?q=x'), 'GET /promotion/search', 'the literal route wins over /:id, query ignored');
  assert.equal(m('GET', '/api/v1/promotion/abc'), 'GET /promotion/:id');
  assert.equal(m('DELETE', '/api/v1/promotion/abc'), undefined, 'the method must exist too');
  assert.equal(m('GET', '/api/v1/promo{{x}}'), 'GET /promotion', 'a partial template matches what it could become');
  assert.equal(m('GET', '/api/v1/zz{{x}}'), undefined, 'and nothing it could not');
  assert.equal(m('GET', '/api/v1/promotion/{{a}}/{{b}}'), undefined, 'segment counts must agree');
});

test('A scenario that matches the backend has no problems', () => {
  assert.deepEqual(lint(`
version: 1
scenarios:
  - name: Lifecycle
    account: merchantA
    vars: { title: "QA {{unique}}" }
    steps:
      - request: { method: POST, path: /api/v1/promotion, json: { title: "{{title}}", discount: 15 } }
        expect: { status: 201, json: [{ path: $.data.title, equals: "{{title}}" }] }
        save: { promoId: $.data._id }
      - request: { method: GET, path: "/api/v1/promotion/{{promoId}}?from={{env.QA_FROM}}" }
      - account: merchantB
        request: { method: PATCH, path: "/api/v1/promotion/{{promoId}}", json: { title: hijack } }
        expect: { status: [403, 404] }
      - account: null
        request: { method: GET, path: /api/v1/promotion }
        expect: { status: 401 }
    cleanup:
      - request: { method: GET, path: "/api/v1/promotion/{{promoId}}" }
`), [], 'refusal expectations (403/404/401) are never questioned: that is how a missing check is caught live');
});

test('Problems a live run would show only as confusing failures are found statically', () => {
  assert.deepEqual(lint(`
version: 1
scenarios:
  - name: Broken
    account: merchantA
    steps:
      - name: wrong path
        request: { method: GET, path: /api/v1/promotions }
      - name: wrong method
        request: { method: DELETE, path: "/api/v1/promotion/{{id}}" }
      - name: anonymous success
        account: null
        request: { method: GET, path: /api/v1/promotion }
      - name: customer success on a merchant route
        account: customer
        request: { method: GET, path: /api/v1/promotion }
        expect: { status: [200] }
      - name: unknown account
        account: merchantC
        request: { method: GET, path: /api/v1/promotion }
      - name: body
        request: { method: POST, path: /api/v1/promotion, json: { discount: 15, colour: red } }
        save: { created: $.data._id }
      - name: later use is fine
        request: { method: GET, path: "/api/v1/promotion/{{created}}" }
`), [
    'step 1 "wrong path": calls GET /api/v1/promotions, which the backend does not define',
    'step 2 "wrong method": uses {{id}}, which no earlier step saves and the scenario\'s vars do not define',
    'step 2 "wrong method": calls DELETE /api/v1/promotion/{{id}}, which the backend does not define (that path exists for GET, PATCH)',
    'step 3 "anonymous success": expects success from GET /promotion without an account, but the route requires authentication (src/app/modules/promotion/promotion.routes.ts:7)',
    'step 4 "customer success on a merchant route": expects success as customer (role USER), but GET /promotion allows only MERCHANT (src/app/modules/promotion/promotion.routes.ts:7)',
    'step 5 "unknown account": uses account "merchantC", which is not in the configuration\'s accounts',
    'step 6 "body": sends a body without title, which the route\'s validation (PromotionValidation) requires',
  ]);
});

test('Variables: order matters in steps; cleanup may use anything a step saved', () => {
  assert.deepEqual(lint(`
version: 1
scenarios:
  - name: Order
    account: merchantA
    steps:
      - request: { method: GET, path: "/api/v1/promotion/{{later}}" }
      - request: { method: GET, path: /api/v1/promotion }
        save: { later: "$.data[0]._id" }
      - request: { method: GET, path: "/api/v1/promotion/{{now}}{{today}}{{uniqueDigits}}" }
        expect: { json: [{ path: $.data._id, equals: "{{nothing.here}}" }] }
    cleanup:
      - request: { method: GET, path: "/api/v1/promotion/{{later}}" }
`), [
    'step 1: uses {{later}}, which no earlier step saves and the scenario\'s vars do not define',
    'step 3: uses {{nothing.here}}, which no earlier step saves and the scenario\'s vars do not define',
  ]);
});

test('The check runs without a target, reports findings, and skips honestly when nothing was discovered', async () => {
  write('ok.yaml', 'version: 1\nscenarios:\n  - name: Fine\n    account: merchantA\n    steps:\n      - request: { method: GET, path: /api/v1/promotion }\n');
  write('bad.yaml', 'version: 1\nscenarios:\n  - name: Typo\n    account: merchantA\n    steps:\n      - request: { method: GET, path: /api/v1/promotions }\n');
  const config = structuredClone(base.config);
  config.pluginSettings = { 'api-scenarios': { files: ['ok.yaml', 'bad.yaml'] } };
  assert.equal(scenarioLintPlugin.usesTarget?.({ ...base, config }), false);
  const out = await scenarioLintPlugin.run({ ...base, config });
  const findings = (Array.isArray(out) ? out : out.findings) as Finding[];
  assert.deepEqual(findings.map((f) => [f.severity, f.title, f.target]), [['medium', 'Scenario does not match the backend', 'bad.yaml › Typo › step 1']]);
  assert.match(findings[0].detail!, /GET \/api\/v1\/promotions, which the backend does not define/);
  assert.deepEqual((out as any).stats, { scenarios: 2, steps: 2, routes: routes.length, problems: 1 });
  assert.equal(scenarioLintPlugin.skipReason?.({ ...base, config: { ...config, pluginSettings: {} } }), 'Configure pluginSettings["api-scenarios"] to enable this check');
  await assert.rejects(scenarioLintPlugin.run({ ...base, config, routes: [] }), /No backend routes were discovered/);
});
