// Створює/оновлює таблиці Better Auth у схемі auth. Схему створює db/migrations/0001.
import { getMigrations } from "better-auth/db/migration";
import { auth } from "../auth/auth.js";
import { closeDb } from "../db/pool.js";

const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length === 0 && toBeAdded.length === 0) {
  console.log("auth migrations: up to date");
} else {
  for (const t of toBeCreated) console.log(`create table auth.${t.table}`);
  for (const t of toBeAdded) console.log(`alter table auth.${t.table}: +${Object.keys(t.fields).join(", +")}`);
  await runMigrations();
  console.log("auth migrations: applied");
}
await closeDb();
