import { ac, roles } from "@ufv/shared/permissions";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// baseURL не задаємо: клієнт ходить на той самий origin, /api/auth/*.
export const authClient = createAuthClient({ plugins: [adminClient({ ac, roles })] });
