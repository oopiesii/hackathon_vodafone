import { useState, type FormEvent } from "react";
import { Brand } from "../components/Shell";
import { Alert, Card, Field } from "../components/ui";
import { authClient } from "../lib/auth-client";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (res.error) {
      setError(res.error.status === 429 ? "Забагато спроб. Спробуйте за хвилину." : "Невірна пошта або пароль.");
    }
    // Успіх: useSession в App оновиться сам і покаже дашборд.
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand"><span className="brand"><Brand /></span></div>
        <Card title="Вхід" description="Доступ видає адміністратор.">
          <form className="form" onSubmit={submit}>
            <Field label="Пошта">
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Пароль">
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <button type="submit" className="btn btn-block" disabled={busy}>{busy ? "Входимо…" : "Увійти"}</button>
          </form>
        </Card>
      </div>
    </div>
  );
}
