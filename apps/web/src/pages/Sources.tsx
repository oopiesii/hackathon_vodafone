import { RssCard } from './RssSources';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { Link } from "react-router";
import { Alert, Badge, Card, PageHeader, Switch } from "../components/ui";
import { api, errorText, send } from "../lib/api";
import { formatDateTime } from "../lib/format";

type SourceState = {
  telegram_enabled: boolean;
  accounts: { id: number; label: string; credentials_ready: boolean; status: string }[];
  channels: { id: number; enabled: boolean }[];
  services: { name: string; heartbeat_at: string; detail: string }[];
};

export function Sources() {
  const cache = useQueryClient();
  const state = useQuery({ queryKey: ["source-state"], queryFn: () => api<SourceState>("/admin/state"), refetchInterval: 10000 });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => send("/admin/module", "POST", { enabled }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["source-state"] }),
  });
  const data = state.data;
  const heartbeat = data?.services.find((s) => s.name === "collector-telegram");
  const ready = data?.accounts.filter((a) => a.credentials_ready).length ?? 0;
  return (
    <>
      <PageHeader title="Sources" description="Керуйте кожним сервісом окремо. Усередині Telegram оберіть акаунти та явно вкажіть публічні канали або групи для збору." />
      {state.isPending && <p className="loading" role="status">Завантаження джерел…</p>}
      {state.isError && <Alert tone="danger">{errorText(state.error)}</Alert>}
      {toggle.isError && <Alert tone="danger">Не вдалося змінити стан: {errorText(toggle.error)}</Alert>}
      {data && (
        <div className="source-grid">
          <Card
            title={<span className="row"><span className="source-icon"><Send size={16} aria-hidden="true" /></span>Telegram</span>}
            actions={<Badge tone="secondary">Telethon</Badge>}
            footer={<>
              <Link className="btn" to="/sources/telegram?tab=accounts">Налаштувати Telegram</Link>
              <Link className="btn btn-outline" to="/sources/telegram?tab=channels">Джерела</Link>
            </>}>
            <div className="stack">
              <p>Пости каналів, коментарі, публічні групи й форуми. Масове підключення, історія метрик та кероване стеження за обговореннями.</p>
              <Switch checked={data.telegram_enabled} disabled={toggle.isPending} ariaLabel="Збір Telegram"
                label={data.telegram_enabled ? "Збір увімкнено" : "Збір вимкнено"} onChange={(next) => toggle.mutate(next)} />
              <dl className="facts">
                <div><dt>Збережено сесій</dt><dd>{ready}</dd></div>
                <div><dt>Очікують підключення</dt><dd>{data.accounts.length - ready}</dd></div>
                <div><dt>Додано джерел</dt><dd>{data.channels.length}</dd></div>
              </dl>
              <p className="note">
                {heartbeat ? `Останній сигнал збирача: ${formatDateTime(heartbeat.heartbeat_at)}.` : "Збирач ще не повідомив про свій стан."}{" "}
                Перемикач задає бажаний стан; фактичні підключення видно в налаштуваннях.
              </p>
            </div>
          </Card>
          <RssCard />
        </div>
      )}
      <Card title="Що потрапляє до платформи" footer={<Link className="btn btn-outline btn-sm" to="/inbox">Відкрити весь вхід</Link>}>
        <p className="hint">
          Акаунт надає доступ. Канал визначає, звідки збирати. Workflow визначає налаштування обробки.
          Ключові слова фільтрують зібраний текст — вони не підключають нові канали автоматично.
        </p>
      </Card>
    </>
  );
}
