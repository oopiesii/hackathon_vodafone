import { TelegramEvidence, type TelegramDetail } from "../components/TelegramEvidence";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Newspaper, RefreshCw, Search } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { Alert, Badge, Card, Dialog, Empty, Field, PageHeader, Section, Stat } from "../components/ui";
import { api, can, errorText, send, type Me } from "../lib/api";
import { excerpt, formatDate, formatDateTime } from "../lib/format";
import { ACTION_STATUS, ACTION_VALUES, TOPICS } from "../lib/labels";

type Item = {
  source_kind:string; id: string; text: string; summary: string; source_url: string; published_at: string | null; fetched_at: string;
  processed_at: string; edited_at: string | null; kind: string; topic: string; channel_title: string; reason: string;
  duplicate_of: string | null; context_id: string | null; manual_decision: string | null;
  classifier?:string; model?:string; evidence_quote?:string|null; action?: string;
};
type FeedData = {
  items: Item[]; total: { count: number; last_processed_at: string | null }; kinds: { kind: string; count: number }[];
  topics: { topic: string; count: number }[]; next_before: string | null; summary_only: boolean; telegram_enabled: boolean;
};
type Detail = { document: Item; telegram?:TelegramDetail; context: { text: string; source_url: string } | null };

export function Feed({ me, shared = false, shareScopeId, workflowId = "1", title = "Стрічка", badge }: {
  me?: Me | undefined; shared?: boolean; shareScopeId?: string; workflowId?: string; title?: string; badge?: ReactNode;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") || "", topic = searchParams.get("topic") || "", kind = searchParams.get("kind") || "";
  const decision = searchParams.get("decision") || "accepted", before = searchParams.get("before") || "";
  const workflow = shared ? workflowId : searchParams.get("workflow_id") || workflowId;
  const setField = (key: string) => (value: string) => {
    setSearchParams(previous => { const next = new URLSearchParams(previous); value ? next.set(key, value) : next.delete(key); if (key !== "before") next.delete("before"); return next; });
  };
  const setQ = setField("q"), setTopic = setField("topic"), setKind = setField("kind"), setDecision = setField("decision"), setBefore = setField("before"), setWorkflow = setField("workflow_id");
  const scoped = ["from", "until", "day", "source_id", "source_kind", "brand", "ids", "negative", "has_views", "has_reactions", "lag"].some(key => searchParams.has(key));
  const dashboardBack = "/?" + new URLSearchParams({ workflow_id: workflow, window: searchParams.get("window") || "24h" });
  const [detail, setDetail] = useState<Detail | null>(null), [detailError, setDetailError] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const prefix = shared ? "/shared" : "";
  const access = shared ? { headers: { "x-ufv-share-scope": shareScopeId ?? "" } } : undefined;
  const params = new URLSearchParams(searchParams);
  Object.entries({ workflow_id: workflow, q, topic, kind, decision, before }).forEach(([key, value]) => params.set(key, value));
  const feed = useQuery({ queryKey: ["feed", shared, shareScopeId, params.toString()], queryFn: () => api<FeedData>(`${prefix}/feed?${params}`, access), refetchInterval: 30000 });
  const workspaces = useQuery({ queryKey: ["workflows"], queryFn: () => api<{ items: { id: string; name: string }[] }>("/workflows"), enabled: !shared });
  // Зміна будь-якого фільтра повертає до найновіших матеріалів.
  const filter = (set: (value: string) => void) => (value: string) => set(value);

  async function open(id: string) {
    setDetailError("");
    try {
      setDetail(await api<Detail>(`${prefix}/documents/${id}`, access));
      dialog.current?.showModal();
    } catch (e) { setDetailError(errorText(e, "Не вдалося відкрити матеріал.")); }
  }
  // Статус дій зберігається окремо від рішення про відбір: він не змінює видимість матеріалу.
  async function setAction(value: string) {
    if (!detail) return;
    setActionPending(true);
    setDetailError("");
    try {
      await send(`/admin/documents/${detail.document.id}/action`, "PUT", { status: value });
      setDetail({ ...detail, document: { ...detail.document, action: value } });
      await feed.refetch();
    } catch (e) { setDetailError(errorText(e, "Не вдалося зберегти статус дій.")); }
    finally { setActionPending(false); }
  }
  async function review(value: string) {
    if (!detail) return;
    try {
      await send(`/admin/documents/${detail.document.id}/review`, "POST", { decision: value });
      dialog.current?.close();
      await feed.refetch();
    } catch (e) { setDetailError(errorText(e, "Не вдалося зберегти рішення.")); }
  }

  const data = feed.data;
  const counts = Object.fromEntries((data?.kinds || []).map((v) => [v.kind, v.count]));
  return (
    <>
      <PageHeader
        title={<span className="row">{title}{badge}</span>}
        description="Матеріали з дозволених джерел. Кожен запис має пояснення фільтра, контекст і посилання на оригінал."
        breadcrumb={!shared && <Link className="btn btn-ghost btn-sm" to={dashboardBack}>До дашборда</Link>}
        actions={<button type="button" className="btn btn-outline" onClick={() => feed.refetch()} disabled={feed.isFetching}><RefreshCw size={16} aria-hidden="true" />Оновити</button>}
      />

      {scoped && <div className="feed-scope"><Badge tone="info">Зріз із дашборда</Badge><span>{searchParams.get("from") ? formatDateTime(searchParams.get("from")) : "Обрані матеріали"}{searchParams.get("until") ? ` – ${formatDateTime(searchParams.get("until"))}` : ""}</span><button className="btn btn-ghost btn-sm" type="button" onClick={() => setSearchParams({ workflow_id: workflow, decision })}>Скинути зріз</button></div>}
      <div className="stats">
        <Stat label="Матеріалів за фільтрами">{data?.total.count ?? "—"}</Stat>
        <Stat label="Публікацій">{data ? counts.post ?? 0 : "—"}</Stat>
        <Stat label="Коментарів">{data ? counts.comment ?? 0 : "—"}</Stat>
        <Stat label="Telegram-модуль">
          {data ? <Badge tone={data.telegram_enabled ? "success" : "secondary"} dot>{data.telegram_enabled ? "Увімкнено" : "Вимкнено"}</Badge> : "—"}
        </Stat>
      </div>

      {(!shared || !data?.summary_only) && (
        <div className="toolbar">
          {!data?.summary_only && (
            <Field label="Пошук" className="toolbar-wide">
              <span className="search">
                <Search size={16} aria-hidden="true" />
                <input type="search" value={q} onChange={(e) => filter(setQ)(e.target.value)} placeholder="Vodafone, збій, інтернет…" />
              </span>
            </Field>
          )}
          {!shared && (
            <Field label="Workflow">
              <select value={workflow} onChange={(e) => filter(setWorkflow)(e.target.value)}>
                {(workspaces.data?.items || [{ id: "1", name: "Vodafone та український телеком" }]).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </Field>
          )}
          {!data?.summary_only && (
            <>
              <Field label="Тема">
                <select value={topic} onChange={(e) => filter(setTopic)(e.target.value)}>
                  <option value="">Усі теми</option>
                  {Object.entries(TOPICS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Тип">
                <select value={kind} onChange={(e) => filter(setKind)(e.target.value)}>
                  <option value="">Пости й коментарі</option>
                  <option value="post">Пости</option>
                  <option value="comment">Коментарі</option><option value="group_message">Повідомлення груп</option>
                </select>
              </Field>
              {can(me, "incident", "edit") && (
                <Field label="Рішення">
                  <select value={decision} onChange={(e) => filter(setDecision)(e.target.value)}>
                    <option value="accepted">У стрічці</option>
                    <option value="visible">Прийняті й на перевірці</option>
                    <option value="review">На перевірці</option>
                    <option value="rejected">Відсіяне</option>
                    <option value="pending">Очікує семантичної перевірки</option>
                    <option value="all">Усе</option>
                  </select>
                </Field>
              )}
            </>
          )}
        </div>
      )}

      {feed.isPending && <p className="loading" role="status">Завантаження…</p>}
      {feed.isError && <Alert tone="danger">{errorText(feed.error)}</Alert>}
      {detailError && <Alert tone="danger">{detailError}</Alert>}

      {data?.summary_only && (
        <Card title="Зведення за темами" description="Посилання надає лише агреговані дані. Тексти та джерела недоступні.">
          {data.topics.map((t) => (
            <div className="list-row" key={t.topic}><span>{TOPICS[t.topic] ?? t.topic}</span><strong className="spacer">{t.count}</strong></div>
          ))}
        </Card>
      )}

      {data && !data.total.count && (
        <Empty icon={<Newspaper size={20} />} title="Матеріалів ще немає">
          <p>Перевірте підключення джерел або змініть фільтри. Порожня стрічка не означає відсутність проблем у мережі.</p>
        </Empty>
      )}

      {Boolean(data?.items.length) && (
        <div className="stack">
          {data!.items.map((item) => (
            <article className="card item" key={item.id}>
              <div className="item-head">
                <span className="item-source">{item.channel_title}</span>
                <Badge tone="secondary">{item.source_kind === "rss" ? "RSS-анонс" : item.kind === "post" ? "Пост" : item.kind === "group_message" ? "Повідомлення групи" : "Коментар"}</Badge>
                <Badge>{TOPICS[item.topic] ?? item.topic}</Badge>
                {item.manual_decision && <Badge tone="info">Рішення людини</Badge>}
                {item.classifier === 'semantic' && <Badge tone="info" title={item.model ?? undefined}>AI-відбір</Badge>}
                {item.action && item.action !== "none" && ACTION_STATUS[item.action] && <Badge tone={ACTION_STATUS[item.action]!.tone} title="Статус дій команди">{ACTION_STATUS[item.action]!.label}</Badge>}
                <time className="item-time" title="Опубліковано">{formatDate(item.published_at)}</time>
              </div>
              {item.source_kind==='rss'&&<a href={item.source_url} target="_blank" rel="noopener noreferrer">Джерело: {item.channel_title}</a>}
              {item.classifier === 'semantic' && <p className="item-summary"><strong>Висновок AI:</strong> {item.summary}</p>}
              <p className="item-text">{excerpt(item.text)}</p>
              {item.evidence_quote && <blockquote className="quote"><small>Цитата-підстава</small><br />{item.evidence_quote}</blockquote>}
              {item.source_url?.startsWith('https://www.kmu.gov.ua/')&&<p className="note">Урядовий портал · <a href="https://creativecommons.org/licenses/by/4.0/deed.uk" target="_blank" rel="noopener noreferrer">CC BY 4.0</a> · Анонс очищено та скорочено.</p>}
              <p className="item-reason">
                {item.reason}
                {item.duplicate_of && " · Збіг тексту або URL з іншим матеріалом; не незалежне підтвердження."}
              </p>
              <div className="item-foot">
                <button type="button" className="btn btn-outline btn-sm" onClick={() => open(item.id)}>Контекст і доказ</button>
                <a className="btn btn-ghost btn-sm" href={item.source_url} target="_blank" rel="noopener noreferrer">Оригінал<ExternalLink size={14} aria-hidden="true" /></a>
                <span className="note spacer">Отримано: {formatDate(item.fetched_at)}</span>
              </div>
            </article>
          ))}
        </div>
      )}

      {(before || data?.next_before) && (
        <div className="pager">
          {before && <button type="button" className="btn btn-outline" onClick={() => setBefore("")}>До нових</button>}
          {data?.next_before && <button type="button" className="btn btn-outline" onClick={() => setBefore(data.next_before!)}>Наступні 50</button>}
        </div>
      )}

      <p className="note">
        Остання обробка видимих матеріалів: {formatDateTime(data?.total.last_processed_at ?? null)}. RSS перевіряється за розкладом; Telegram доповнює polling подіями наживо.
        Доступ до обговорень і ліміти Telegram впливають на фактичну затримку.
      </p>

      <Dialog ref={dialog} title="Матеріал і контекст" titleId="detail-title"
        footer={detail && can(me, "collector", "manage") && (
          <>
            <button type="button" className="btn btn-outline" onClick={() => review("rejected")}>Відсіяти</button>
            <button type="button" className="btn btn-outline" onClick={() => review("review")}>На перевірку</button>
            <button type="button" className="btn" onClick={() => review("accepted")}>У стрічку</button>
          </>
        )}>
        {detail && (
          <>
            {detailError && <Alert tone="danger">{detailError}</Alert>}
            <Section title="Матеріал">
              {detail.document.classifier === 'semantic' && <p><strong>Висновок AI:</strong> {detail.document.summary}</p>}
              <p className="note">{detail.document.reason}</p>
              {detail.document.source_kind==='rss'&&<p className="note">Анонс RSS. Повний текст статті не отримано. <a href={detail.document.source_url} target="_blank" rel="noopener noreferrer">Джерело: {detail.document.channel_title}</a></p>}
              <blockquote className="quote">{detail.document.text}</blockquote>
              <div><a className="btn btn-ghost btn-sm" href={detail.document.source_url} target="_blank" rel="noopener noreferrer">Оригінал<ExternalLink size={14} aria-hidden="true" /></a></div>
            </Section>
            {detail.context ? (
              <Section title="Батьківське повідомлення">
                <blockquote className="quote">{detail.context.text}</blockquote>
                <div><a className="btn btn-ghost btn-sm" href={detail.context.source_url} target="_blank" rel="noopener noreferrer">Джерело контексту<ExternalLink size={14} aria-hidden="true" /></a></div>
              </Section>
            ) : detail.document.kind === "comment" ? (
              <p className="note">Контекст ще не отримано або недоступний у межах вашого доступу.</p>
            ) : null}
            <Section title="Статус дій">
              {can(me, "collector", "manage") ? (
                <Field label="Що команда робить із цим матеріалом" hint="Зміна записується в журнал дій. Статус не впливає на відбір і на показники дашборда.">
                  <select value={detail.document.action ?? "none"} disabled={actionPending} onChange={(e) => setAction(e.target.value)}>
                    {ACTION_VALUES.map((value) => <option key={value} value={value}>{value === "none" ? "— дій ще немає" : ACTION_STATUS[value]!.label}</option>)}
                  </select>
                </Field>
              ) : (
                <p className="row">{detail.document.action && detail.document.action !== "none" && ACTION_STATUS[detail.document.action]
                  ? <Badge tone={ACTION_STATUS[detail.document.action]!.tone}>{ACTION_STATUS[detail.document.action]!.label}</Badge>
                  : <span className="note">— дій ще немає</span>}</p>
              )}
            </Section>
            <TelegramEvidence data={detail.telegram} />
            <Section title="Часові мітки">
              <dl className="meta-list">
                <dt>Публікація</dt><dd>{formatDateTime(detail.document.published_at)}</dd>
                <dt>Отримання</dt><dd>{formatDateTime(detail.document.fetched_at)}</dd>
                <dt>Аналіз</dt><dd>{formatDateTime(detail.document.processed_at)}</dd>
                <dt>Редагування</dt><dd>{formatDateTime(detail.document.edited_at)}</dd>
              </dl>
              <p className="note">
                Час самої події та першої доступності невідомий. Для історичних матеріалів ці мітки не є вимірюванням live-затримки.
                Контактні дані вилучаються правилами; автори не збираються.
              </p>
            </Section>
          </>
        )}
      </Dialog>
    </>
  );
}
