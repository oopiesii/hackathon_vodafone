import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Globe, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { api, send } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { brandName } from "../../lib/plural";
import { Badge, Card } from "../ui";

type Mention = { title: string; url: string; publisher: string; published_on: string; summary: string; brand: string };
type State = { result: { searched_at: string; seconds: number; items: Mention[] } | null; searching: boolean };
const day = (iso: string) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "дата невідома");

/** Свіжі згадки з інтернету: вебпошук локального рантайму. Це видача пошуку, а не зібрані матеріали, тому в метрики вона не входить. */
export function WebMentions() {
  const cache = useQueryClient();
  const runtime = useQuery({ queryKey: ["analyst-runtime"], queryFn: () => api<{ enabled: boolean }>("/analyst/runtime"), refetchInterval: 60_000 });
  const state = useQuery({ queryKey: ["web-mentions"], queryFn: () => api<State>("/analyst/web-mentions") });
  const search = useMutation({ mutationFn: () => send<State>("/analyst/web-mentions", "POST"), onSuccess: (next) => cache.setQueryData(["web-mentions"], next) });
  const live = runtime.data?.enabled === true, busy = search.isPending || state.data?.searching === true, result = state.data?.result;
  return (
    <Card className="span-12 context-card" title="Свіжі згадки з інтернету"
      actions={<><Badge tone="secondary" title="Результати вебпошуку не проходять збір, дедуплікацію й відбір, тому не входять до показників дашборда.">Пошук · поза метриками</Badge>
        <button type="button" className="btn btn-outline btn-sm" disabled={!live || busy} onClick={() => search.mutate()}><RefreshCw size={14} aria-hidden="true" />{busy ? "Шукаю…" : "Знайти свіже"}</button></>}
      footer={<span className="note context-source">Вебпошук локального рантайму Claude Code · заголовки й посилання з видачі пошуку, суть — одне речення моделі · перевіряйте за першоджерелом{result ? ` · знайдено ${formatDateTime(result.searched_at)} за ${result.seconds} с` : ""}</span>}>
      {!live && !result && <div className="chart-no-data"><span>Пошук працює через локальний рантайм. Увімкніть його у вкладці <Link to="/account">«Розробник»</Link>.</span></div>}
      {live && !result && !busy && !search.isError && <div className="chart-no-data">Натисніть «Знайти свіже»: рантайм знайде публікації про Vodafone Україна, Київстар і lifecell за останні 7 днів. Пошук триває до хвилини.</div>}
      {busy && <div className="chart-no-data" role="status"><Globe size={16} aria-hidden="true" />&nbsp;Шукаю в інтернеті… зазвичай 40–60 секунд.</div>}
      {search.isError && !busy && <div className="chart-no-data">Пошук не вдався: рантайм вимкнено або він не відповів. Спробуйте ще раз.</div>}
      {result && !busy && (result.items.length ? <ul className="web-mentions">{result.items.map((m) => <li key={m.url}>
        <span className="web-meta"><Badge tone={m.brand === "vodafone" ? "neutral" : "secondary"}>{brandName(m.brand)}</Badge><span>{day(m.published_on)}</span><span>{m.publisher}</span></span>
        <a href={m.url} target="_blank" rel="noopener noreferrer">{m.title}<ExternalLink size={12} aria-hidden="true" /></a>
        <span className="web-summary">{m.summary}</span>
      </li>)}</ul> : <div className="chart-no-data">За останні 7 днів пошук нічого не знайшов. Це результат пошуку, а не доказ, що публікацій не було.</div>)}
    </Card>
  );
}
