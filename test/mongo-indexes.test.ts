import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { runPlugins } from '../src/core/runner.js';
import { triage } from '../src/core/triage.js';
import { discoverMongoose, indexProblems, uncoveredBranches } from '../src/discovery/mongoose-models.js';
import {
  filterKeys, liveIndexDefs, mongoIndexesPlugin, mongoIndexesSchema, mongooseCollectionName, planUsesCollscan, probeQuery, profilerShapes, scrubMongoError, unusedIndexes,
} from '../src/plugins/expanded/mongo-indexes.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-mongo-'));
const backend = path.join(root, 'backend');
let base: RunContext;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(backend, file)), { recursive: true }); fs.writeFileSync(path.join(backend, file), text); };

before(async () => {
  write('src/app/modules/user/user.model.ts', `import { Schema, model } from 'mongoose';
import type { IUser } from './user.interface';
const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true },
    phone: { type: String, index: true },
    role: { type: String, enum: ['USER', 'MERCHANT', 'ADMIN'] },
    status: String,
    merchantId: { type: Schema.Types.ObjectId, ref: 'User' },
    address: { city: { type: String, index: true }, zip: String },
    tags: [{ type: String, index: true }],
    bio: { type: String, text: true },
  },
  { timestamps: true },
);
userSchema.index({ merchantId: 1, createdAt: -1 });
userSchema.index({ merchantId: 1 });
userSchema.index({ email: 1 });
export const User = model<IUser>('User', userSchema);
`);
  write('src/app/modules/promotion/promotion.model.ts', `import mongoose from 'mongoose';
const promotionSchema = new mongoose.Schema({ code: String, merchantId: mongoose.Schema.Types.ObjectId, isActive: Boolean, status: String }, { timestamps: true });
export default mongoose.models.Promotion || mongoose.model('Promotion', promotionSchema);
`);
  write('src/app/modules/category/category.model.ts', `import { Schema, model } from 'mongoose';
export const Category = model('Category', new Schema({ slug: { type: String, index: { unique: true, sparse: true } }, name: String }), 'product_categories');
`);
  write('src/app/modules/user/user.service.ts', `import { User } from './user.model';
import { User as Account } from './user.model.js';
import Promotion from '../promotion/promotion.model';
import { Category } from '../category/category.model';
export async function svc(email: string, phone: string, id: string, n: string, q: string, filter: object, base: object) {
  await User.findOne({ email });
  await User.find({ role: 'MERCHANT', status: 'active' });
  await Account.countDocuments({ role: 'ADMIN' });
  await User.find({ merchantId: id, role: 'MERCHANT' }).sort({ createdAt: -1 }).lean();
  await User.find({ $or: [{ email }, { phone }] });
  await User.find({ $or: [{ email }, { nickname: n }] });
  await User.find({ 'address.city': 'Lahore' });
  await User.find(filter);
  await User.find({ ...base, role: 'USER' });
  await User.find({}).sort({ createdAt: -1 });
  await User.find();
  await User.find({ $text: { $search: q } });
  await Promotion.find({ merchantId: id, isActive: true });
  await Promotion.aggregate([{ $match: { status: 'live' } }, { $group: { _id: '$merchantId' } }]);
  await Promotion.distinct('code', { merchantId: id });
  await Category.findOne({ slug: 'shoes' });
  await User.updateMany({ status: 'pending' }, { $set: { status: 'active' } });
}
`);
  write('src/app/modules/user/user.service.test.ts', `import { User } from './user.model';\nUser.find({ neverReported: 1 });\n`);
  write('node_modules/lib/index.ts', `import { model } from 'mongoose';\nexport const X = model('X', new (require('mongoose').Schema)({}));\n`);
  const { config } = await loadConfig('test/fixture.config.ts', {});
  config.backend.dir = backend;
  base = { config, configDir: root, outDir: path.join(root, 'out'), suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function check(settings: Record<string, unknown> = {}, backendNone = false) {
  const config = { ...structuredClone(base.config), pluginSettings: { 'mongo-indexes': settings } };
  config.backend.none = backendNone;
  return (await runPlugins([mongoIndexesPlugin], { ...base, config }))[0];
}

test('Static discovery: models, declared indexes, collection names and queries (dynamic ones are counted, not guessed)', () => {
  const d = discoverMongoose(backend);
  assert.deepEqual(d.models.map((m) => [m.name, m.collection ?? mongooseCollectionName(m.name)]), [['Category', 'product_categories'], ['Promotion', 'promotions'], ['User', 'users']]);
  const user = d.models.find((m) => m.name === 'User')!;
  const keys = user.indexes.map((i) => i.keys.map((k) => `${k.field}:${k.dir}`).join(',') + (i.unique ? ' unique' : ''));
  assert.deepEqual(keys, ['email:1 unique', 'phone:1', 'address.city:1', 'tags:1', 'bio:text', 'merchantId:1,createdAt:-1', 'merchantId:1', 'email:1']);
  assert.match(user.indexes[0].source, /^src\/app\/modules\/user\/user\.model\.ts:5$/);
  const category = d.models.find((m) => m.name === 'Category')!;
  assert.deepEqual(category.indexes.map((i) => [i.keys[0].field, i.unique, i.sparse]), [['slug', true, true]]);
  assert.equal(d.queries.length, 13);
  assert.deepEqual(d.skipped, { dynamic: 2, unfiltered: 1, text: 1 });
  assert.ok(!d.queries.some((q) => q.source.includes('.test.')), 'test files are not analysed');
  assert.ok(!d.models.some((m) => m.name === 'X'), 'node_modules is not analysed');
  const or = d.queries.find((q) => q.source.endsWith(':11'))!;
  assert.deepEqual(or.branches, [['email'], ['nickname']]);
  const sorted = d.queries.find((q) => q.source.endsWith(':9'))!;
  assert.deepEqual(sorted.sort, ['createdAt']);
  const agg = d.queries.find((q) => q.method === 'aggregate')!;
  assert.deepEqual(agg.branches, [['status']]);
  const distinct = d.queries.find((q) => q.method === 'distinct')!;
  assert.deepEqual(distinct.branches, [['merchantId']]);
});

test('Static check reports each unindexed query shape once with its locations, plus duplicate and redundant indexes', async () => {
  const r = await check();
  assert.equal(r.status, 'failed', r.reason);
  const unindexed = r.findings.filter((f) => f.title === 'Query has no supporting index');
  // Each query shape is its own finding with its own target, so none can be merged away.
  assert.deepEqual(unindexed.map((f) => f.target).sort(), [
    'Promotion { isActive, merchantId }',
    'Promotion { merchantId }',
    'Promotion { status }',
    'User { nickname }',
    'User { role }',
    'User { role, status }',
    'User { status }',
    'User { } (sort only) sorted by createdAt',
  ]);
  for (const f of unindexed) assert.ok((f.detail ?? '').includes(`filters on ${f.target.slice(f.target.indexOf(' ') + 1)}`), `${f.target} matches its detail`);
  assert.equal(new Set(triage([{ plugin: 'mongo-indexes', status: 'failed', durationMs: 1, findings: structuredClone(r.findings) }], [])[0].findings.map((f) => f.fingerprint)).size, r.findings.length,
    'every finding survives triage with its own fingerprint');
  for (const f of unindexed) { assert.equal(f.severity, 'medium'); assert.equal(f.confidence, 'medium'); assert.equal(f.category, 'quality'); }
  const roleStatus = unindexed.find((f) => /\{ role, status \}/.test(f.detail ?? ''))!;
  assert.match(roleStatus.detail ?? '', /User\.find filters on \{ role, status \} in 1 place\(s\):\nsrc\/app\/modules\/user\/user\.service\.ts:7/);
  assert.match(roleStatus.remediation ?? '', /schema\.index\(\{ role: 1, status: 1 \}\)/);
  assert.match(unindexed.find((f) => /User\.countDocuments/.test(f.detail ?? ''))!.detail ?? '', /\{ role \}/, 'an aliased import still resolves to the model');
  assert.ok(!r.findings.some((f) => /email|phone|address\.city|slug/.test(/filters on (\{[^}]*\})/.exec(f.detail ?? '')?.[1] ?? '')), 'indexed fields (including nested paths and options objects) are covered');

  const dup = r.findings.filter((f) => f.title === 'Index declared twice');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].target, 'User { email: 1 }');
  assert.match(dup[0].detail ?? '', /\{ email: 1 \} at src\/app\/modules\/user\/user\.model\.ts:18 repeats src\/app\/modules\/user\/user\.model\.ts:5/);
  const red = r.findings.filter((f) => f.title === 'Redundant index');
  assert.equal(red.length, 1);
  assert.match(red[0].detail ?? '', /\{ merchantId: 1 \} at .*:17 is a prefix of \{ merchantId: 1, createdAt: -1 \}/);
  assert.equal(r.stats?.dynamicQueries, 2);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'out', 'mongo-indexes.json'), 'utf8'));
  assert.equal(report.models.length, 3);
});

test('knownIndexes covers indexes created outside Mongoose; ignoreModels and missing backends behave honestly', async () => {
  const r = await check({ knownIndexes: [{ model: 'Promotion', keys: ['merchantId', 'isActive'] }, { model: 'User', keys: ['status:1'] }], ignoreModels: ['Category'] });
  const shapes = r.findings.filter((f) => f.title === 'Query has no supporting index').map((f) => f.target).sort();
  assert.deepEqual(shapes, ['Promotion { status }', 'User { nickname }', 'User { role }', 'User { } (sort only) sorted by createdAt']);
  assert.equal(r.stats?.models, 2);

  const unknown = await check({ knownIndexes: [{ model: 'Ghost', keys: ['a'] }] });
  assert.equal(unknown.status, 'errored');
  assert.match(unknown.reason ?? '', /Ghost.*not found/);
  assert.equal((await check({}, true)).status, 'skipped');
});

test('Live mode: missing or malformed connection settings error, and connection failures never reveal the password', async () => {
  delete process.env.QA_MONGO_TEST_URI;
  const missing = await check({ static: false, live: { uriEnv: 'QA_MONGO_TEST_URI' } });
  assert.equal(missing.status, 'errored');
  assert.match(missing.reason ?? '', /need QA_MONGO_TEST_URI/);

  process.env.QA_MONGO_TEST_URI = 'postgres://x';
  assert.match((await check({ static: false, live: { uriEnv: 'QA_MONGO_TEST_URI' } })).reason ?? '', /not a MongoDB connection string/);

  // A real driver connection attempt to a closed local port.
  process.env.QA_MONGO_TEST_URI = 'mongodb://qa_reader:S3cretPassw0rd@127.0.0.1:1/mlitech?authSource=admin';
  const down = await check({ static: false, live: { uriEnv: 'QA_MONGO_TEST_URI', timeoutMs: 1000 } });
  assert.equal(down.status, 'errored');
  assert.match(down.reason ?? '', /Cannot connect to MongoDB/);
  assert.doesNotMatch(down.reason ?? '', /S3cretPassw0rd|qa_reader/);
  delete process.env.QA_MONGO_TEST_URI;
  assert.equal(scrubMongoError('failed mongodb+srv://u:p@h.example/db?x=1 and //a:b@c'), 'failed mongodb://[redacted] and //[redacted]@c');
});

test('Live analysis helpers: plans (classic, SBE, aggregate), index usage, profiler shapes without values', () => {
  assert.equal(planUsesCollscan({ queryPlanner: { winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', keyPattern: { email: 1 } } } } }), false);
  assert.equal(planUsesCollscan({ queryPlanner: { winningPlan: { stage: 'SORT', inputStage: { stage: 'COLLSCAN' } } } }), true);
  assert.equal(planUsesCollscan({ queryPlanner: { winningPlan: { queryPlan: { stage: 'COLLSCAN', planNodeId: 1 }, slotBasedPlan: { stages: '[1] scan' } } } }), true);
  assert.equal(planUsesCollscan({ queryPlanner: { winningPlan: { stage: 'OR', inputStages: [{ stage: 'IXSCAN' }, { stage: 'COLLSCAN' }] } } }), true);
  assert.equal(planUsesCollscan({ stages: [{ $cursor: { queryPlanner: { winningPlan: { stage: 'PROJECTION_SIMPLE', inputStage: { stage: 'IXSCAN' } } } } }] }), false);
  assert.throws(() => planUsesCollscan({ ok: 1 }), /no winning plan/);

  const idx = liveIndexDefs([
    { v: 2, key: { _id: 1 }, name: '_id_' },
    { v: 2, key: { email: 1 }, name: 'email_1', unique: true },
    { v: 2, key: { merchantId: 1, createdAt: -1 }, name: 'merchantId_1_createdAt_-1' },
    { v: 2, key: { merchantId: 1 }, name: 'merchantId_1' },
    { v: 2, key: { expiresAt: 1 }, name: 'expiresAt_1', expireAfterSeconds: 0 },
    { v: 2, key: { bio: 'text' }, name: 'bio_text' },
  ]);
  assert.deepEqual(idx[2].keys, [{ field: 'merchantId', dir: 1 }, { field: 'createdAt', dir: -1 }]);
  assert.deepEqual(indexProblems(idx.slice(1)).redundant.map(([a, b]) => [(a as unknown as { name: string }).name, (b as unknown as { name: string }).name]), [['merchantId_1', 'merchantId_1_createdAt_-1']]);
  const now = Date.parse('2026-11-18T00:00:00Z');
  const old = new Date(now - 30 * 86_400_000), recent = new Date(now - 86_400_000);
  const usage = unusedIndexes([
    { name: '_id_', accesses: { ops: 0, since: old } },
    { name: 'email_1', accesses: { ops: 0, since: old } },
    { name: 'merchantId_1', accesses: { ops: 0, since: old } },
    { name: 'merchantId_1_createdAt_-1', accesses: { ops: 42, since: old } },
    { name: 'expiresAt_1', accesses: { ops: 0, since: old } },
    { name: 'bio_text', accesses: { ops: 0, since: recent } },
  ], idx, now, 7);
  assert.deepEqual(usage, [{ name: 'merchantId_1', since: old.toISOString() }], '_id, unique, TTL, used and recently-restarted indexes are not reported');

  assert.deepEqual(filterKeys({ merchantId: 'x', $or: [{ a: 1 }, { b: { $gt: 2 } }], $and: [{ c: 1 }] }), [['a', 'c', 'merchantId'], ['b', 'c', 'merchantId']]);
  const shapes = profilerShapes([
    { op: 'query', ns: 'mlitech.users', planSummary: 'COLLSCAN', docsExamined: 50000, millis: 120, command: { find: 'users', filter: { phone: '+923001234567', password: 'hunter2' } } },
    { op: 'query', ns: 'mlitech.users', planSummary: 'COLLSCAN', docsExamined: 70000, millis: 300, command: { find: 'users', filter: { password: 'other', phone: '+923009999999' } } },
    { op: 'update', ns: 'mlitech.promotions', planSummary: 'COLLSCAN', docsExamined: 2000, millis: 9, command: { q: { status: 'x' }, u: { $set: { a: 1 } } } },
    { op: 'command', ns: 'mlitech.promotions', planSummary: 'COLLSCAN', docsExamined: 5000, millis: 30, command: { aggregate: 'promotions', pipeline: [{ $match: { code: 'SECRET50' } }] } },
    { op: 'query', ns: 'mlitech.users', planSummary: 'IXSCAN { email: 1 }', docsExamined: 90000, command: { filter: { email: 'a@b.c' } } },
    { op: 'query', ns: 'mlitech.small', planSummary: 'COLLSCAN', docsExamined: 10, command: { filter: { a: 1 } } },
  ], 1000);
  assert.deepEqual(shapes.map((s) => [s.ns, s.op, s.keys.join(','), s.count, s.maxDocs, s.maxMs]), [
    ['mlitech.users', 'query', 'password,phone', 2, 70000, 300],
    ['mlitech.promotions', 'command', 'code', 1, 5000, 30],
    ['mlitech.promotions', 'update', 'status', 1, 2000, 9],
  ]);
  assert.doesNotMatch(JSON.stringify(shapes), /hunter2|9230|SECRET50|other/, 'filter values never leave the profiler entry');

  assert.deepEqual(probeQuery({ model: 'U', method: 'find', branches: [['a', 'b']], sort: ['c'], source: 'x' }), { filter: { a: '__veriq_probe__', b: '__veriq_probe__' }, sort: { c: 1 } });
  assert.deepEqual(probeQuery({ model: 'U', method: 'find', branches: [['a'], ['b']], sort: [], source: 'x' }).filter, { $or: [{ a: '__veriq_probe__' }, { b: '__veriq_probe__' }] });
});

test('Collection names, coverage rules and settings validation', () => {
  // Recorded from mongoose 8.24.10: require('mongoose').pluralize()(name), for the names below.
  const real = {"User":"users","Category":"categories","Person":"people","Address":"addresses","Status":"status","Box":"boxes","Company":"companies","Promotion":"promotions","PromotionMerchant":"promotionmerchants","Wallet":"wallets","News":"news","Child":"children","Leaf":"leafs","Quiz":"quizzes","Knife":"knives","Wife":"wives","Bus":"buses","Analysis":"analyses","Datum":"data","Matrix":"matrixes","Index":"indexes","Mouse":"mice","Man":"men","Ox":"oxen","Octopus":"octopi","Hero":"heros","Tomato":"tomatoes","Media":"media","Series":"series","Alias":"aliases","Day":"days","Key":"keys","Quy":"quies","Hive":"hives","Wolf":"wolves","Calf":"calves","Moose":"moose"};
  assert.deepEqual(Object.fromEntries(Object.keys(real).map((n) => [n, mongooseCollectionName(n)])), real);

  const idx = [{ keys: [{ field: 'a', dir: 1 as const }, { field: 'b', dir: 1 as const }], unique: false, sparse: false, partial: false, source: 's' }, { keys: [{ field: 't', dir: 'text' as const }], unique: false, sparse: false, partial: false, source: 's' }];
  const q = (branches: string[][], sort: string[] = []) => ({ model: 'M', method: 'find', branches, sort, source: 'x' });
  assert.deepEqual(uncoveredBranches(q([['b']]), idx), [['b']], 'an index is usable only from its first field');
  assert.deepEqual(uncoveredBranches(q([['b', 'a']]), idx), []);
  assert.deepEqual(uncoveredBranches(q([['t']]), idx), [['t']], 'a text index does not serve equality filters');
  assert.deepEqual(uncoveredBranches(q([['_id']]), []), []);
  assert.deepEqual(uncoveredBranches(q([[]], ['a']), idx), []);
  assert.deepEqual(uncoveredBranches(q([[]], ['b']), idx), [[]]);
  // A unique (or sparse/partial) index enforces a rule, so it is never "redundant" even when a wider index starts with it.
  const mk = (keys: string[], extra: Partial<{ unique: boolean; sparse: boolean; partial: boolean }> = {}) => ({ keys: keys.map((field) => ({ field, dir: 1 as const })), unique: false, sparse: false, partial: false, source: keys.join('+'), ...extra });
  assert.deepEqual(indexProblems([mk(['a'], { unique: true }), mk(['a', 'b'])]).redundant, []);
  assert.deepEqual(indexProblems([mk(['a'], { partial: true }), mk(['a', 'b'])]).redundant, []);
  assert.deepEqual(indexProblems([mk(['a']), mk(['a', 'b'], { sparse: true })]).redundant, [], 'a sparse wider index does not hold every document');
  assert.equal(indexProblems([mk(['a']), mk(['a', 'b'])]).redundant.length, 1);

  const bad = (x: unknown) => assert.equal(mongoIndexesSchema.safeParse(x).success, false, JSON.stringify(x));
  bad({ static: false });
  bad({ live: { uriEnv: 'mongodb://user:pass@host' } });
  bad({ knownIndexes: [{ model: 'U', keys: ['a:sideways'] }] });
  bad({ unknown: true });
  assert.equal(mongoIndexesSchema.safeParse({}).success, true);
  assert.equal(mongoIndexesSchema.safeParse({ static: false, live: {} }).success, true);
});

test('Partial indexes with operators MongoDB refuses are reported as never built, and serve no query', async () => {
  // Found on MLITech: { $exists: true, $ne: null } made the unique email and phone indexes fail to build.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-partial-'));
  try {
    const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
    put('src/account.model.ts', `import { Schema, model } from 'mongoose';
const s = new Schema({
  email: String, phone: String, ref: String, a: Number, deleted: Boolean,
  code: { type: String, index: { unique: true, partialFilterExpression: { code: { $type: 'string' } } } },
});
s.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $exists: true, $ne: null } } });
s.index({ ref: 1 }, { partialFilterExpression: { deleted: { $exists: false } } });
s.index({ a: 1 }, { partialFilterExpression: { $or: [{ a: { $gt: 1 } }, { a: { $lt: -1 } }] } });
s.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $exists: true } } });
export const Account = model('Account', s);
`);
    put('src/account.service.ts', `import { Account } from './account.model';
export async function f(email: string, code: string, phone: string) {
  await Account.findOne({ email });
  await Account.findOne({ code });
  await Account.findOne({ phone });
}
`);
    const model = discoverMongoose(dir).models[0];
    assert.deepEqual(model.indexes.map((i) => [i.keys[0].field, i.unbuildable ?? null]), [
      ['code', null], ['email', '$ne is not supported in a partialFilterExpression'], ['ref', '$exists: false is not supported in a partialFilterExpression'], ['a', null], ['phone', null],
    ]);
    const config = { ...structuredClone(base.config), pluginSettings: { 'mongo-indexes': {} } };
    config.backend.dir = dir;
    const r = (await runPlugins([mongoIndexesPlugin], { ...base, config, outDir: path.join(dir, 'out') }))[0];
    const never = r.findings.filter((f) => f.title === 'Index can never be built');
    assert.deepEqual(never.map((f) => [f.target, f.severity]), [['Account { email: 1 }', 'high'], ['Account { ref: 1 }', 'medium']]);
    assert.match(never[0].detail ?? '', /src\/account\.model\.ts:6: \$ne is not supported.*duplicate values are not prevented/);
    assert.match(never[0].remediation ?? '', /\$type/);
    assert.deepEqual(r.findings.filter((f) => f.title === 'Query has no supporting index').map((f) => f.target), ['Account { email }'],
      'the email query has no usable index; the supported partial indexes on code and phone still serve theirs');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
