import { createAccessControl, type AccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";

// Єдине місце, де описано, що взагалі можна робити в продукті. Спільне для apps/api (перевірка) та apps/web (показ).
const statement = {
  ...defaultStatements, // user/session — керування обліковими записами з admin-плагіна
  feed: ["read"],
  incident: ["read", "edit"],
  collector: ["read", "manage"],
  shareLink: ["create", "revoke"],
} as const;

// Явна анотація: без неї .d.ts розгортає тип структурно і плагін admin його не приймає.
export const ac: AccessControl<typeof statement> = createAccessControl(statement);

export const roles = {
  admin: ac.newRole({
    ...adminAc.statements,
    feed: ["read"],
    incident: ["read", "edit"],
    collector: ["read", "manage"],
    shareLink: ["create", "revoke"],
  }),
  analyst: ac.newRole({
    feed: ["read"],
    incident: ["read", "edit"],
    collector: ["read"],
    shareLink: ["create", "revoke"],
  }),
  viewer: ac.newRole({
    feed: ["read"],
    incident: ["read"],
  }),
};

export type RoleName = keyof typeof roles;
export type Permission = { [K in keyof typeof statement]?: (typeof statement)[K][number][] };

const isRole = (r: string): r is RoleName => r in roles;

// У Better Auth поле role може містити кілька ролей через кому.
export function hasPermission(role: string | null | undefined, permission: Permission): boolean {
  return (role ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(isRole)
    .some((r) => roles[r].authorize(permission).success);
}

export function permissionsOf(role: string | null | undefined) {
  const out: Record<string, string[]> = {};
  for (const r of (role ?? "").split(",").map((s) => s.trim()).filter(isRole)) {
    for (const [resource, actions] of Object.entries(roles[r].statements)) {
      out[resource] = [...new Set([...(out[resource] ?? []), ...(actions as readonly string[])])];
    }
  }
  return out;
}
