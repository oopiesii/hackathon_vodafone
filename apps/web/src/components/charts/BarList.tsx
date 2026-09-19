import { Link } from "react-router";

export function BarList({ data }: { data: { id: string; label: string; value: number; href: string }[] }) {
  const max = Math.max(1, ...data.map(d => d.value));
  if (!data.length) return <div className="chart-no-data">Тематичних матеріалів немає</div>;
  return <ol className="bar-list">{data.map(d => <li key={d.id}><Link to={d.href} title={`${d.label}: ${d.value.toLocaleString("uk-UA")} матеріалів`}>
    <span className="bar-list-label">{d.label}</span><strong>{d.value.toLocaleString("uk-UA")}</strong>
    <svg viewBox="0 0 400 10" preserveAspectRatio="none" aria-hidden="true"><path className="chart-accent" d={`M 0 0 H ${Math.max(0, d.value / max * 396)} q 4 0 4 4 v 2 q 0 4 -4 4 H 0 Z`} /></svg>
  </Link></li>)}</ol>;
}
