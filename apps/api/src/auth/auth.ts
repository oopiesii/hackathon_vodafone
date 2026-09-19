import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { authPool } from "../db/pool.js";
import { env } from "../env.js";
import { ac, roles } from "@ufv/shared/permissions";

export const auth = betterAuth({
  appName: "UFV Monitor",
  baseURL: env.PUBLIC_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  database: authPool,
  trustedOrigins: [env.PUBLIC_URL],

  // Закритий B2B-продукт: самореєстрації немає, облікові записи створює адміністратор.
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
  },

  // Сесії лежать у БД, тож їх можна відкликати; у браузері лише HttpOnly-cookie.
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },

  // storage: "database" — ліміти спільні для всіх реплік API.
  rateLimit: { enabled: true, storage: "database" },

  advanced: {
    cookiePrefix: "ufv",
    useSecureCookies: env.NODE_ENV === "production",
  },

  plugins: [admin({ ac, roles, defaultRole: "viewer", adminRoles: ["admin"] })],
});

export type Session = typeof auth.$Infer.Session;
