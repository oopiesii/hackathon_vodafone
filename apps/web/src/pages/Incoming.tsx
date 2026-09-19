import { TelegramEvidence, type TelegramDetail } from "../components/TelegramEvidence";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Inbox, RefreshCw, Search } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Alert, Badge, Dialog, Empty, Field, PageHeader, Section, Tabs } from "../components/ui";
import { api, can, errorText, send, type Me } from "../lib/api";
import { excerpt, formatDate, formatDateTime } from "../lib/format";
import { ITEM_STATES } from "../lib/labels";

type Item = {
  id: string; source_id: string; workflow_id: string; account_label: string | null; channel_title: string; workflow_name: string;
  source_kind:string; content_scope:string; kind: string; text: string; url: string | null; published_at: string | null; fetched_at: string; edited_at: string | null;
  analyzed_at: string | null; state: string; reason: string; mention_id: string | null; version: number;
};
type InboxData = {
  items: Item[]; counts: { state: string; count: number }[];
  sources: { id: string; workflow_id: string; external_id: string; kind:string; title:string|null }[]; next_before: string | null;
};

export function Incoming({ me }: { me: Me | undefined }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const workflow = searchParams.get("workflow_id") || "all", source = searchParams.get("source_id") || "all", state = searchParams.get("state") || "all";
  const q = searchParams.get("q") || "", kind = searchParams.get("kind") || "", before = searchParams.get("before") || "";
  const setField = (key: string) => (value: string) => {
    setSearchParams(previous => { const next = new URLSearchParams(previous); value ? next.set(key, value) : next.delete(key); if (key !== "before") next.delete("before"); if (key === "workflow_id") next.delete("source_id"); return next; });
  };
  const setWorkflow = setField("workflow_id"), setSource = setField("source_id"), setState = setField("state"), setQ = setField("q"), setKind = setField("kind"), setBefore = setField("before");
  const scoped = searchParams.has("from") || searchParams.has("until");
  const dashboardBack = "/?" + new URLSearchParams({ workflow_id: workflow === "all" ? "1" : workflow, window: searchParams.get("window") || "24h" });
  const [detail, setDetail] = useState<{ item: Item; parent: Item | null; telegram?:TelegramDetail } | null>(null), [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const params = new URLSearchParams(searchParams);
  Object.entries({ workflow_id: workflow, source_id: source, state, q, kind, before }).forEach(([key, value]) => params.set(key, value));
  const incoming = useQuery({ queryKey: ["inbox", params.toString()], queryFn: () => api<InboxData>("/inbox?" + params), refetchInterval: 5000 });
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: () => api<{ items: { id: string; name: string }[] }>("/workflows") });
  const counts = Object.fromEntries((incoming.data?.counts || []).map((c) => [c.state, c.count]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  async function open(id: string) {
    setError("");
    try {
      setDetail(await api("/inbox/" + id));
      dialog.current?.showModal();
    } catch (e) { setError(errorText(e, "Не вдалося відкрити матеріал.")); }
  }
  async function review(decision: string) {
    if (!detail?.item.mention_id) return;
    try {
      await send(`/admin/documents/${detail.item.mention_id}/review`, "POST", { decision });
      dialog.current?.close();
      await incoming.refetch();
    } catch (e) { setError(errorText(e, "Не вдалося зберегти рішення.")); }
  }

  const reviewable = detail && can(me, "collector", "manage") && detail.item.mention_id && !["pending", "deleted"].includes(detail.item.state);
  return (
    <>
      <PageHeader
        title="Увесь вхід"
        breadcrumb={<Link className="btn btn-ghost btn-sm" to={dashboardBack}>До дашборда</Link>}
        description="Пости, коментарі й повідомлення груп з усіх явно підключених джерел, включно з відсіяним і чергою обробки. Це не всі чати Telegram-акаунтів. Контактні дані маскуються до збереження."
        actions={<button type="button" className="btn btn-outline" onClick={() => incoming.refetch()} disabled={incoming.isFetching}><RefreshCw size={16} aria-hidden="true" />Оновити</button>}
      />

      {scoped && <div className="feed-scope"><Badge tone="info">Зріз із дашборда</Badge><span>{formatDateTime(searchParams.get("from"))} – {formatDateTime(searchParams.get("until"))}</span><button className="btn btn-ghost btn-sm" type="button" onClick={() => setSearchParams({ workflow_id: workflow, state })}>Скинути зріз</button></div>}
      <p className="note">Стани первинної обробки. Фінальний семантичний відбір показано у <Link to="/feed">стрічці</Link>; її склад і кількість можуть відрізнятися.</p>
      <Tabs label="Стан первинної обробки" value={state} onChange={(next) => { setState(next); }}
        items={[
          { value: "all", label: "Увесь вхід", count: incoming.data ? total : "—" },
          ...Object.entries(ITEM_STATES).map(([key, s]) => ({ value: key, label: s.label, count: incoming.data ? counts[key] || 0 : "—" })),
        ]} />

      <div className="toolbar">
        <Field label="Пошук у тексті" className="toolbar-wide">
          <span className="search">
            <Search size={16} aria-hidden="true" />
            <input type="search" value={q} onChange={(e) => { setQ(e.target.value); }} placeholder="Зокрема у відсіяному…" />
          </span>
        </Field>
        <Field label="Workflow">
          <select value={workflow} onChange={(e) => { setWorkflow(e.target.value); }}>
            <option value="all">Усі workflow</option>
            {workflows.data?.items.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
        <Field label="Джерело">
          <select value={source} onChange={(e) => { setSource(e.target.value); }}>
            <option value="all">Усі джерела</option>
            {incoming.data?.sources.filter((s) => workflow === "all" || s.workflow_id === workflow).map((s) => <option key={s.id} value={s.id}>{s.kind==='rss'?(s.title||s.external_id):'@'+s.external_id}</option>)}
          </select>
        </Field>
        <Field label="Тип">
          <select value={kind} onChange={(e) => { setKind(e.target.value); }}>
            <option value="">Усі типи</option>
            <option value="post">Пости</option>
            <option value="comment">Коментарі</option><option value="group_message">Повідомлення груп</option>
          </select>
        </Field>
      </div>

      {incoming.isPending && <p className="loading" role="status">Завантаження вхідних матеріалів…</p>}
      {(error || incoming.isError) && <Alert tone="danger">{error || errorText(incoming.error)}</Alert>}

      {incoming.data && !incoming.data.items.length && (
        <Empty icon={<Inbox size={20} />} title="За цими фільтрами матеріалів немає">
          <p>Підключіть RSS або Telegram-джерело та увімкніть його workflow і модуль.</p>
          {can(me, "collector", "manage") && <Link className="btn btn-outline btn-sm" to="/sources">Перейти до Sources</Link>}
        </Empty>
      )}

      {Boolean(incoming.data?.items.length) && (
        <div className="stack">
          {incoming.data!.items.map((item) => {
            const s = ITEM_STATES[item.state];
            return (
              <article className={"card item" + (["rejected", "deleted"].includes(item.state) ? " item-muted" : "")} key={item.id}>
                <div className="item-head">
                  <span className="item-source">{item.source_kind==='rss'?item.channel_title:'@'+item.channel_title}</span>
                  <Badge tone={s?.tone ?? "neutral"} dot>{s?.label ?? item.state}</Badge>
                  <Badge tone="secondary">{item.source_kind === "rss" ? "RSS-анонс" : item.kind === "comment" ? "Коментар" : item.kind === "group_message" ? "Повідомлення групи" : "Пост"}</Badge>
                  <time className="item-time" title="Опубліковано">{formatDate(item.published_at)}</time>
                </div>
                <p className="item-meta">{item.workflow_name}{item.source_kind==='rss'?' · Анонс, не повний текст статті':' · Акаунт: '+(item.account_label||'не призначено')}</p>
                {item.source_kind==='rss'&&item.url&&<a className="rss-url" href={item.url} target="_blank" rel="noopener noreferrer">Джерело: {item.channel_title}</a>}
                <p className="item-text">{item.text ? excerpt(item.text) : "Текст відсутній або видалений."}</p>
                {item.url?.startsWith('https://www.kmu.gov.ua/')&&<p className="note">Урядовий портал · <a href="https://creativecommons.org/licenses/by/4.0/deed.uk" target="_blank" rel="noopener noreferrer">CC BY 4.0</a> · Анонс очищено та скорочено.</p>}
              <p className="item-reason">{item.reason}</p>
                <div className="item-foot">
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => open(item.id)}>{item.source_kind==='rss'?'Анонс і джерело':'Повний текст і контекст'}</button>
                  {item.url && <a className="btn btn-ghost btn-sm" href={item.url} target="_blank" rel="noopener noreferrer">Оригінал<ExternalLink size={14} aria-hidden="true" /></a>}
                  <span className="note spacer">Отримано: {formatDate(item.fetched_at)}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {(before || incoming.data?.next_before) && (
        <div className="pager">
          {before && <button type="button" className="btn btn-outline" onClick={() => setBefore("")}>До нових</button>}
          {incoming.data?.next_before && <button type="button" className="btn btn-outline" onClick={() => setBefore(incoming.data.next_before!)}>Наступні 50</button>}
        </div>
      )}

      <p className="note">
        Екран оновлюється кожні 5 секунд. Це не гарантія затримки збору. Лічильники враховують обрані джерела, тип і пошук; список додатково враховує стан.
      </p>

      <Dialog ref={dialog} title="Вхідний матеріал" titleId="incoming-title"
        footer={reviewable && (
          <>
            <button type="button" className="btn btn-outline" onClick={() => review("rejected")}>Відсіяти</button>
            <button type="button" className="btn btn-outline" onClick={() => review("review")}>На перевірку</button>
            <button type="button" className="btn" onClick={() => review("accepted")}>У стрічку</button>
          </>
        )}>
        {detail && (
          <>
            <div className="row">
              <Badge tone={ITEM_STATES[detail.item.state]?.tone ?? "neutral"} dot>{ITEM_STATES[detail.item.state]?.label ?? detail.item.state}</Badge>
              <Badge tone="secondary">Версія {detail.item.version}</Badge>
            </div>
            <Section title="Матеріал">
              {detail.item.url&&<a href={detail.item.url} target="_blank" rel="noopener noreferrer">Джерело: {detail.item.channel_title}</a>}
              {detail.item.source_kind==='rss'&&<p className="note">Заголовок і анонс RSS; повний текст не отримано.</p>}
              <blockquote className="quote">{detail.item.text || "Текст відсутній або видалений."}</blockquote>
            </Section>
            {detail.parent ? (
              <Section title="Пряма відповідь на">
                <blockquote className="quote">{detail.parent.text}</blockquote>
                {detail.parent.url && <div><a className="btn btn-ghost btn-sm" href={detail.parent.url} target="_blank" rel="noopener noreferrer">Оригінал контексту<ExternalLink size={14} aria-hidden="true" /></a></div>}
              </Section>
            ) : detail.item.kind === "comment" ? (
              <p className="note">Батьківське повідомлення ще не зібране або видалене.</p>
            ) : null}
            <TelegramEvidence data={detail.telegram} />
            <Section title="Причина рішення"><p>{detail.item.reason}</p></Section>
            <Section title="Часові мітки">
              <dl className="meta-list">
                <dt>Отримано</dt><dd>{formatDateTime(detail.item.fetched_at)}</dd>
                <dt>Остання обробка</dt><dd>{formatDateTime(detail.item.analyzed_at)}</dd>
                <dt>Редаговано</dt><dd>{formatDateTime(detail.item.edited_at)}</dd>
              </dl>
            </Section>
          </>
        )}
      </Dialog>
    </>
  );
}
