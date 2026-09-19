import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Alert, Badge, Card, Dialog, Field, Switch } from "./ui";
import { api, errorText, send } from "../lib/api";
import { formatDateTime } from "../lib/format";

type Source = { id: string; title: string; kind: string; llm_allowed: boolean; llm_basis: string | null; rights_status: string | null };
type State = { heartbeat_at: string | null; mode: "waiting_key" | "active" | "rate_limited" | "error"; model: string | null; last_error: string | null; limit_per_hour: number; items_last_hour: number; sources: Source[] };
const modes = { waiting_key: "AI очікує ключ", active: "AI працює", rate_limited: "Досягнуто ліміту", error: "Потрібна перевірка" };
export function AiSources() {
  const cache = useQueryClient(), dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<Source | null>(null), [enabled, setEnabled] = useState(false), [basis, setBasis] = useState(""), [filter, setFilter] = useState("");
  const state = useQuery({ queryKey: ["ai-status"], queryFn: () => api<State>("/admin/ai/status"), refetchInterval: 10000 });
  const save = useMutation({ mutationFn: () => send(`/admin/ai/sources/${selected?.id}`, "PUT", { llm_allowed: enabled, llm_basis: basis }), onSuccess: () => { dialog.current?.close(); void cache.invalidateQueries({ queryKey: ["ai-status"] }); } });
  const edit = (source: Source, next: boolean) => { setSelected(source); setEnabled(next); setBasis(source.llm_basis || ""); save.reset(); dialog.current?.showModal(); };
  const data = state.data, sources = data?.sources.filter(s => `${s.title} ${s.kind}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) || [];
  const age = data?.heartbeat_at ? Date.now() - new Date(data.heartbeat_at).getTime() : Infinity;
  const fresh = Number.isFinite(age) && age >= -60000 && age < 300000;
  return <>
    <Card title="AI-аналітик" actions={<Badge tone={fresh && data?.mode === "active" ? "success" : "secondary"}>{data ? fresh ? modes[data.mode] : "Немає свіжого сигналу" : state.isError ? "Стан невідомий" : "Завантаження"}</Badge>}>
      <div className="stack">
        {state.isError && <Alert tone="danger">{errorText(state.error)}</Alert>}
        {data && <><p>Розмітка змісту й зведення лише для дозволених джерел. Без ключа нові виклики AI не виконуються; збережені результати семантичного відбору залишаються чинними для актуальних версій матеріалів.</p><dl className="facts"><div><dt>Останній сигнал</dt><dd>{formatDateTime(data.heartbeat_at)}</dd></div><div><dt>Модель</dt><dd>{data.model || "Не налаштована"}</dd></div><div><dt>Ліміт за годину</dt><dd>{data.items_last_hour} / {data.limit_per_hour}</dd></div></dl>
          {!fresh && <p className="note">Стан сервісу зараз не підтверджено. Останній відомий режим: {modes[data.mode].toLocaleLowerCase()}.</p>}
          {data.last_error && <Alert tone="danger">Останній виклик не завершився. Перевірте конфігурацію провайдера та його доступність.</Alert>}
          <details><summary>Дозволи джерел · {data.sources.filter(s => s.llm_allowed).length} увімкнено</summary><div className="stack ai-source-list"><Field label="Знайти джерело"><input type="search" value={filter} onChange={e => setFilter(e.target.value)} /></Field>{sources.map(source => <div className="ai-source-row" key={source.id}><div><strong>{source.title}</strong><small>{source.kind === "telegram" ? "Telegram" : "RSS"}{source.kind === "rss" && source.rights_status !== "allowed" ? " · немає дозволу" : ""}</small></div><Switch checked={source.llm_allowed} ariaLabel={`AI: ${source.title}`} label={source.llm_allowed ? "Дозволено" : "Вимкнено"} disabled={!source.llm_allowed && source.kind === "rss" && source.rights_status !== "allowed"} onChange={next => edit(source, next)} /></div>)}{!sources.length && <p className="hint">Джерел за цим запитом немає.</p>}</div></details>
          <p className="note">Підстава й зміни дозволів потрапляють у журнал аудиту. Дозвіл на збір і дозвіл на передачу моделі — окремі рішення.</p></>}
      </div>
    </Card>
    <Dialog ref={dialog} title={enabled ? "Дозволити AI-обробку джерела" : "Відкликати дозвіл AI"} titleId="ai-source-title"><form className="stack" onSubmit={e => { e.preventDefault(); save.mutate(); }}><p><strong>{selected?.title}</strong></p><p className="hint">{enabled ? "Нормалізований зміст і потрібний контекст цього джерела передаватимуться налаштованому провайдеру моделі." : "Нові виклики для джерела припиняться. Уже надісланий провайдеру запит відкликати неможливо."}</p><Field label="Підстава рішення" hint={enabled ? "Вкажіть дозвіл або конкретну підставу передачі змісту моделі (щонайменше 10 символів)." : "За потреби додайте причину відкликання."}><textarea required={enabled} minLength={enabled ? 10 : undefined} maxLength={1000} rows={4} value={basis} onChange={e => setBasis(e.target.value)} /></Field>{save.isError && <Alert tone="danger">{errorText(save.error)}</Alert>}<button className="btn" disabled={save.isPending || (enabled && basis.trim().length < 10)}>{save.isPending ? "Зберігаємо…" : enabled ? "Зберегти дозвіл" : "Відкликати дозвіл"}</button></form></Dialog>
  </>;
}
