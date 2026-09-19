import type { DashboardResponse } from "@ufv/shared/dashboard";
import { ArrowUpRight, Radio } from "lucide-react";
import { Link } from "react-router";
import { Badge } from "../ui";
import { count } from "./Metrics";

const LEVELS = { h: "Критичний", m: "Увага", l: "Спостереження" } as const;
const ACTIONS = { none: "Дій ще немає", investigating: "З’ясовуємо", responding: "Реагуємо", resolved: "Вирішено" } as const;

export function Signals({ data }: { data: DashboardResponse }) {
  if (!data.signals.length) return <div className="dashboard-empty"><Radio size={24} aria-hidden="true" /><h3>{data.aggregated ? "Місячна динаміка" : "За останні 24 години сигналів немає"}</h3><span>{data.aggregated ? "За місяць показуємо лише агрегати. Поточні сигнали — у вікні «Сьогодні»." : data.counts.collected !== undefined ? `Зібрано ${count(data.counts.collected)} матеріалів · відсіяно ${count(data.counts.rejected ?? 0)}` : `У доступній стрічці: ${count(data.counts.accepted)} матеріалів`}</span></div>;
  return <ol className="signal-list">{data.signals.slice(0, 5).map(signal => <li key={signal.id}>
    <Link to={signal.href} className="signal-link"><div className="signal-content"><span className="signal-heading"><Badge tone={signal.level === "h" ? "danger" : signal.level === "m" ? "warning" : "secondary"}>{LEVELS[signal.level]}</Badge><strong>{signal.title}</strong></span><span className="signal-meta">{count(signal.count)} матеріалів · {count(signal.sources)} джерел · {count(signal.spread)} поширень</span></div><ArrowUpRight size={16} aria-hidden="true" /></Link>
    <div className="signal-action"><span>Статус дій</span><Badge tone={signal.action === "resolved" ? "success" : "neutral"}>{ACTIONS[signal.action]}</Badge></div>
  </li>)}</ol>;
}
