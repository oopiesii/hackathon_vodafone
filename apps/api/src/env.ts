import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().min(1),
  PUBLIC_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32, "згенеруйте: openssl rand -base64 48"),
  TG_SESSION_KEY: z.string().min(43),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Некоректне оточення:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
