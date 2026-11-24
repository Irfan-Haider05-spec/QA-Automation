/**
 * `qa init`: set VeriQ up on a project. Checked on the fixture backend (TypeScript, modules
 * mounted from a routes index), a small CommonJS Express app (routes in the index itself and
 * a required module), and a project without backend source (OpenAPI). The generated
 * configuration is loaded and run, and must still report the fixture's planted open routes.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/core/config.js';
import { analyseProject, detectBackend, workflowSource } from '../src/core/init-project.js';
import { discoverRoutes } from '../src/discovery/express-routes.js';

const root = path.resolve('.');
const cli = path.join(root, 'bin', 'qa.mjs');
const temp: string[] = [];
const tmp = (name: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `veriq-init-${name}-`)); temp.push(d); return d; };
after(() => { for (const d of temp) fs.rmSync(d, { recursive: true, force: true }); });
const qa = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, QA_BASE_URL: '' } });

function jsApp(): string {
  const dir = tmp('js');
  fs.mkdirSync(path.join(dir, 'routes'));
  fs.mkdirSync(path.join(dir, 'middleware'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'const express = require("express");\nconst routes = require("./routes");\nconst app = express();\napp.get("/health", (req, res) => res.json({ ok: true }));\napp.use("/api", routes);\nmodule.exports = app;\n');
  fs.writeFileSync(path.join(dir, 'middleware', 'auth.js'), 'module.exports = (...roles) => (req, res, next) => next();\n');
  fs.writeFileSync(path.join(dir, 'routes', 'items.js'), 'const express = require("express");\nconst auth = require("../middleware/auth");\nconst router = express.Router();\nrouter.get("/", auth("ADMIN", "STAFF"), (req, res) => res.json([]));\nrouter.delete("/:id", auth("ADMIN"), (req, res) => res.json({}));\nmodule.exports = router;\n');
  fs.writeFileSync(path.join(dir, 'routes', 'index.js'), 'const router = require("express").Router();\nconst items = require("./items");\nrouter.post("/login", (req, res) => { const { username, password } = req.body; res.json({}); });\nrouter.get("/export", (req, res) => res.json([]));\nrouter.use("/items", items);\nrouter.use("/orders", require("./items"));\nmodule.exports = router;\n');
  return dir;
}

test('Discovery reads CommonJS requires and routes declared in the routes index itself', () => {
  const dir = jsApp();
  const layout = detectBackend(dir);
  assert.deepEqual({ routesIndex: layout.routesIndex, appFile: layout.appFile, apiPrefix: layout.apiPrefix, healthPath: layout.healthPath }, { routesIndex: 'routes/index.js', appFile: 'app.js', apiPrefix: '/api', healthPath: '/health' });
  const { routes } = discoverRoutes({ backendDir: dir, routesIndex: layout.routesIndex, apiPrefix: layout.apiPrefix, appFile: layout.appFile });
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path} ${r.authRequired ? r.roles.join('|') || 'auth' : 'open'}`).sort(), [
    'DELETE /api/items/:id ADMIN', 'DELETE /api/orders/:id ADMIN', 'GET /api/export open', 'GET /api/items ADMIN|STAFF', 'GET /api/orders ADMIN|STAFF', 'GET /health open', 'POST /api/login open',
  ], 'a variable require, an inline require and index routes, each once');
});

test('The fixture backend: login, roles and a configuration that keeps open routes reported', async () => {
  const work = tmp('fx');
  const r = qa(work, 'init', '--backend-dir', path.join(root, 'test/fixture-api'), '--project', 'Fixture', '--ci', '--action', 'acme/veriq@v2');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Found 22 routes, roles ADMIN, MERCHANT, SUPER_ADMIN, login \/api\/v1\/auth\/login, 2 without auth/);
  const source = fs.readFileSync(path.join(work, 'qa.config.ts'), 'utf8');
  assert.match(source, /bodyTemplate: \{ identifier: "\{\{identifier\}\}", password: "\{\{password\}\}" \}/, 'the login handler reads req.body.identifier');
  assert.match(source, /"POST \/auth\/login",\n\s+"GET \/health",/);
  assert.match(source, /\/\/ "POST \/admin\/create-admin",\n\s+\/\/ "GET \/report-analytics\/customer\/export",/, 'open routes that are not public by nature are only suggested, never accepted');
  const { config } = await loadConfig(path.join(work, 'qa.config.ts'), {});
  assert.equal(config.backend.dir, path.join(root, 'test/fixture-api'));
  assert.deepEqual([...source.matchAll(/role: "(\w+)"/g)].map((m) => m[1]), ['ADMIN', 'MERCHANT', 'SUPER_ADMIN'], 'one account per role (loaded only once their variables are set)');
  assert.deepEqual(config.publicRoutes, ['POST /auth/login', 'GET /health']);
  assert.equal(config.allowMutations, false);
  assert.match(fs.readFileSync(path.join(work, '.env.qa.example'), 'utf8'), /^QA_SUPER_ADMIN_ID=\nQA_SUPER_ADMIN_PASS=$/m);
  assert.doesNotMatch(fs.readFileSync(path.join(work, '.env.qa.example'), 'utf8'), /=\S/, 'names only, never values');
  const workflow = fs.readFileSync(path.join(work, '.github/workflows/veriq.yml'), 'utf8');
  assert.match(workflow, /uses: acme\/veriq@v2\n\s+with:\n\s+suite: pr\n\s+config: qa.config.ts\n\s+changed-from: origin\/\$\{\{ github.base_ref \}\}/);
  assert.equal(fs.readFileSync(path.join(work, '.gitignore'), 'utf8'), '# VeriQ: local secrets and reports\n.env.qa\nqa-out/\n');

  const run = qa(work, 'run', '--suite', 'pr', '--out', 'qa-out');
  assert.equal(run.status, 1, 'the planted bugs fail the gate with the generated configuration');
  const report = JSON.parse(fs.readFileSync(path.join(work, 'qa-out/report.json'), 'utf8'));
  const routeAuth = report.results.find((x: any) => x.plugin === 'route-auth').findings;
  const sev = (target: string) => routeAuth.filter((f: any) => f.target === target).map((f: any) => f.severity);
  assert.deepEqual(sev('POST /admin/create-admin'), ['critical'], 'an open admin route under the starter privileged prefix');
  assert.equal(sev('GET /report-analytics/customer/export').length, 1, 'the open export is reported too (its severity rises once its prefix is listed as privileged)');
});

test('Init never overwrites, keeps existing files, and adds to .gitignore once', () => {
  const work = tmp('again');
  fs.writeFileSync(path.join(work, '.env.qa.example'), 'MINE=1\n');
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules\r\nqa-out/\r\n');
  const first = qa(work, 'init', '--backend-dir', path.join(root, 'test/fixture-api'));
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout + first.stderr, /Kept existing \.env\.qa\.example \(not overwritten\)/);
  assert.equal(fs.readFileSync(path.join(work, '.env.qa.example'), 'utf8'), 'MINE=1\n');
  assert.equal(fs.readFileSync(path.join(work, '.gitignore'), 'utf8'), 'node_modules\r\nqa-out/\r\n# VeriQ: local secrets and reports\r\n.env.qa\r\n', 'only the missing line, in the file\'s own line endings');
  const before = fs.readFileSync(path.join(work, 'qa.config.ts'), 'utf8');
  const second = qa(work, 'init', '--backend-dir', path.join(root, 'test/fixture-api'));
  assert.equal(second.status, 2);
  assert.match(second.stderr, /already exists; init never overwrites a configuration/);
  assert.equal(fs.readFileSync(path.join(work, 'qa.config.ts'), 'utf8'), before);
  assert.doesNotMatch(fs.readFileSync(path.join(work, '.gitignore'), 'utf8'), /VeriQ[\s\S]*VeriQ/);
});

test('A CommonJS app gets its login body field from the handler; a folder without a backend gets an OpenAPI starter', async () => {
  const app = jsApp();
  const setup = await analyseProject({ project: 'Shop', backendDir: app, workDir: tmp('jsw') });
  assert.deepEqual({ login: setup.login, roles: setup.roles, publicRoutes: setup.publicRoutes, reviewRoutes: setup.reviewRoutes },
    { login: { path: '/api/login', identifierField: 'username' }, roles: ['ADMIN', 'STAFF'], publicRoutes: ['POST /login', 'GET /health'], reviewRoutes: ['GET /export'] });

  const empty = tmp('empty');
  const r = qa(empty, 'init', '--project', 'Partner API');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No backend source: the starter reads routes from \.\/openapi\.json/);
  const { config } = await loadConfig(path.join(empty, 'qa.config.ts'), {});
  assert.equal(config.backend.none, true);
  assert.deepEqual(config.discovery, { format: 'openapi', file: './openapi.json' });
  assert.deepEqual(config.suites.pr, ['health-cors', 'api-auth', 'api-smoke']);
  assert.equal(qa(empty, 'init', '--backend-dir', '.', '--openapi', 'x.json').status, 2, 'one source or the other');
});

test('Without --action the workflow says plainly what to replace', () => {
  const text = workflowSource({ project: 'p', routes: [], roles: [], publicRoutes: [], reviewRoutes: [], mongooseModels: 0, warnings: [] }, { configPath: 'qa.config.ts', action: 'YOUR-ORG/qa-agent@v1' });
  assert.match(text, /# CHECK: replace YOUR-ORG\/qa-agent@v1 with the repository and tag of your VeriQ copy\./);
});
