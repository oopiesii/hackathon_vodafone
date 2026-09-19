// Застосовує db/migrations/*.sql по порядку. Кожен файл — одна транзакція.
// Схема БД — мовно-нейтральний контракт між Python-пайплайном і TS API, тому міграції — чистий SQL.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  // Один мігратор за раз, навіть якщо деплой запустив кілька реплік.
  await client.query("select pg_advisory_lock(727001)");
  await client.query(`
    create table if not exists public.schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
  const applied = new Map(
    (await client.query("select name, checksum from public.schema_migrations")).rows.map((r) => [r.name, r.checksum]),
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const name of files) {
    const sql = await readFile(join(dir, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    if (applied.has(name)) {
      if (applied.get(name) !== checksum) {
        throw new Error(`${name} змінено після застосування. Додайте нову міграцію замість редагування старої.`);
      }
      continue;
    }
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into public.schema_migrations (name, checksum) values ($1, $2)", [name, checksum]);
      await client.query("commit");
      console.log(`applied ${name}`);
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  }
  console.log("db migrations: up to date");
} finally {
  await client.end();
}
