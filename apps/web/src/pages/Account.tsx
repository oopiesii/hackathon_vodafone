import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Card, Field, PageHeader, Switch } from "../components/ui";
import { api, can, errorText, send, type Me } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { authClient } from "../lib/auth-client";

type Runtime = { configured: boolean; reachable: boolean; enabled: boolean; runtime?: string; model?: string; effort?: string; calls?: number; failures?: number; last_ok_at?: string | null; last_ms?: number | null; last_error?: string | null };

/** Перемикач «усі AI-запити сайту — через локальний рантайм Claude Code». Лише для демонстрацій; стан зберігає місток на сервері. */
function LocalRuntime() {
  const cache = useQueryClient();
  const status = useQuery({ queryKey: ["admin-runtime"], queryFn: () => api<Runtime>("/admin/runtime"), refetchInterval: 15_000 });
  const toggle = useMutation({ mutationFn: (enabled: boolean) => send<Runtime>("/admin/runtime", "POST", { enabled }),
    onSuccess: (next) => { cache.setQueryData(["admin-runtime"], next); void cache.invalidateQueries({ queryKey: ["analyst-runtime"] }); } });
  const s = status.data, usable = s?.configured && s.reachable;
  return (
    <Card title="Локальний рантайм AI" description="Коли ввімкнено, усі AI-запити сайту — розмітка матеріалів, зведення, чат аналітика — йдуть через Claude Code на цьому сервері, без ключів API. Коли вимкнено — усе працює як раніше: за правилами."
      actions={s && <Badge tone={!s.configured ? "secondary" : !s.reachable ? "danger" : s.enabled ? "success" : "secondary"} dot>{!s.configured ? "Не налаштовано" : !s.reachable ? "Місток не відповідає" : s.enabled ? "Увімкнено" : "Вимкнено"}</Badge>}>
      <div className="stack">
        <Switch checked={s?.enabled === true} disabled={!usable || toggle.isPending} ariaLabel="AI через локальний рантайм" label={s?.enabled ? "AI через локальний рантайм Claude Code" : "AI за правилами (рантайм вимкнено)"} onChange={(next) => toggle.mutate(next)} />
        {toggle.isError && <Alert tone="danger">{errorText(toggle.error)}</Alert>}
        {usable && <dl className="meta-list">
          <dt>Рантайм і модель</dt><dd>{s.runtime} · {s.model} · effort {s.effort}</dd>
          <dt>Викликів / помилок</dt><dd>{s.calls ?? 0} / {s.failures ?? 0}</dd>
          <dt>Остання відповідь</dt><dd>{s.last_ok_at ? `${formatDateTime(s.last_ok_at)} · ${((s.last_ms ?? 0) / 1000).toFixed(1)} с` : "ще не було"}</dd>
          {s.last_error && <><dt>Остання помилка</dt><dd>{s.last_error}</dd></>}
        </dl>}
        {s && !s.configured && <p className="hint">На сервері не задано адресу й токен містка (`UFV_RUNTIME_BRIDGE_URL`, `UFV_RUNTIME_BRIDGE_TOKEN`). Див. docs/LOCAL_RUNTIME.md.</p>}
        <p className="hint">Лише для демонстрацій: рантайм працює під обліковим записом того, хто веде демо, відповідь займає 5–30 с. У модель ідуть матеріали тільки з джерел, де ввімкнено «дозволено для AI»; чат отримує лише агреговані показники екрана. Кожне перемикання записується в журнал.</p>
      </div>
    </Card>
  );
}

export function Account({ me }: { me?: Me | undefined }) {
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
      <PageHeader title="Розробник" description="Режим AI для демонстрацій і безпека вашого входу." />
      {can(me, "collector", "manage") && <LocalRuntime />}
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
