import type { DashboardBucket } from "@ufv/shared/dashboard";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { TOPICS } from "../../lib/labels";

const number = (n: number) => n.toLocaleString("uk-UA");
const date = (at: string, daily: boolean) => new Date(at).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", ...(daily ? { day: "2-digit", month: "2-digit" } : { hour: "2-digit", minute: "2-digit" }) });

export function HourlyBars({ data, daily }: { data: DashboardBucket[]; daily: boolean }) {
  const [active, setActive] = useState<number | null>(null);
  const tipId = useId();
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(650);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.max(240, entries[0]?.contentRect.width ?? 650)));
    if (frame.current) observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  const max = Math.max(1, ...data.map(d => d.count));
  const top = Math.max(1, Math.ceil(max / 4) * 4);
  const plotWidth = width - 44;
  const step = plotWidth / Math.max(data.length, 1), bar = Math.max(1, Math.min(20, step - 3));
  const selected = active === null ? null : data[active];
  return <div className="hourly-chart" ref={frame}>
    <div className="chart-legend"><span><i className="legend-accent" />Мережа й покриття</span><span><i className="legend-context" />Інші теми</span><span className="spacer">Матеріалів</span></div>
    <svg className="hourly-svg" viewBox={`0 0 ${width} 200`} role="group" aria-label={daily ? "Згадки за днями" : "Згадки за годинами"} onMouseLeave={() => setActive(null)}>
      {[0, 1, 2, 3, 4].map(i => <g key={i}><line x1="40" x2={width - 2} y1={164 - i * 36} y2={164 - i * 36} className="chart-gridline" /><text x="30" y={168 - i * 36} textAnchor="end" className="chart-axis">{number(top * i / 4)}</text></g>)}
      {data.map((d, i) => {
        const x = 40 + step * i + (step - bar) / 2, h = d.count / top * 144;
        const network = (d.topics.network ?? 0) / top * 144, other = Math.max(0, h - network);
        return <g key={d.at}>
          <a href={d.href} aria-label={`${date(d.at, daily)}: ${number(d.count)} матеріалів. Відкрити докази.`} aria-describedby={active === i ? tipId : undefined}
            onFocus={() => setActive(i)} onBlur={() => setActive(null)} onMouseEnter={() => setActive(i)} className="chart-mark">
            <rect x={40 + step * i} y="15" width={step} height="150" fill="transparent" />
            {other > 0 && <path className="chart-context" d={`M ${x} ${164 - network - (network > 0 ? 2 : 0)} v ${-Math.max(0, other - (network > 0 ? 2 : 0))} h ${bar} v ${Math.max(0, other - (network > 0 ? 2 : 0))} Z`} />}
            {network > 0 && <rect className="chart-accent" x={x} y={164 - network} width={bar} height={network} />}
            {d.count === 0 && <line x1={x} x2={x + bar} y1="164" y2="164" className="chart-empty-mark" />}
          </a>
          {(i === 0 || i === data.length - 1 || (i % Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotWidth / 65))))) === 0 && (data.length - 1 - i) * step > 48) && <text x={i === data.length - 1 ? width - 2 : 40 + step * (i + .5)} y="190" textAnchor={i === data.length - 1 ? "end" : i === 0 ? "start" : "middle"} className="chart-axis">{date(d.at, daily)}</text>}
        </g>;
      })}
    </svg>
    <div className="chart-readout" id={tipId} aria-live="polite">{selected ? <><strong>{number(selected.count)}</strong> <span>{date(selected.at, daily)} · {Object.entries(selected.topics).map(([t, n]) => `${TOPICS[t] ?? t}: ${number(n)}`).join("; ")}</span></> : <span>Оберіть стовпчик, щоб відкрити матеріали</span>}</div>
    <details className="chart-table"><summary>Таблиця значень</summary><div className="tablewrap"><table><thead><tr><th>{daily ? "Дата" : "Година"} · місцевий час</th><th>Згадки</th><th>Теми</th></tr></thead><tbody>{data.map(d => <tr key={d.at}><td><Link to={d.href}>{date(d.at, daily)}</Link></td><td>{number(d.count)}</td><td>{Object.entries(d.topics).map(([t, n]) => `${TOPICS[t] ?? t}: ${number(n)}`).join("; ") || "—"}</td></tr>)}</tbody></table></div></details>
  </div>;
}
