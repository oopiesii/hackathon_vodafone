// Перший адміністратор. Далі користувачів створюють із сайту (Адмін → Користувачі).
//   npm run auth:create-admin -- admin@example.com "Ім'я"
// Пароль читається з ADMIN_PASSWORD або зі stdin, щоб не лишатися в історії shell.
import { createInterface } from "node:readline/promises";
import { auth } from "../auth/auth.js";
import { closeDb } from "../db/pool.js";

const [email, name = "Admin"] = process.argv.slice(2);
if (!email) {
  console.error('usage: npm run auth:create-admin -- <email> ["Name"]');
  process.exit(1);
}

let password = process.env.ADMIN_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  password = await rl.question("Пароль (мін. 12 символів): ");
  rl.close();
}

try {
  const { user } = await auth.api.createUser({ body: { email, password, name, role: "admin" } });
  console.log(`створено ${user.email} (role=${user.role})`);
} catch (err) {
  console.error("не вдалося створити:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
