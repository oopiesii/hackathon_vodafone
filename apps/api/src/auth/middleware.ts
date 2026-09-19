import { createMiddleware } from "hono/factory";
import { auth, type Session } from "./auth.js";
import { hasPermission, type Permission } from "@ufv/shared/permissions";

export type AppEnv = {
  Variables: {
    user: Session["user"];
    session: Session["session"];
  };
};

export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const current = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!current) return c.json({ error: "unauthorized" }, 401);
  c.set("user", current.user);
  c.set("session", current.session);
  await next();
});

// Права перевіряє сервер на кожному запиті; фронтенд лише ховає недоступне.
export const requirePermission = (permission: Permission) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!hasPermission(c.get("user").role, permission)) return c.json({ error: "forbidden" }, 403);
    await next();
  });
