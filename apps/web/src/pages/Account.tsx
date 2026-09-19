import { useState, type FormEvent } from "react";
import { Alert, Card, Field, PageHeader } from "../components/ui";
import { authClient } from "../lib/auth-client";

export function Account() {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null), [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form);
    setPending(true);
    try {
      const r = await authClient.changePassword({ currentPassword: String(data.get("current")), newPassword: String(data.get("replacement")), revokeOtherSessions: true });
      if (r.error) throw new Error(r.error.message);
      form.reset();
      setResult({ ok: true, text: "Пароль змінено. Інші сеанси завершено." });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : "Помилка" });
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <PageHeader title="Акаунт" description="Безпека вашого входу до монітора." />
      <Card className="narrow" title="Змінити пароль" description="Після зміни всі інші сеанси буде завершено.">
        <form className="form" onSubmit={submit}>
          <Field label="Поточний пароль">
            <input name="current" type="password" autoComplete="current-password" required />
          </Field>
          <Field label="Новий пароль" hint="Щонайменше 12 символів.">
            <input name="replacement" type="password" minLength={12} autoComplete="new-password" required />
          </Field>
          {result && <Alert tone={result.ok ? "success" : "danger"}>{result.text}</Alert>}
          <div className="form-actions"><button className="btn" disabled={pending}>Змінити пароль</button></div>
        </form>
      </Card>
    </>
  );
}
