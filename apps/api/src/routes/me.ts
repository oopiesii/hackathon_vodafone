import { Hono } from "hono";
import { requireSession, type AppEnv } from "../auth/middleware.js";
import { permissionsOf } from "@ufv/shared/permissions";

export const me = new Hono<AppEnv>().get("/", requireSession, (c) => {
  const user = c.get("user");
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role ?? "viewer" },
    permissions: permissionsOf(user.role),
  });
});
