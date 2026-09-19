import type { DashboardResponse, DashboardMetric } from "@ufv/shared/dashboard";
import { Link } from "react-router";
import { Spark } from "../charts/Spark";
import { Flame } from "lucide-react";

export const count = (value: number) => value.toLocaleString("uk-UA", { maximumFractionDigits: 1 });
export function metricValue(metric: DashboardMetric) {
  if (metric.value === null) return "—";
  if (metric.unit === "seconds" || metric.unit === "с") return metric.value < 60 ? `${count(metric.value)} с` : metric.value < 3600 ? `${count(metric.value / 60)} хв` : `${count(metric.value / 3600)} год`;
  const formatted = Math.abs(metric.value) >= 1000000 ? metric.value.toLocaleString("uk-UA", { notation: "compact", maximumFractionDigits: 1 }) : count(metric.value);
  return `${formatted}${metric.unit === "percent" || metric.unit === "%" ? "%" : ""}`;
}
const METRIC_LABELS = { mentions: "Згадки", critical: "Критичні матеріали", negative_share: "Негативні реакції", negative_reach: "Негативне охоплення", collection_lag: "Затримка збору", noise: "Відсіяний шум" } as const;

export function Metrics({ data }: { data: DashboardResponse }) {
  return <div className="dashboard-metrics">{(Object.keys(METRIC_LABELS) as (keyof typeof METRIC_LABELS)[]).map(key => {
    const metric = data.metrics[key];
    if (!metric) return null;
    return <Link to={metric.href} className={`metric-tile metric-attention-${metric.attention ?? 0}`} key={key} title={[metric.note,metric.attention_note].filter(Boolean).join(' ')}>
      <span className="metric-label">{METRIC_LABELS[key]}</span>
      <span className="metric-main"><strong>{metricValue(metric)}</strong><Spark values={metric.series} /></span>
      {Boolean(metric.attention) && <span className="metric-attention-label"><Flame size={14} aria-hidden="true" />{metric.attention === 3 ? "Висока увага" : metric.attention === 2 ? "Посилена увага" : "Звернути увагу"}</span>}
      <span className="metric-note">{metric.value === null ? "Недостатньо вимірювань" : key === "negative_share" ? "Евристика за реакціями" : key === "negative_reach" ? "Перегляди, не унікальні люди" : key === "critical" ? "За правилами, не прогноз" : key === "collection_lag" ? `Медіана · ${count(metric.measured)} вимірювань` : "Переглянути матеріали"}</span>
    </Link>;
  })}</div>;
}

export function MetricsTable({ data }: { data: DashboardResponse }) {
  return <div className="tablewrap"><table><thead><tr><th>Показник</th><th>Значення</th><th>Методика</th><th>Ряд значень</th></tr></thead><tbody>{(Object.keys(METRIC_LABELS) as (keyof typeof METRIC_LABELS)[]).map(key => {
    const metric = data.metrics[key];
    return metric && <tr key={key}><td><Link to={metric.href}>{METRIC_LABELS[key]}</Link></td><td>{metricValue(metric)}</td><td>{metric.note} {metric.attention_note}</td><td>{metric.series.length ? metric.series.map(count).join("; ") : "Немає ряду"}</td></tr>;
  })}</tbody></table></div>;
}
