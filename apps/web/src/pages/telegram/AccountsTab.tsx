import { useEffect, useRef, useState, type FormEvent } from "react";
import { Badge, Card, Dialog, Field } from "../../components/ui";
import { send } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { runtimeStatus } from "../../lib/labels";
import { checked, field, type Account, type TabProps } from "./types";

const HASH = "[a-fA-F0-9]{32}";

export function AccountsTab({ state, busy, run }: TabProps) {
  const [editing, setEditing] = useState<Account | null>(null), [importOpen, setImportOpen] = useState(false);
  const [removing, setRemoving] = useState<Account | null>(null);
  const confirm = useRef<HTMLDialogElement>(null), importForm = useRef<HTMLFormElement>(null);

  // Після вибору акаунта форма відкривається й фокус стає на перше секретне поле.
  useEffect(() => {
    if (editing) (importForm.current?.elements.namedItem("api_hash") as HTMLInputElement | null)?.focus();
  }, [editing]);

  function edit(account: Account) { setEditing(account); setImportOpen(true); }

  async function saveCredentials(event: FormEvent<HTMLFormElement>, id: number) {
    event.preventDefault();
    const form = event.currentTarget;
    await run(async () => {
      await send(`/admin/accounts/${id}/credentials`, "POST", { api_id: Number(field(form, "api_id")), api_hash: field(form, "api_hash") });
      return "API-доступ збережено. Збирач перевіряє підключення.";
    });
  }
  async function saveSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = {
      label: field(form, "label"), api_id: Number(field(form, "api_id")), api_hash: field(form, "api_hash"),
      session: field(form, "session"), enabled: checked(form, "enabled"),
    };
    const saved = await run(async () => {
      await send("/admin/accounts" + (editing ? "/" + editing.id : ""), editing ? "PUT" : "POST", body);
      return "Сесію збережено. Для підключення увімкніть модуль.";
    });
    if (saved) { form.reset(); setEditing(null); }
  }

  return (
    <div className="stack">
      <Card title="Сесії Telegram"
        description={<>Один запис — окремий Telegram-акаунт. На сервері виконайте <code>.venv/bin/python scripts/create_session.py</code>: після входу сесія автоматично з’явиться тут. Не використовуйте одну сесію одночасно в іншій програмі.</>}
        actions={<button type="button" className="btn btn-outline" disabled={busy}
          onClick={() => run(async () => { await send("/admin/accounts/prepare", "POST"); return "Місця підготовлено. Кожен акаунт потрібно авторизувати окремо."; })}>Підготувати місця для двох акаунтів</button>} />

      {!state.accounts.length && <p className="loading">Акаунти ще не додані.</p>}

      {state.accounts.map((a) => {
        const status = runtimeStatus(a.status);
        const memberships = state.memberships.filter((m) => m.account_id === a.id);
        if (a.credentials_ready) return (
          <article className="card record" key={a.id}>
            <div className="stack-sm">
              <div className="record-head">
                <span className="record-title">{a.label}</span>
                <Badge tone={status.tone} title={a.status} dot>{status.label}</Badge>
              </div>
              <p className="note">API ID: {a.api_id} · {a.enabled ? "Дозволено" : "Вимкнено"} · Перевірено: {formatDateTime(a.checked_at, "ще немає")}</p>
              {a.last_error && (
                <p className="item-reason">
                  {a.last_error}
                  {a.cooldown_until && a.cooldown_until > Date.now() / 1000 ? ` · Повторне підключення після ${formatDateTime(a.cooldown_until)}` : ""}
                </p>
              )}
              <div className="row">
                <button type="button" className="btn btn-outline btn-sm" disabled={busy}
                  onClick={() => run(async () => { await send(`/admin/accounts/${a.id}/toggle`, "POST", { enabled: !a.enabled }); })}>{a.enabled ? "Вимкнути" : "Увімкнути"}</button>
                <button type="button" className="btn btn-outline btn-sm" disabled={busy}
                  onClick={() => run(async () => { await send(`/admin/accounts/${a.id}/refresh`, "POST"); return "Оновлення заплановано; виконається при ввімкненому модулі."; })}>Оновити підписки</button>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => edit(a)}>Замінити ключі / сесію</button>
                <button type="button" className="btn btn-destructive btn-sm spacer" disabled={busy} onClick={() => { setRemoving(a); confirm.current?.showModal(); }}>Видалити</button>
              </div>
              <details>
                <summary>Публічні канали в підписках{memberships.length ? ` · ${memberships.length}` : ""}</summary>
                {memberships.length
                  ? memberships.map((m) => <div className="list-row" key={m.username}><strong>@{m.username}</strong><span>{m.title}</span></div>)
                  : <p className="hint">Підключіть сесію для перевірки публічних каналів. Читатимуться лише канали, які ви явно додасте.</p>}
              </details>
            </div>
          </article>
        );
        if (a.has_session) return (
          <article className="card record" key={a.id}>
            <div className="stack">
              <div className="record-head"><span className="record-title">{a.label}</span><Badge tone="warning" dot>Сесію збережено · потрібен API-доступ</Badge></div>
              <p className="hint">Авторизацію Telegram вже збережено на сервері. Повторно вводити номер, код чи StringSession не потрібно. Додайте лише API ID/hash, з якими створено сесію.</p>
              <form className="form-grid" onSubmit={(event) => saveCredentials(event, a.id)}>
                <Field label="API ID"><input name="api_id" type="number" min={1} required /></Field>
                <Field label="API hash"><input name="api_hash" type="password" autoComplete="off" pattern={HASH} required /></Field>
                <div className="form-actions full"><button type="submit" className="btn" disabled={busy}>Завершити підключення</button></div>
              </form>
            </div>
          </article>
        );
        return (
          <article className="card record" key={a.id}>
            <div className="stack-sm">
              <div className="record-head"><span className="record-title">{a.label}</span><Badge tone="warning" dot>Очікує авторизації</Badge></div>
              <p className="hint">На сервері виконайте команду нижче. Після входу цей акаунт підключиться до системи автоматично.</p>
              <code className="cmd">.venv/bin/python scripts/create_session.py --account {a.id}</code>
              <div className="row"><button type="button" className="btn btn-outline btn-sm" onClick={() => edit(a)}>Імпорт готової сесії</button></div>
            </div>
          </article>
        );
      })}

      <Card>
        <details open={importOpen} onToggle={(event) => setImportOpen(event.currentTarget.open)}>
          <summary>Імпорт готової сесії / заміна ключів</summary>
          <form ref={importForm} key={editing?.id ?? "new"} className="form-grid details-body" onSubmit={saveSession} onReset={() => setEditing(null)}>
            <h3 className="full">{editing ? (editing.credentials_ready ? "Замінити ключі та сесію: " : "Підключити: ") + editing.label : "Імпортувати наявну сесію"}</h3>
            <Field label="Назва сесії" className="full"><input name="label" defaultValue={editing?.label ?? ""} required maxLength={80} placeholder="Моніторинг — акаунт 1" /></Field>
            <Field label="Telegram API ID"><input name="api_id" type="number" min={1} defaultValue={editing?.api_id ?? ""} required /></Field>
            <Field label="API hash"><input name="api_hash" type="password" autoComplete="off" required pattern={HASH} /></Field>
            <Field label="Telethon StringSession" className="full"><textarea name="session" autoComplete="off" spellCheck={false} required minLength={100} maxLength={1000} /></Field>
            <label className="check full"><input type="checkbox" name="enabled" defaultChecked={editing?.credentials_ready ? editing.enabled : true} />Дозволити підключення цієї сесії</label>
            <p className="hint full">Основний спосіб: на сервері UFV виконайте <code>.venv/bin/python scripts/create_session.py</code>. Скрипт сам збереже сесію та API-доступ у системі. Ця форма потрібна лише для імпорту вже наявної сесії з іншої машини.</p>
            <div className="form-actions full">
              <button type="submit" className="btn" disabled={busy}>Зберегти сесію</button>
              <button type="reset" className="btn btn-ghost">Очистити</button>
            </div>
          </form>
        </details>
      </Card>

      <Dialog ref={confirm} title="Видалити сесію?" titleId="remove-account-title"
        footer={<>
          <button type="button" className="btn btn-outline" onClick={() => confirm.current?.close()}>Скасувати</button>
          <button type="button" className="btn btn-destructive" disabled={busy}
            onClick={() => { const id = removing?.id; confirm.current?.close(); if (id) void run(async () => { await send(`/admin/accounts/${id}`, "DELETE"); }); }}>Видалити ключі</button>
        </>}>
        <p>Збережені ключі сесії «{removing?.label}» буде видалено із системи. Це не відкликає її в Telegram.</p>
      </Dialog>
    </div>
  );
}
