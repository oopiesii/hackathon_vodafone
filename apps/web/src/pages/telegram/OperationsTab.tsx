import { Badge, Card } from "../../components/ui";
import { formatDateTime } from "../../lib/format";
import { runtimeStatus } from "../../lib/labels";
import type { TabProps } from "./types";

export function OperationsTab({ state }: TabProps) {
  return (
    <div className="stack">
      <Card title="Фонові сервіси" description="Heartbeat показує, що процес живий; він не доводить успішний збір Telegram.">
        {state.services.length ? state.services.map((s) => (
          <div className="list-row" key={s.name}>
            <strong>{s.name}</strong><span>{s.detail}</span>
            <span className="time spacer">Останній heartbeat: {formatDateTime(s.heartbeat_at, "ще немає")}</span>
          </div>
        )) : <p className="hint">Сервіси ще не повідомили про стан.</p>}
      </Card>
      <Card title="Стан обговорень" description="Показано до 100 останніх гілок. Старі гілки також перевіряються по черзі. Час обходу залежить від їх кількості та FloodWait.">
        {state.threads.length ? state.threads.map((t) => {
          const status = runtimeStatus(t.status);
          return (
            <div className="list-row" key={t.id}>
              <span>Канал #{t.channel_id}, пост {t.post_id}</span>
              <Badge tone={status.tone} title={t.status}>{status.label}</Badge>
              <span>позиція коментарів {t.comment_cursor}</span>
              {t.last_error && <span>{t.last_error}</span>}
              <span className="time spacer">{formatDateTime(t.last_polled_at, "ще немає")}</span>
            </div>
          );
        }) : <p className="hint">Обговорень ще не зібрано.</p>}
      </Card>
      <Card title="Журнал змін" description="Останні 30 дій адміністраторів.">
        {state.audit.length ? state.audit.map((a, i) => (
          <div className="list-row" key={i}>
            <code>{a.action}</code><span>{a.object_type} {a.object_id || ""}</span>
            <span className="time spacer">{formatDateTime(a.occurred_at)}</span>
          </div>
        )) : <p className="hint">Журнал порожній.</p>}
      </Card>
      <p className="note">Пароль входу змінюється в розділі «Акаунт».</p>
    </div>
  );
}
