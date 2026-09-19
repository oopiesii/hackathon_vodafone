import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Alert, Badge, Card, Field, PageHeader } from "../components/ui";
import { authClient } from "../lib/auth-client";
import { ROLES } from "../lib/labels";

type Role = "admin" | "analyst" | "viewer";

const ROLE_HELP: Record<Role, string> = {
  admin: "Керує користувачами, Sources, сесіями, workflow та посиланнями; може змінювати рішення відбору.",
  analyst: "Бачить усі зібрані матеріали, чергу, відсіяне та контекст. Налаштування, credentials і ручна зміна рішень доступні адміністратору.",
  viewer: "Бачить лише матеріали, допущені до стрічки, та їхні джерела. Не бачить увесь вхід і налаштування.",
};

// Better Auth відповідає англійською; показуємо своє за кодом помилки.
function explain(error: { code?: string | undefined; message?: string | undefined }) {
  if (error.code?.startsWith("USER_ALREADY_EXISTS")) return "Користувач із такою поштою вже існує.";
  if (error.code === "PASSWORD_TOO_SHORT") return "Пароль закороткий: потрібно щонайменше 12 символів.";
  return error.message ?? "Не вдалося виконати запит.";
}

export function AdminUsers() {
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const res = await authClient.admin.listUsers({ query: { limit: 100, sortBy: "createdAt", sortDirection: "desc" } });
      if (res.error) throw new Error(explain(res.error));
      return res.data.users;
    },
  });

  const [form, setForm] = useState({ name: "", email: "", password: "", role: "viewer" as Role });
  const create = useMutation({
    mutationFn: async () => {
      const res = await authClient.admin.createUser(form);
      if (res.error) throw new Error(explain(res.error));
      return res.data.user;
    },
    onSuccess: () => {
      setForm({ name: "", email: "", password: "", role: "viewer" });
      return qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <>
      <PageHeader title="Користувачі" description="Облікові записи команди та їхні ролі. Реєстрація закрита: доступ створює адміністратор." />
      <div className="split">
        <Card className="card-flush" title="Усі користувачі" description={users.data ? `Усього: ${users.data.length}` : undefined}>
          <div className="tablewrap">
            {users.isPending && <p className="loading" role="status">Завантаження…</p>}
            {users.isError && <div className="pad"><Alert tone="danger">{users.error.message}</Alert></div>}
            {users.data && (
              <table>
                <thead><tr><th>Ім'я</th><th>Пошта</th><th>Роль</th></tr></thead>
                <tbody>
                  {users.data.map((u) => (
                    <tr key={u.id}>
                      <td><strong>{u.name}</strong></td>
                      <td>{u.email}</td>
                      <td><Badge tone={u.role === "admin" ? "neutral" : "secondary"}>{ROLES[u.role ?? ""] ?? u.role}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        <Card title="Новий користувач" description="Передайте тимчасовий пароль особисто; користувач змінить його в розділі «Акаунт».">
          <form className="form" onSubmit={submit}>
            <Field label="Ім'я">
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Пошта">
              <input type="email" required autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Тимчасовий пароль" hint="Щонайменше 12 символів.">
              <input type="password" required minLength={12} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
            <Field label="Роль" hint={ROLE_HELP[form.role]}>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                <option value="viewer">Перегляд — відібрана стрічка</option>
                <option value="analyst">Аналітик — увесь вхід і перевірка</option>
                <option value="admin">Адміністратор — користувачі та збирачі</option>
              </select>
            </Field>
            {create.isError && <Alert tone="danger">{create.error.message}</Alert>}
            {create.isSuccess && <Alert tone="success">Створено: {create.data.email}</Alert>}
            <div className="form-actions"><button type="submit" className="btn" disabled={create.isPending}>Створити</button></div>
          </form>
        </Card>
      </div>
    </>
  );
}
