import { Copy } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge, Card, Field } from "../../components/ui";
import { send } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { TOPICS } from "../../lib/labels";
import type { TabProps } from "./types";

const SCOPES = { summary: "Зведення", posts: "Пости", full: "Пости й коментарі" };
function selectionLabel(raw: string, label: (value: string) => string) {
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.some(value => typeof value !== "string" && typeof value !== "number")) return "Невідомо";
    return values.length ? values.map(value => label(String(value))).join(", ") : "Усі";
  } catch { return "Невідомо"; }
}

export function SharesTab({ state, workflowId, busy, run }: TabProps) {
  const [link, setLink] = useState("");
  const shares = state.shares.filter((s) => s.workflow_id === workflowId);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form);
    const saved = await run(async () => {
      const result = await send<{ url: string }>("/admin/shares", "POST", {
        workflow_id: workflowId, name: data.get("name"), scope: data.get("scope"), expires_days: Number(data.get("expires_days")),
        channel_ids: data.getAll("channel_ids").map(Number), topics: data.getAll("topics"),
      });
      setLink(location.origin + result.url);
      return "Доступ створено.";
    });
    if (saved) form.reset();
  }

  return (
    <div className="stack">
      <Card title="Посилання на dashboard"
        description="Кожне посилання — окрема гілка доступу до поточного workflow. Той, хто має посилання, може бачити дозволені дані до відкликання або завершення строку.">
        {shares.length ? shares.map((s) => {
          const expired = s.expires_at * 1000 <= Date.now();
          return (
          <div className="list-row" key={s.id}>
            <strong>{s.name}</strong>
            <Badge tone="secondary">{SCOPES[s.scope] ?? s.scope}</Badge>
            <Badge tone={s.revoked || expired ? "secondary" : "success"} dot>{s.revoked ? "Відкликано" : expired ? "Строк минув" : "Активне"}</Badge>
            <span className="time">До {formatDateTime(s.expires_at)} · Канали: {selectionLabel(s.channel_ids, id => { const channel = state.channels.find(c => String(c.id) === id); return channel ? `@${channel.username}` : `Канал #${id}`; })} · Теми: {selectionLabel(s.topics, topic => TOPICS[topic] || "Інша тема")}</span>
            {!s.revoked && !expired && (
              <button type="button" className="btn btn-destructive btn-sm spacer" disabled={busy}
                onClick={() => run(async () => { await send(`/admin/shares/${s.id}`, "DELETE"); return "Доступ відкликано, активні сеанси за посиланням завершено."; })}>Відкликати доступ</button>
            )}
          </div>
        ); }) : <p className="hint">Посилань ще немає.</p>}
      </Card>

      {link && (
        <Card title="Нове посилання" description="Збережіть посилання зараз — воно показується один раз.">
          <div className="row">
            <input className="grow" readOnly value={link} aria-label="Посилання на dashboard" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn btn-outline" onClick={() => run(async () => { await navigator.clipboard.writeText(link); return "Посилання скопійовано."; })}><Copy size={16} aria-hidden="true" />Скопіювати</button>
          </div>
        </Card>
      )}

      <Card title="Створити посилання">
        <form className="form-grid" onSubmit={create}>
          <Field label="Назва доступу"><input name="name" required maxLength={120} placeholder="PR-команда / регіон" /></Field>
          <Field label="Деталізація">
            <select name="scope" defaultValue="summary">
              <option value="summary">Лише зведення</option>
              <option value="posts">Пости й джерела</option>
              <option value="full">Пости, коментарі й контекст</option>
            </select>
          </Field>
          <Field label="Строк дії, днів" className="full"><input name="expires_days" type="number" min={1} max={90} defaultValue={7} required /></Field>
          <Field label="Канали" hint="Не обрано = всі в workflow.">
            <select name="channel_ids" multiple size={4}>
              {state.channels.filter((c) => c.workflow_id === workflowId).map((c) => <option key={c.id} value={c.id}>@{c.username}</option>)}
            </select>
          </Field>
          <Field label="Теми" hint="Не обрано = всі.">
            <select name="topics" multiple size={6}>
              {Object.entries(TOPICS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </Field>
          <p className="note full">Відсіяні й неперевірені повідомлення доступні адміністратору й аналітику після входу. Ключі та сесії ніколи не доступні за посиланнями.</p>
          <div className="form-actions full"><button type="submit" className="btn" disabled={busy}>Створити доступ</button></div>
        </form>
      </Card>
    </div>
  );
}
