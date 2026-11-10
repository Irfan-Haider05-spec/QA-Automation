import { loadConfig } from "./config.js";
import { openDb, migrate, pendingMigrations } from "./db/index.js";
import { createApp } from "./app.js";
import { startScheduler } from "./lib/scheduler.js";
import { startDispatcher } from "./lib/notify/dispatch.js";
import { Vault } from "./lib/crypto.js";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (e) {
  console.error(`[api] ${(e as Error).message}`);
  process.exit(1);
}
const db = await openDb(config.DATABASE_URL);
// Outside production the server migrates itself, as the schema owner when
// MIGRATION_DATABASE_URL is set (the app role can't change the schema).
// In production run `npm run migrate` first (the Docker setup has a one-shot
// migrate service); the server refuses to start on an out-of-date schema.
if (config.NODE_ENV !== "production") {
  const owner = config.MIGRATION_DATABASE_URL ? await openDb(config.MIGRATION_DATABASE_URL) : db;
  await migrate(owner, (m) => console.log(`[db] ${m}`));
  if (owner !== db) await owner.close();
} else {
  const pending = await pendingMigrations(db);
  if (pending === null) console.log("[db] can't read schema_migrations as the app role; skipping the schema check");
  else if (pending.length) {
    console.error(`[db] ${pending.length} migration(s) not applied (${pending.join(", ")}). Run the migrate step first (npm run migrate -w @qa/api).`);
    process.exit(1);
  }
}
const server = createApp(db, config).listen(config.PORT, () => console.log(`[api] listening on :${config.PORT} (${db.kind})`));

const stopScheduler = config.SCHEDULER_ENABLED ? startScheduler(db, config, (m) => console.log(`[scheduler] ${m}`)) : () => {};
if (!config.RUNNER_TOKEN) console.log("[api] RUNNER_TOKEN not set: hosted runs are disabled (jobs stay queued)");

const stopDispatcher = startDispatcher(db, new Vault(config.VAULT_MASTER_KEY), config, (m) => console.log(`[notify] ${m}`));

const shutdown = () => { stopScheduler(); stopDispatcher(); server.close(() => db.close().then(() => process.exit(0))); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
