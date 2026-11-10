/**
 * npm run migrate -w @qa/api
 * Uses MIGRATION_DATABASE_URL (the schema owner) when set, otherwise DATABASE_URL.
 */
import { openDb, migrate } from "./index.js";

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || "pglite://./.data/pg";
const db = await openDb(url);
try {
  const applied = await migrate(db, (m) => console.log(m));
  console.log(applied.length ? `${applied.length} migration(s) applied` : "Database is up to date");
} finally {
  await db.close();
}
