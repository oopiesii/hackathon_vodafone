import { Badge, Card } from "../../components/ui";
import { formatDateTime } from "../../lib/format";
import { runtimeStatus } from "../../lib/labels";
import { auditActions, auditObjects, diagnosticLabel, serviceDetailLabel, serviceNames } from "../../lib/operations-diagnostics";
import type { TabProps } from "./types";

function TechnicalDetails({ entries }: { entries: { label: string; value: string }[] }) {
  if (!entries.length) return null;
  return (
    <details className="note">
      <summary>Технічні деталі</summary>
      {entries.map(({ label, value }) => <p key={label}>{label}: <code>{value || "(порожньо)"}</code></p>)}
    </details>
  );
}

export function OperationsTab({ state }: TabProps) {
  return (
    <div className="stack">
      <Card title="Фонові сервіси" description="Час останнього сигналу показує, коли процес повідомив про себе; це не підтвердження успішного збору Telegram.">
        {state.services.length ? state.services.map((s) => {
          const name = diagnosticLabel(serviceNames, s.name);
          const detail = serviceDetailLabel(s.name, s.detail);
          return (
            <div className="list-row" key={s.name}>
              <strong>{name ?? "Технічний стан"}</strong>
              {(name || detail) && <span>{detail ?? "Технічний стан"}</span>}
              <span className="time spacer">Останній сигнал: {formatDateTime(s.heartbeat_at, "ще немає")}</span>
              <TechnicalDetails entries={[
                ...(!name ? [{ label: "Сервіс", value: s.name }] : []),
                ...(!detail ? [{ label: "Стан", value: s.detail }] : []),
              ]} />
            </div>
          );
        }) : <p className="hint">Сервіси ще не повідомили про стан.</p>}
      </Card>
      <Card title="Стан обговорень" description="Показано до 100 останніх гілок. Старі гілки також перевіряються по черзі. Час обходу залежить від їх кількості та FloodWait.">
        {state.threads.length ? state.threads.map((t) => {
          const status = runtimeStatus(t.status);
          return (
            <div className="list-row" key={t.id}>
              <span>Канал #{t.channel_id}, пост {t.post_id}</span>
              <Badge tone={status.tone} title={t.status}>{status.label}</Badge>
              <span>позиція коментарів {t.comment_cursor}</span>
              {t.last_error && <TechnicalDetails entries={[{ label: "Помилка", value: t.last_error }]} />}
              <span className="time spacer">{formatDateTime(t.last_polled_at, "ще немає")}</span>
            </div>
          );
        }) : <p className="hint">Обговорень ще не зібрано.</p>}
      </Card>
      <Card title="Журнал змін" description="Останні 30 дій адміністраторів.">
        {state.audit.length ? state.audit.map((a, i) => {
          const action = diagnosticLabel(auditActions, a.action);
          const object = diagnosticLabel(auditObjects, a.object_type);
          return (
            <div className="list-row" key={i}>
              <span>{action ?? "Технічний стан"}</span>
              <span>{object ?? (action ? "Технічний стан" : "Об’єкт")}{a.object_id !== null && <> #{a.object_id}</>}</span>
              <span className="time spacer">{formatDateTime(a.occurred_at)}</span>
              <TechnicalDetails entries={[
                ...(!action ? [{ label: "Дія", value: a.action }] : []),
                ...(!object ? [{ label: "Об’єкт", value: a.object_type }] : []),
              ]} />
            </div>
          );
        }) : <p className="hint">Журнал порожній.</p>}
      </Card>
      <p className="note">Пароль входу змінюється в розділі «Акаунт».</p>
    </div>
  );
}
