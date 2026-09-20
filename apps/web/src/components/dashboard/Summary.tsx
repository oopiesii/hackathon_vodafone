import type { DashboardSummary } from "@ufv/shared/dashboard";
import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router";
import { Badge, Card } from "../ui";
import { formatDateTime } from "../../lib/format";
import type { WidgetHandle } from "../../lib/dashboard-layout";

export function Summary({ summary, widget }: { summary: DashboardSummary; widget?: WidgetHandle }) {
  return <Card widget={widget} className="span-12 dashboard-summary" title="Зведення періоду" actions={<Badge tone="secondary">{summary.label}</Badge>}
    footer={<Link className="btn btn-ghost btn-sm" to={summary.href}>Матеріали зведення<ArrowUpRight size={14} aria-hidden="true" /></Link>}>
    <div className="stack"><p>{summary.summary}</p>
      {summary.coverage && <p className="note">Лише джерела з дозволом на AI · покриття відрізняється від загальних метрик.{summary.generated_at && <> Зріз: {formatDateTime(summary.generated_at)}.</>}</p>}
      {!!summary.observations?.length && <ol className="ai-observations">{summary.observations.map((observation, index) => <li key={index}><p>{observation.text}</p><div className="ai-evidence">{observation.evidence.map((evidence, e) => <Link key={`${evidence.id}-${e}`} to={evidence.href}><span>«{evidence.quote}»</span><ArrowUpRight size={14} aria-hidden="true" /><small>Перевірити матеріал</small></Link>)}</div></li>)}</ol>}
      {summary.mode === "ai" && <p className="note">Модель: {summary.model || "невідома"}. Висновки потребують перевірки за доказами.</p>}
      {(summary.coverage || !!summary.limitations?.length) && <details><summary>Покриття та межі зведення</summary><div className="stack">{summary.coverage && <p className="hint">{summary.coverage.note}</p>}{!!summary.limitations?.length && <ul className="summary-limitations">{summary.limitations.map((line, i) => <li key={i}>{line}</li>)}</ul>}</div></details>}
    </div>
  </Card>;
}
