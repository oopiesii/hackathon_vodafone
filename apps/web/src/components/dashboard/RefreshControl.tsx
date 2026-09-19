import type { RefreshRequest } from "@ufv/shared/dashboard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { Alert, Badge } from "../ui";
import { api, errorText, send } from "../../lib/api";
import { formatDateTime } from "../../lib/format";

const labels = { pending: "У черзі", running: "Збираємо", completed: "Зібрано", deferred: "Відкладено", disabled: "Збір вимкнено", failed: "Помилка збору" } as const;
const active = (r: RefreshRequest) => r.status === "pending" || r.status === "running";
const progressing = (r: RefreshRequest) => active(r) && !r.stale && r.collector_online !== false;
export function RefreshControl({ workflow, admin, fetching, refetch }: { workflow: string; admin: boolean; fetching: boolean; refetch: () => void }) {
  const cache = useQueryClient(), previous = useRef<string | null>(null);
  const key = ["refresh-requests", workflow];
  const requests = useQuery({ queryKey: key, queryFn: () => api<{ requests: RefreshRequest[] }>(`/admin/refresh?workflow_id=${encodeURIComponent(workflow)}`), enabled: admin,
    refetchInterval: q => q.state.data?.requests.some(progressing) ? 2000 : 30000 });
  const refresh = useMutation({ mutationFn: () => send<{ requests: RefreshRequest[] }>("/admin/refresh", "POST", { workflow_id: workflow }),
    onSuccess: result => { cache.setQueryData(key, result); refetch(); } });
  const latest = ["telegram", "rss"].flatMap(service => requests.data?.requests.find(r => r.service === service) ?? []);
  const revision = latest.map(r => `${r.id}:${r.status}`).join("|");
  useEffect(() => {
    if (previous.current !== null && previous.current !== revision) void cache.invalidateQueries({ queryKey: ["dashboard", workflow] });
    previous.current = revision;
  }, [revision, workflow, cache]);
  const pending = refresh.isPending || latest.some(progressing), stalled = latest.some(r => active(r) && !progressing(r));
  return <div className="refresh-control">
    <button className="btn btn-outline" type="button" onClick={() => admin ? refresh.mutate() : refetch()} disabled={pending || fetching}><RefreshCw size={16} aria-hidden="true" />{pending ? "Оновлення триває…" : stalled ? "Перевірити оновлення" : admin ? "Оновити зараз" : "Оновити дані"}</button>
    {admin && latest.length > 0 && <details className="refresh-details"><summary>Перебіг збору</summary><div className="stack" aria-live="polite">{latest.map(r => <div key={r.id}><div className="row"><strong>{r.service === "telegram" ? "Telegram" : "RSS"}</strong><Badge tone={r.status === "completed" ? "success" : r.status === "failed" ? "danger" : "secondary"}>{active(r) && !progressing(r) ? r.collector_online === false ? "Очікує збирача" : "Очікує завершення" : labels[r.status]}</Badge></div><p className="hint">{r.detail || "Очікуємо, поки збирач прийме запит."}</p><small>{formatDateTime(r.completed_at || r.started_at || r.requested_at)}</small></div>)}<p className="hint">Ліміти джерел збережено. Після збору обробка й AI можуть тривати окремо.</p></div></details>}
    {(refresh.isError || requests.isError) && <Alert tone="danger">{errorText(refresh.error || requests.error)}</Alert>}
  </div>;
}
