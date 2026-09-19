import { Hono } from "hono";
import { requirePermission, requireSession, type AppEnv } from "../auth/middleware.js";
import { db } from "../db/pool.js";

// Сайт не викликає collector напряму: він змінює core.sources, а collector сам підхоплює зміни.
export const collectors = new Hono<AppEnv>()
  .use(requireSession)
  .get("/sources", requirePermission({ collector: ["read"] }), async (c) => {
    const items = await db.selectFrom("core.sources").selectAll().orderBy("id").execute();
    return c.json({ items });
  })
  .post("/sources", requirePermission({ collector: ["manage"] }), async (c) => {
    return c.json({ error: "use_admin_channels", message: "Додайте канал через /api/admin/channels із сесією та підставою використання." }, 410);
  });
