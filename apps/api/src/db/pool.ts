import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { env } from "../env.js";

// Better Auth живе у схемі auth і не бачить таблиць пайплайна.
export const authPool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  options: "-c search_path=auth",
  max: 5,
  connectionTimeoutMillis: 5000,
});

// Curated views produce complex plans even for a handful of visible rows. LLVM
// compilation overhead coincided with 6–7s dashboard regressions; jit=off
// fit the existing 5s HTTP deadline. Keep this setting local to application reads.
export const appPool = new pg.Pool({ connectionString: env.DATABASE_URL, options: "-c jit=off", max: 10, connectionTimeoutMillis: 5000 });
// Idle connections can be terminated during a database restart. Let the pool
// reconnect without crashing Node or dumping connection internals into logs.
for (const pool of [authPool, appPool]) {
  pool.on('error', () => console.warn('PostgreSQL idle connection lost; reconnecting on the next request'));
}

// Типи таблиць core.* генеруватимемо з БД (kysely-codegen), коли контракт пайплайна погодять.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db = new Kysely<any>({ dialect: new PostgresDialect({ pool: appPool }) });

export async function closeDb() {
  await Promise.all([authPool.end(), db.destroy()]);
}
