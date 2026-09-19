import type { FormEvent } from "react";
import { Badge, Card, Field } from "../../components/ui";
import { send } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { runtimeStatus } from "../../lib/labels";
import { checked, field, type Channel, type TabProps } from "./types";

export function ChannelsTab({ state, workflowId, busy, run }: TabProps) {
  const own = state.channels.filter((c) => c.workflow_id === workflowId);
  const sessionLabel = (id: number) => state.accounts.find((a) => a.id === id)?.label || `Сесія ${id}`;

  async function update(event: FormEvent<HTMLFormElement>, channel: Channel) {
    event.preventDefault();
    const form = event.currentTarget;
    await run(async () => {
      await send(`/admin/channels/${channel.id}`, "PUT", { account_id: Number(field(form, "account_id")), enabled: checked(form, "enabled"), permission_note: field(form, "permission_note") });
    });
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = {
      username: field(form, "username"), account_id: Number(field(form, "account_id")), permission_note: field(form, "permission_note"),
      workflow_id: workflowId, enabled: checked(form, "enabled"),
    };
    if (await run(async () => { await send("/admin/channels", "POST", body); })) form.reset();
  }

  return (
    <div className="stack">
      <Card title="Джерела поточного workflow"
        description="Обирайте лише джерела, для яких дозволено збір і показ у проєкті. Підписка акаунта сама по собі не є дозволом на використання контенту. Масове додавання і явний вступ доступні в окремій вкладці." />

      {!own.length && <p className="loading">Каналів ще немає.</p>}

      {own.map((c) => {
        const status = runtimeStatus(c.status);
        return (
          <form className="card record" key={`${c.id}:${c.account_id}:${c.enabled}:${c.permission_note}`} onSubmit={(event) => update(event, c)}>
            <div className="stack">
              <div className="stack-sm">
                <div className="record-head"><span className="record-title">@{c.username}</span><Badge tone={status.tone} title={c.status} dot>{status.label}</Badge></div>
                <p className="note">Тип: {c.source_type || "визначається"} · Успішний збір: {formatDateTime(c.last_success_at, "ще немає")} · Остання спроба: {formatDateTime(c.last_polled_at, "ще немає")} · Позиція постів: {c.post_cursor}</p>
                {c.last_error && <p className="item-reason">{c.last_error}</p>}
              </div>
              <div className="form-grid">
                <Field label="Сесія">
                  <select name="account_id" defaultValue={c.account_id}>
                    {state.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </Field>
                <label className="check"><input type="checkbox" name="enabled" defaultChecked={c.enabled} />Збір цього каналу увімкнено</label>
                <Field label="Підстава використання" className="full"><input name="permission_note" defaultValue={c.permission_note} required minLength={10} maxLength={1000} /></Field>
                <div className="form-actions full"><button type="submit" className="btn btn-outline btn-sm" disabled={busy}>Зберегти канал</button></div>
              </div>
            </div>
          </form>
        );
      })}

      <Card title="Підключити публічний канал або групу">
        <form className="form-grid" onSubmit={create}>
          <Field label="Username джерела"><input name="username" placeholder="@назва_каналу" required pattern="@?[A-Za-z][A-Za-z0-9_]{3,31}" /></Field>
          <Field label="Сесія з доступом">
            <select name="account_id" required defaultValue="">
              <option value="">Оберіть сесію</option>
              {state.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </Field>
          <Field label="Підстава дозволеного використання, включно з коментарями" className="full">
            <textarea name="permission_note" required minLength={10} maxLength={1000} placeholder="Власний тестовий канал; учасники погодили збір і показ змісту повідомлень…" />
          </Field>
          <label className="check full"><input type="checkbox" name="enabled" defaultChecked />Увімкнути цей канал</label>
          <div className="form-actions full"><button type="submit" className="btn" disabled={busy}>Додати канал</button></div>
        </form>
      </Card>

      <Card title="Відомі підписки акаунтів" description="Максимум 1000 діалогів на сесію в тестовій версії.">
        {state.memberships.length
          ? state.memberships.map((m) => <div className="list-row" key={`${m.account_id}:${m.username}`}><strong>@{m.username}</strong><span className="spacer">{sessionLabel(m.account_id)}</span></div>)
          : <p className="hint">З’являться після підключення сесій.</p>}
      </Card>
    </div>
  );
}
