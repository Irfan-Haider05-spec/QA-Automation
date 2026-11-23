/**
 * Real MongoDB acceptance for the MongoDB paths of db-checks, scenario database steps and
 * mongo-indexes live mode. Set QA_TEST_MONGO_URL to a disposable server (a replica set is
 * not needed), e.g. mongodb://127.0.0.1:27017; each run uses and then drops its own
 * database. Without the variable the tests are reported as skipped.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { HttpClient } from '../src/core/http.js';
import { runPlugins } from '../src/core/runner.js';
import { dbChecksPlugin } from '../src/plugins/expanded/db-checks.js';
import { apiScenariosPlugin } from '../src/plugins/expanded/api-scenarios.js';
import { mongoIndexesPlugin } from '../src/plugins/expanded/mongo-indexes.js';

const URL_BASE = process.env.QA_TEST_MONGO_URL;
const skip = URL_BASE ? false : 'QA_TEST_MONGO_URL is not set (a disposable MongoDB server)';
const dbName = `veriq_live_${randomBytes(4).toString('hex')}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-mongo-live-'));
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
let client: MongoClient, db: Db, base: RunContext, server: http.Server | undefined, apiUrl = '';
const uri = () => { const u = new URL(URL_BASE!); u.pathname = `/${dbName}`; return u.toString(); };

before(async () => {
  if (skip) return;
  client = await MongoClient.connect(URL_BASE!);
  db = client.db(dbName);
  const merchant = new ObjectId(), gone = new ObjectId();
  await db.collection('users').insertMany([{ _id: merchant, email: 'ali@shop.pk' }, { email: 'ALI@shop.pk' }, { email: 'sara@shop.pk' }]);
  await db.collection('promotionmerchants').insertMany([
    { name: 'ok', merchantId: merchant, discountPercentage: 10, startDate: new Date('2026-01-01'), endDate: new Date('2099-01-01'), status: 'active' },
    { name: 'orphan', merchantId: gone, discountPercentage: 150, startDate: new Date('2026-02-01'), endDate: new Date('2026-01-01'), status: 'active' },
  ]);
  process.env.QA_TEST_LIVE_DB = uri();
  const { config } = await loadConfig('test/fixture.config.ts', {});
  base = { config, configDir: root, outDir: path.join(root, 'out'), suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } } as RunContext;
});
after(async () => {
  if (server) await new Promise((r) => server!.close(r));
  if (client) { await db.dropDatabase(); await client.close(); }
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.QA_TEST_LIVE_DB;
});

const ctxWith = (settings: Record<string, unknown>, extra: Partial<RunContext> = {}) => {
  const config = structuredClone(base.config);
  config.pluginSettings = settings;
  return { ...base, ...extra, config } as RunContext;
};

test('db-checks on real MongoDB: filters, $lookup pipelines, $expr with $$NOW, samples, and no writes', { skip }, async () => {
  write('checks.yaml', `version: 1
checks:
  - name: Promotions belong to an existing merchant
    severity: critical
    collection: promotionmerchants
    pipeline: [ { $lookup: { from: users, localField: merchantId, foreignField: _id, as: m } }, { $match: { m: { $size: 0 } } }, { $project: { name: 1 } } ]
    sampleField: name
  - name: Promotions end after they start
    collection: promotionmerchants
    filter: { $expr: { $lt: ["$endDate", "$startDate"] } }
  - name: Active promotions are not past their end date
    collection: promotionmerchants
    filter: { $expr: { $and: [ { $eq: ["$status", "active"] }, { $lt: ["$endDate", "$$NOW"] } ] } }
  - name: Discounts are within range
    collection: promotionmerchants
    filter: { $or: [ { discountPercentage: { $lt: 0 } }, { discountPercentage: { $gt: 100 } } ] }
  - name: Emails are unique ignoring case
    collection: users
    pipeline: [ { $group: { _id: { $toLower: "$email" }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } } ]
    sampleField: _id
  - name: There is exactly one valid promotion
    collection: promotionmerchants
    filter: { name: ok, merchantId: { $exists: true } }
    expect: { count: 1, json: [ { path: "$[0].discountPercentage", equals: 10 } ] }
`);
  const before = await db.collection('promotionmerchants').countDocuments();
  const r = (await runPlugins([dbChecksPlugin], ctxWith({ 'db-checks': { database: { type: 'mongodb', urlEnv: 'QA_TEST_LIVE_DB' }, files: 'checks.yaml' } })))[0];
  assert.equal(r.status, 'failed', r.reason);
  assert.deepEqual(r.findings.map((f) => f.title).sort(), [
    'Data integrity check failed: Active promotions are not past their end date',
    'Data integrity check failed: Discounts are within range',
    'Data integrity check failed: Emails are unique ignoring case',
    'Data integrity check failed: Promotions belong to an existing merchant',
    'Data integrity check failed: Promotions end after they start',
  ]);
  assert.match(r.findings.find((f) => /existing merchant/.test(f.title))!.detail!, /Sample name: "orphan"/);
  const dupDetail = r.findings.find((f) => /unique/.test(f.title))!.detail!;
  assert.match(dupDetail, /Sample _id: "<email>"/, 'personal data in samples is redacted');
  assert.ok(!dupDetail.includes('shop.pk'));
  assert.equal(r.stats?.passed, 1, 'the positive control passes on real data');
  assert.equal(await db.collection('promotionmerchants').countDocuments(), before);

  write('bad.yaml', 'version: 1\nchecks:\n  - name: writes\n    collection: users\n    pipeline: [ { $out: stolen } ]\n');
  const bad = (await runPlugins([dbChecksPlugin], ctxWith({ 'db-checks': { database: { type: 'mongodb', urlEnv: 'QA_TEST_LIVE_DB' }, files: 'bad.yaml' } })))[0];
  assert.equal(bad.status, 'errored');
  assert.match(bad.reason ?? '', /\$out is not allowed/);
  assert.equal((await db.listCollections({ name: 'stolen' }).toArray()).length, 0);
});

test('Scenario database steps on real MongoDB: check what an API call stored and reuse it', { skip }, async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const send = (s: number, v: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.method === 'POST' && req.url === '/promotions') {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { insertedId } = await db.collection('promotionmerchants').insertOne({ name: body.name, discountPercentage: body.discount, createdAt: new Date() });
      return send(201, { data: { _id: insertedId.toHexString(), name: body.name } });
    }
    const m = /^\/promotions\/([0-9a-f]{24})$/.exec(req.url ?? '');
    if (m) { const p = await db.collection('promotionmerchants').findOne({ _id: new ObjectId(m[1]) }); return p ? send(200, { data: { name: p.name } }) : send(404, {}); }
    send(404, {});
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  write('scenarios.yaml', `version: 1
scenarios:
  - name: Stored as sent
    steps:
      - request: { method: POST, path: /promotions, json: { name: "QA {{unique}}", discount: 15 } }
        expect: { status: 201 }
        save: { id: $.data._id }
      - name: in the database
        db: { collection: promotionmerchants, filter: { _id: { $oid: "{{id}}" }, discountPercentage: 15 }, expect: { count: 1, json: [ { path: "$[0].createdAt", type: string } ] } }
        save: { storedName: "$[0].name" }
      - request: { method: GET, path: "/promotions/{{id}}" }
        expect: { json: [ { path: $.data.name, equals: "{{storedName}}" } ] }
  - name: A missing row fails the step
    steps:
      - db: { collection: promotionmerchants, filter: { name: "never stored" } }
`);
  const ctx = ctxWith({ 'api-scenarios': { files: 'scenarios.yaml', database: { type: 'mongodb', urlEnv: 'QA_TEST_LIVE_DB' } } },
    { http: new HttpClient(apiUrl, 6000, 10_000) } as Partial<RunContext>);
  ctx.config.target.baseUrl = apiUrl;
  ctx.config.allowMutations = true; ctx.config.disposable = true;
  const r = (await runPlugins([apiScenariosPlugin], ctx))[0];
  assert.equal(r.stats?.passed, 1, JSON.stringify(r.findings.map((f) => f.detail)));
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].title, /A missing row fails the step/);
  assert.match(r.findings[0].detail ?? '', /database read on promotionmerchants[\s\S]*expected at least 1 row/);
});

test('mongo-indexes live on real MongoDB: declared indexes that were never built are reported', { skip }, async () => {
  write('backend/src/widget.model.ts', `import { Schema, model } from 'mongoose';
const s = new Schema({ sku: String, name: String, email: String });
s.index({ sku: 1 }, { unique: true });
s.index({ name: 1 });
s.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $ne: null } } });
export const Widget = model('Widget', s);
`);
  write('backend/src/widget.service.ts', `import { Widget } from './widget.model';\nexport const f = (sku: string) => Widget.findOne({ sku });\n`);
  await db.collection('widgets').insertOne({ sku: 'a', name: 'n' });
  await db.collection('widgets').createIndex({ name: 1 });
  // The build MongoDB refuses, exactly as Mongoose would attempt it:
  await assert.rejects(db.collection('widgets').createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $ne: null } } }), /not supported in partial/i);
  process.env.QA_TEST_LIVE_INDEX_DB = uri();
  const ctx = ctxWith({ 'mongo-indexes': { live: { uriEnv: 'QA_TEST_LIVE_INDEX_DB', profiler: false } } });
  ctx.config.backend.dir = path.join(root, 'backend');
  const r = (await runPlugins([mongoIndexesPlugin], ctx))[0];
  delete process.env.QA_TEST_LIVE_INDEX_DB;
  const missing = r.findings.filter((f) => f.title === 'Declared index is missing from the database');
  assert.deepEqual(missing.map((f) => [f.target, f.severity]), [['Widget { sku: 1 }', 'high']], 'the name index exists, so only sku is missing');
  const never = r.findings.find((f) => f.title === 'Index can never be built')!;
  assert.match(never.detail ?? '', /Confirmed: it is not in the live database/);
  assert.ok(r.findings.some((f) => f.title === 'Query plan scans the whole collection' && f.target === 'Widget { sku }'), 'the real plan for findOne({ sku }) is a collection scan');
  assert.equal(r.stats?.declaredMissing, 2);
});
