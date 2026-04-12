import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSql, closeDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "..", "sql", "schema.sql");

async function columnExists(sql, table, column) {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    LIMIT 1
  `;
  return rows.length > 0;
}

/** Align older DBs (e.g. Python Alembic 0001-only) with the current schema. */
async function ensureCompat(sql) {
  const usersExists = await sql`
    SELECT to_regclass('public.users') AS t
  `;
  if (!usersExists[0]?.t) return;

  if (!(await columnExists(sql, "users", "installation_id"))) {
    console.log("Migrating users table: installation_id + nullable email/password");
    await sql.unsafe(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS installation_id VARCHAR(128);
      CREATE UNIQUE INDEX IF NOT EXISTS ix_users_installation_id ON users (installation_id);
      ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
      ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
    `);
  }

  if (!(await columnExists(sql, "playlists", "created_at"))) {
    console.log("Migrating playlists: created_at");
    await sql.unsafe(`
      ALTER TABLE playlists ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);
  }
}

async function main() {
  const sql = getSql();
  const [{ t }] = await sql`SELECT to_regclass('public.users') AS t`;

  if (!t) {
    const ddl = fs.readFileSync(schemaPath, "utf8");
    await sql.unsafe(ddl);
    console.log("Applied sql/schema.sql (fresh database)");
  } else {
    console.log("Database has existing schema; checking compatibility…");
  }

  await ensureCompat(sql);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
