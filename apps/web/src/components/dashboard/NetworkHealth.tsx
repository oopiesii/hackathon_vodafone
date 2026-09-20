import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api } from "../../lib/api";
import { Badge, Card, Tabs } from "../ui";

type Source = "ping-slash24" | "bgp";
type Signal = { source: Source; from: number; step: number; baseline: number; last: number; lowest: number; ratio: number; level: "normal" | "degraded" | "outage"; percent: (number | null)[] };
type Operator = { id: "vodafone" | "kyivstar" | "lifecell"; name: string; asn: number; signals: Signal[] };
type NetworkResponse =
  | { available: false; reason: string }
  | { available: true; fetched_at: string; window: "24h" | "7d"; operators: Operator[]; events: { source: string; start: string; minutes: number; score: number }[]; thresholds: { normal: number; degraded: number } };

const SOURCE_LABEL: Record<Source, string> = { "ping-slash24": "Відповідає на запити", bgp: "Видима в інтернеті" };
const SOURCE_HINT: Record<Source, string> = {
  "ping-slash24": "Активне зондування: скільки блоків адрес мережі відповідає на запити ззовні, у % від медіани вікна. Згладжено ковзною медіаною 5 точок.",
  bgp: "Маршрутизація BGP: скільки блоків адрес мережі видно в глобальному інтернеті, у % від медіани вікна. Згладжено ковзною медіаною 5 точок.",
};
const LEVEL = { normal: { label: "У нормі", tone: "success" }, degraded: { label: "Просідання", tone: "warning" }, outage: { label: "Збій", tone: "danger" } } as const;
const VERDICT = { normal: "доступна з інтернету як зазвичай", degraded: "доступна з інтернету гірше, ніж зазвичай", outage: "масово недоступна з інтернету" } as const;
const percent = (v: number | null | undefined) => (v == null ? "—" : `${v.toLocaleString("uk-UA", { maximumFractionDigits: 1 })}%`);
// Зондування малих мереж шумить; для показу беремо ковзну медіану 5 точок. Таблиця значень показує те саме, що й графік.
const smooth = (points: (number | null)[]) => points.map((v, i) => {
  if (v === null) return null;
  const near = points.slice(Math.max(0, i - 2), i + 3).filter((x): x is number => x !== null).sort((a, b) => a - b);
  return near[Math.floor(near.length / 2)]!;
});
const clock = (ms: number, withDate: boolean) => new Date(ms).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", ...(withDate ? { day: "2-digit", month: "2-digit" } : {}), hour: "2-digit", minute: "2-digit" });

/** Зовнішні вимірювання зв'язності мереж операторів (IODA). Це не телеметрія оператора: слот внутрішнього API лишається окремим блоком. */
export function NetworkHealth({ window }: { window: "24h" | "7d" | "30d" }) {
  const span = window === "24h" ? "24h" : "7d";
  const [source, setSource] = useState<Source>("ping-slash24");
  const query = useQuery({ queryKey: ["context-network", span], queryFn: () => api<NetworkResponse>(`/context/network?window=${span}`), refetchInterval: 5 * 60_000 });
  const data = query.data;
  const ready = data?.available ? data : null;
  const lines = ready?.operators.flatMap((o) => { const s = o.signals.find((x) => x.source === source); return s ? [{ ...o, signal: { ...s, percent: smooth(s.percent) } }] : []; }) ?? [];
  const own = lines.find((l) => l.id === "vodafone");
  return (
    <Card className="span-7 context-card" title="Чи працює мережа"
      actions={own ? <Badge tone={LEVEL[own.signal.level].tone} dot title="Евристика: зараз ≥ 90% медіани вікна — норма, 50–90% — просідання, нижче — збій.">Vodafone · {LEVEL[own.signal.level].label}</Badge> : <Badge tone="secondary">Зовнішні вимірювання</Badge>}
      footer={<span className="note context-source">
        Дані: <a href="https://ioda.inetintel.cc.gatech.edu/asn/21497" target="_blank" rel="noopener noreferrer">IODA, Georgia Tech<ExternalLink size={12} aria-hidden="true" /></a>
        {" "}· зовнішні вимірювання, не телеметрія оператора · телефони абонентів на зондування не відповідають, тож суто мобільний збій тут не видно{ready ? ` · зафіксованих IODA збоїв за 30 днів: ${ready.events.length} · оновлено ${clock(Date.parse(ready.fetched_at), false)}` : ""}
      </span>}>
      {query.isPending && <div className="chart-no-data" role="status">Отримуємо вимірювання…</div>}
      {data && !data.available && <div className="chart-no-data">{data.reason}</div>}
      {query.isError && <div className="chart-no-data">Не вдалося отримати вимірювання.</div>}
      {ready && (lines.length ? <>
        {own && <div className="network-verdict">
          <strong className="network-value" title="Частка від звичного рівня за вікно; вище звичного показуємо як 100%.">{percent(Math.min(100, own.signal.ratio * 100))}</strong>
          <p>Мережа Vodafone {VERDICT[own.signal.level]}.<span>{lines.filter((l) => l.id !== "vodafone").map((l) => `${l.name} — ${percent(Math.min(100, l.signal.ratio * 100))}`).join(" · ")}. 100% — звичний рівень мережі за {span === "7d" ? "тиждень" : "добу"}: показник ловить раптові збої магістралі та фіксованого інтернету; мобільну радіомережу й окремі вишки ззовні не видно.</span></p>
        </div>}
        <Lines lines={lines} threshold={ready.thresholds.normal * 100} withDate={span === "7d"} />
        <details className="chart-table"><summary>Що саме вимірюється</summary>
          <div className="context-head">
            <Tabs label="Тип вимірювання" value={source} onChange={setSource} items={[{ value: "ping-slash24", label: SOURCE_LABEL["ping-slash24"] }, { value: "bgp", label: SOURCE_LABEL.bgp }]} />
            <span className="note">{SOURCE_HINT[source]}</span>
          </div>
        </details>
      </> : <div className="chart-no-data">Для цього типу вимірювань ряд зараз недоступний.</div>)}
    </Card>
  );
}

type Line = Operator & { signal: Signal };
function Lines({ lines, threshold, withDate }: { lines: Line[]; threshold: number; withDate: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640), [index, setIndex] = useState<number | null>(null);
  // Графік малюється 1:1 у пікселях контейнера, щоб підписи не масштабувалися разом із SVG на вузьких екранах.
  useEffect(() => {
    const el = host.current; if (!el) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(280, Math.floor(el.clientWidth))));
    observer.observe(el); return () => observer.disconnect();
  }, []);
  const base = lines[0]!.signal, count = Math.max(...lines.map((l) => l.signal.percent.length));
  const values = lines.flatMap((l) => l.signal.percent.filter((v): v is number => v !== null));
  const H = 190, left = 40, right = 112, top = 10, bottom = 24;
  const low = Math.min(threshold - 5, Math.floor(Math.min(...values) - 2)), high = Math.max(104, Math.ceil(Math.max(...values) + 1));
  const x = (i: number) => left + (i * (width - left - right)) / Math.max(1, count - 1);
  const y = (v: number) => top + ((high - v) * (H - top - bottom)) / (high - low);
  const at = (i: number) => (base.from + i * base.step) * 1000;
  const path = (points: (number | null)[]) => points.reduce((d, v, i) => (v === null ? d : `${d}${d && points[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`), "");
  // Підписи кінців ліній не повинні накладатися: розсуваємо щонайменше на 14 px.
  const ends = lines.map((l) => { const last = [...l.signal.percent].reverse().find((v): v is number => v !== null) ?? 100; return { id: l.id, name: l.name, last, y: y(last) }; }).sort((a, b) => a.y - b.y);
  ends.forEach((e, i) => { if (i && e.y - ends[i - 1]!.y < 14) e.y = ends[i - 1]!.y + 14; });
  const move = (event: PointerEvent<SVGSVGElement>) => { const box = event.currentTarget.getBoundingClientRect(); setIndex(Math.min(count - 1, Math.max(0, Math.round(((event.clientX - box.left - left) / (width - left - right)) * (count - 1))))); };
  const key = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault(); setIndex((i) => Math.min(count - 1, Math.max(0, (i ?? count - 1) + (event.key === "ArrowLeft" ? -1 : 1))));
  };
  const hourly = Math.max(1, Math.round(3600 / base.step)) * (withDate ? 6 : 1);
  return <div className="context-lines" ref={host}>
    <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" tabIndex={0} onPointerMove={move} onPointerLeave={() => setIndex(null)} onKeyDown={key} onBlur={() => setIndex(null)}
      aria-label={`Зв'язність мереж у відсотках від медіани вікна. ${lines.map((l) => `${l.name}: зараз ${percent(l.signal.ratio * 100)}`).join("; ")}. Стрілки вліво й вправо — перегляд значень; повні значення в таблиці нижче.`}>
      {[high, 100, low].map((v) => <g key={v}><line className="chart-gridline" x1={left} x2={width - right} y1={y(v)} y2={y(v)} /><text className="chart-axis context-axis" x={left - 6} y={y(v) + 4} textAnchor="end">{v}%</text></g>)}
      <line className="context-threshold" x1={left} x2={width - right} y1={y(threshold)} y2={y(threshold)} />
      <text className="chart-axis context-axis" x={left + 4} y={y(threshold) - 4}>поріг {threshold}%</text>
      {[...lines].sort((a) => (a.id === "vodafone" ? 1 : -1)).map((l) => <path key={l.id} d={path(l.signal.percent)} className={l.id === "vodafone" ? "context-line context-line-own" : "context-line"} />)}
      {ends.map((e) => <text key={e.id} className={e.id === "vodafone" ? "context-end context-end-own" : "context-end"} x={width - right + 6} y={e.y + 4}>{e.name} {percent(e.last)}</text>)}
      {[0, Math.floor((count - 1) / 2), count - 1].map((i, n) => <text key={i} className="chart-axis context-axis" x={x(i)} y={H - 6} textAnchor={n === 0 ? "start" : n === 1 ? "middle" : "end"}>{clock(at(i), withDate)}</text>)}
      {index !== null && <line className="context-cursor" x1={x(index)} x2={x(index)} y1={top} y2={H - bottom} />}
    </svg>
    <div className="chart-readout" aria-live="polite">
      {index === null ? "Наведіть на графік або скористайтеся стрілками, щоб побачити значення." : <><strong>{clock(at(index), true)}</strong>{" · "}{lines.map((l) => `${l.name} ${percent(l.signal.percent[index])}`).join(" · ")}</>}
    </div>
    <details className="chart-table"><summary>Показники по операторах</summary><table className="context-stats">
      <thead><tr><th>Оператор</th><th>Зараз</th><th>Мінімум за вікно</th><th title="Медіана кількості блоків адрес /24 за вікно">Блоків /24</th></tr></thead>
      <tbody>{lines.map((l) => { const known = l.signal.percent.filter((v): v is number => v !== null); return <tr key={l.id} className={l.id === "vodafone" ? "context-stats-own" : undefined}>
        <td>{l.name} <small>AS{l.asn}</small></td><td>{percent(l.signal.ratio * 100)}</td><td>{percent(known.length ? Math.min(...known) : null)}</td><td>{l.signal.baseline.toLocaleString("uk-UA")}</td></tr>; })}</tbody>
    </table></details>
    <details className="chart-table"><summary>Таблиця значень</summary>
      <div className="tablewrap"><table><thead><tr><th>Час (Київ)</th>{lines.map((l) => <th key={l.id}>{l.name}</th>)}</tr></thead>
        <tbody>{Array.from({ length: Math.ceil(count / hourly) }, (_, n) => n * hourly).map((i) => <tr key={i}><td>{clock(at(i), true)}</td>{lines.map((l) => <td key={l.id}>{percent(l.signal.percent[i])}</td>)}</tr>)}</tbody></table></div>
    </details>
  </div>;
}
