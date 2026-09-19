import { Hono } from "hono";
import { sql } from "kysely";
import { db } from "../db/pool.js";

export const health = new Hono().get("/", async (c) => {
  try {
    await sql`select 1`.execute(db);
    return c.json({ status: "ok" });
  } catch {
    return c.json({ status: "db_unavailable" }, 503);
  }
});
