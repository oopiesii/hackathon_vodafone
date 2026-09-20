import type { DashboardResponse } from "@ufv/shared/dashboard";
import { ArrowUpRight, Radio } from "lucide-react";
import { Link } from "react-router";
import { Badge } from "../ui";
import { brandName, quantity } from "../../lib/plural";
import { ACTION_STATUS } from "../../lib/labels";

const LEVELS = { h: "Критичний", m: "Увага", l: "Спостереження" } as const;

export function Signals({ data, manage = false }: { data: DashboardResponse; manage?: boolean }) {
  if (!data.signals.length) return <div className="dashboard-empty"><Radio size={24} aria-hidden="true" /><h3>{data.aggregated ? "Місячна динаміка" : "За останні 24 години сигналів немає"}</h3><span>{data.aggregated ? "За місяць показуємо лише агрегати. Поточні сигнали — у вікні «Сьогодні»." : data.counts.collected !== undefined ? `За вибраний період зібрано ${quantity(data.counts.collected, "матеріал", "матеріали", "матеріалів")} · відсіяно ${data.counts.rejected?.toLocaleString("uk-UA") ?? "0"}` : `У доступній стрічці: ${quantity(data.counts.accepted, "матеріал", "матеріали", "матеріалів")}`}</span></div>;
  return <ol className="signal-list">{data.signals.slice(0, 5).map(signal => <li key={signal.id}>
    <Link to={signal.href} className="signal-link"><div className="signal-content"><span className="signal-heading"><Badge tone={signal.level === "h" ? "danger" : signal.level === "m" ? "warning" : "secondary"}>{LEVELS[signal.level]}</Badge><strong>{signal.title}</strong><span className="signal-brand">{brandName(signal.brand)}</span></span><span className="signal-meta">{quantity(signal.count, "матеріал", "матеріали", "матеріалів")} · {quantity(signal.sources, "джерело", "джерела", "джерел")} · {quantity(signal.spread, "поширення", "поширення", "поширень")}</span></div><ArrowUpRight size={16} aria-hidden="true" /></Link>
    <div className="signal-action"><span>Статус дій</span><Badge tone={ACTION_STATUS[signal.action]!.tone}>{ACTION_STATUS[signal.action]!.label}</Badge>{manage && <Link className="btn btn-ghost btn-sm signal-action-edit" to={signal.href}>Змінити у стрічці</Link>}</div>
  </li>)}</ol>;
}
