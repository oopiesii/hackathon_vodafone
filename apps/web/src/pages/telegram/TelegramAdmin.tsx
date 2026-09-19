import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Alert, Card, Field, PageHeader, Switch, Tabs } from "../../components/ui";
import { api, errorText, send } from "../../lib/api";
import { AccountsTab } from "./AccountsTab";
import { BulkTab } from "./BulkTab";
import { WatchTab } from "./WatchTab";
import { ChannelsTab } from "./ChannelsTab";
import { OperationsTab } from "./OperationsTab";
import { SharesTab } from "./SharesTab";
import { WorkflowsTab } from "./WorkflowsTab";
import type { AdminState } from "./types";

const TABS = [
  { value: "accounts", label: "Сесії" },
  { value: "channels", label: "Джерела" },
  { value: "bulk", label: "Масове додавання" },
  { value: "watch", label: "Стеження" },
  { value: "workflows", label: "Workflow" },
  { value: "shares", label: "Доступи" },
  { value: "operations", label: "Стан" },
] as const;
type Tab = (typeof TABS)[number]["value"];

export function TelegramAdmin() {
  const cache = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.find((t) => t.value === params.get("tab"))?.value ?? "accounts";
  const state = useQuery({ queryKey: ["telegram-state"], queryFn: () => api<AdminState>("/admin/state"), refetchInterval:5000 });
  const [selected, setSelected] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<string | void>) {
    setBusy(true);
    try {
      const message = await action();
      await state.refetch();
      void cache.invalidateQueries({ queryKey: ["source-state"] });
      void cache.invalidateQueries({ queryKey: ["workflows"] });
      setNotice({ tone: "success", text: message || "Збережено." });
      return true;
    } catch (e) {
      setNotice({ tone: "danger", text: errorText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const data = state.data;
  const workflowId = selected ?? data?.workflows[0]?.id ?? 1;
  const props = data && { state: data, workflowId, busy, run };
  return (
    <>
      <PageHeader
        breadcrumb={<nav className="breadcrumb" aria-label="Шлях"><Link to="/sources">Sources</Link><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">Telegram</span></nav>}
        title="Telegram"
        description="Акаунти, канали, workflow і доступи за посиланням. Ключі шифруються на сервері й не повертаються в браузер."
        actions={<button type="button" className="btn btn-outline" disabled={busy || state.isFetching} onClick={() => run(async () => "Стан оновлено.")}><RefreshCw size={16} aria-hidden="true" />Оновити</button>}
      />
      {notice && <Alert tone={notice.tone} sticky>{notice.text}</Alert>}
      {state.isPending && <p className="loading" role="status">Завантаження…</p>}
      {state.isError && <Alert tone="danger">{errorText(state.error)}</Alert>}
      {data && props && (
        <>
          <Card title="Telegram-модуль" description={data.telegram_enabled ? "Увімкнено · статус кожної сесії наведено у вкладці «Сесії»." : "Вимкнено в налаштуваннях · worker зупиняє підключення."}
            actions={<Switch checked={data.telegram_enabled} disabled={busy} ariaLabel="Збір Telegram" label={data.telegram_enabled ? "Збір увімкнено" : "Збір вимкнено"}
              onChange={(enabled) => run(async () => { await send("/admin/module", "POST", { enabled }); })} />}>
            <div className="form-grid">
              <Field label="Workflow" hint="Канали, доступи та параметри нижче стосуються обраного workflow.">
                <select value={workflowId} onChange={(e) => setSelected(Number(e.target.value))}>
                  {data.workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </Field>
              <p className="note">
                Зміни підхоплює окремий worker із перевіркою кожні 2 секунди. Поточний запит може завершитися перед зупинкою.
                Позиції збору зберігаються. FloodWait не обходиться іншими сесіями.
              </p>
            </div>
          </Card>
          <Tabs label="Налаштування" items={[...TABS]} value={tab} onChange={(next) => setParams({ tab: next })} />
          {tab === "accounts" && <AccountsTab {...props} />}
          {tab === "channels" && <ChannelsTab {...props} />}
          {tab === "bulk" && <BulkTab key={workflowId} {...props} />}
          {tab === "watch" && <WatchTab {...props} />}
          {tab === "workflows" && <WorkflowsTab {...props} />}
          {tab === "shares" && <SharesTab {...props} />}
          {tab === "operations" && <OperationsTab {...props} />}
        </>
      )}
    </>
  );
}
