import type { DashboardResponse, DashboardWindow } from "@ufv/shared/dashboard";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ShieldCheck, ShieldAlert } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { Alert, Badge, Card, PageHeader, Tabs } from "../components/ui";
import { HourlyBars } from "../components/charts/HourlyBars";
import { ShareBar } from "../components/charts/ShareBar";
import { BarList } from "../components/charts/BarList";
import { Metrics, MetricsTable, count } from "../components/dashboard/Metrics";
import { IntegrationSlot } from "../components/IntegrationSlot";
import { RefreshControl } from "../components/dashboard/RefreshControl";
import { Impact } from "../components/dashboard/Impact";
import { Signals } from "../components/dashboard/Signals";
import { quantity } from "../lib/plural";
import { api, can, errorText, type Me } from "../lib/api";

const time = (value: string | null) => value ? new Date(value).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "немає даних";
const SERVICE_NAMES: Record<string, string> = { telegram: "Telegram", rss: "RSS", "collector-telegram": "Telegram", "collector-rss": "RSS", processor: "Обробка", analyst: "AI-аналітик" };

export function Dashboard({ me }: { me: Me | undefined }) {
  const [params, setParams] = useSearchParams();
  const value = params.get("window");
  const window: DashboardWindow = value === "7d" || value === "30d" ? value : "24h";
  const workflow = params.get("workflow_id") || "1";
  const query = useQuery({ queryKey: ["dashboard", workflow, window], queryFn: () => api<DashboardResponse>(`/dashboard?${new URLSearchParams({ workflow_id: workflow, window })}`), placeholderData: keepPreviousData, refetchInterval: q => q.state.data?.aggregation?.complete === false ? 3000 : 300000 });
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: () => api<{ items: { id: string; name: string }[] }>("/workflows") });
  const data = query.data;
  const calculating = data?.aggregation?.complete === false;
  const waiting = <div className="chart-no-data">Перераховуємо повні агрегати…</div>;
  const setFilter = (key: string, next: string) => { const copy = new URLSearchParams(params); copy.set(key, next); setParams(copy); };
  return <div className="dashboard">
    <PageHeader title="Сьогодні" actions={<RefreshControl workflow={workflow} admin={can(me, "collector", "manage")} fetching={query.isFetching} refetch={() => { void query.refetch(); }} />} />
    <div className="dashboard-controls">
      <Tabs label="Період дашборда" value={window} onChange={v => setFilter("window", v)} items={[{ value: "24h", label: "Сьогодні" }, { value: "7d", label: "7 днів" }, { value: "30d", label: "30 днів" }]} />
      <select aria-label="Напрям моніторингу" value={workflow} onChange={e => setFilter("workflow_id", e.target.value)}>{(workflows.data?.items ?? [{ id: "1", name: "Vodafone та український телеком" }]).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      <span className="dashboard-period">{window === "24h" ? "Останні 24 години" : `Останні ${window === "7d" ? "7" : "30"} днів`} · Київ</span>
    </div>
    {query.isError && <Alert tone="danger"><div>Не вдалося оновити дашборд. {errorText(query.error)}</div><button className="btn btn-outline btn-sm" type="button" onClick={() => query.refetch()}>Спробувати знову</button></Alert>}
    {!data && query.isPending && <div className="dashboard-loading" role="status" aria-busy="true"><span>Збираємо показники з дозволених матеріалів…</span><div className="dashboard-skeleton" /><div className="dashboard-skeleton" /></div>}
    {data && <div className="dashboard-data" aria-busy={query.isFetching}>
      <div className="dashboard-freshness"><span className="row"><span className="dot" />Зріз {time(data.generated_at)}</span>{data.freshness.map(s => <span key={s.service}>{SERVICE_NAMES[s.service] ?? s.service}: {s.enabled ? time(s.last_success_at) : "збір вимкнено"}</span>)}{data.aggregated && <span>Згортки: {data.aggregate_updated_at ? time(data.aggregate_updated_at) : "очікує оновлення"}</span>}{query.isFetching && <span role="status">Оновлення…</span>}</div>
      {data.aggregation && !data.aggregation.complete && <Alert>{data.aggregation.note}</Alert>}
      <div className="dashboard-overview">
        <Link className={`brand-status brand-status-${data.brand_status.level}`} to={data.brand_status.href} title={data.brand_status.reason}>
          <span className="brand-status-label">Vodafone Україна <span>За правилами</span></span>
          {data.brand_status.level === "calm" ? <ShieldCheck size={28} aria-hidden="true" /> : <ShieldAlert size={28} aria-hidden="true" />}
          <strong className="brand-status-title">{{ calm: "Спокійно", attention: "Увага", critical: "Критично", unknown: "Недостатньо даних" }[data.brand_status.level]}</strong>
          <span className="brand-status-problem">{data.brand_status.reason}</span><span className="brand-status-link">Перевірити докази<ArrowUpRight size={16} aria-hidden="true" /></span>
        </Link>
        <Metrics data={data} />
      </div>
      <div className="dashboard-grid">
        <Card className="dashboard-now span-7" title="Що зараз" actions={<Badge>Останні 24 год</Badge>} footer={<Link className="btn btn-ghost btn-sm" to={`/feed?workflow_id=${workflow}&decision=${data.visibility === "accepted" ? "accepted" : "visible"}`}>Відкрити стрічку<ArrowUpRight size={14} aria-hidden="true" /></Link>}><Signals data={data} /></Card>
        <Card className="span-5" title={data.aggregated ? "Динаміка за днями" : "Динаміка згадок"}>{calculating ? waiting : <HourlyBars data={data.hourly} daily={data.aggregated} />}</Card>
        <Card className="span-4" title="Реакції" actions={<Badge title={data.reactions.note}>Евристика</Badge>} footer={<span className="note">{calculating ? "Очікуємо повного зрізу" : `${quantity(data.reactions.observed_items, "матеріал", "матеріали", "матеріалів")} із реакціями · сумні окремо`}</span>}>{calculating ? waiting : <ShareBar negative={data.reactions.negative + data.reactions.ironic} sad={data.reactions.sad} positive={data.reactions.positive} href={data.reactions.href} />}</Card>
        <Card className="span-4" title="Джерела згадок">{calculating ? waiting : <BarList data={data.sources.slice(0, 5).map(s => ({ id: s.id, label: s.title, value: s.count, href: s.href }))} />}</Card>
        <Card className="span-4" title="Поширення" actions={<Badge title="Перепублікації не доводять незалежність джерел.">Збіги змісту</Badge>}>
          {calculating ? waiting : data.spread.length ? <div className="spread-list">{data.spread.slice(0, 3).map(s => <Link key={s.id} to={s.href}><strong>{quantity(s.count, "поширення", "поширення", "поширень")}</strong><span>{quantity(s.source_count, "джерело", "джерела", "джерел")}</span><small>{s.third_repost_seconds === null ? "Третю перепублікацію не зафіксовано" : `До 3-го поширення: ${count(s.third_repost_seconds / 60)} хв`}</small></Link>)}</div> : <div className="chart-no-data">Збігів змісту у вибраному вікні немає</div>}
        </Card>
        <Impact />
        <IntegrationSlot />
        <Card className="span-4" title="Конкуренти">{calculating ? waiting : <BarList data={data.competitors.map(c => ({ id: c.brand, label: c.brand === "kyivstar" ? "Київстар" : c.brand === "lifecell" ? "lifecell" : c.brand, value: c.count, href: c.href }))} />}</Card>
        <Card className="span-12 dashboard-summary" title="Зведення періоду" actions={<Badge tone="secondary">{data.ai.label}</Badge>} footer={<Link className="btn btn-ghost btn-sm" to={data.ai.href}>Матеріали зведення<ArrowUpRight size={14} aria-hidden="true" /></Link>}><p>{data.ai.summary}</p></Card>
      </div>
      <details className="dashboard-methodology"><summary>Методика, покриття та обмеження</summary><ul>{data.methodology.map(line => <li key={line}>{line}</li>)}</ul><MetricsTable data={data} /><div className="dashboard-method-meta">Роль: {me?.user.role === "viewer" ? "лише прийняті матеріали" : "прийняті та на перевірці"}. Зріз: {time(data.start)} – {time(data.end)} (Київ).</div></details>
    </div>}
  </div>;
}
