import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api } from "../../lib/api";
import { plural } from "../../lib/plural";
import { Badge, Card } from "../ui";

type Region = { code: string; name: string; frontline?: boolean; ratio: number; level: "normal" | "degraded" | "outage"; lowest: number; lowest_at: string; percent: (number | null)[] };
type RegionsResponse = { available: false; reason: string } | { available: true; fetched_at: string; regions: Region[] };

const LEVEL = { normal: "Без раптових змін", degraded: "Різке просідання", outage: "Раптовий збій" } as const;
// Показуємо відхилення від звичного рівня доби, а не «відсоток здоров'я»: вище звичного — це теж «без змін».
const change = (ratio: number) => { const drop = Math.round((1 - ratio) * 100); return drop >= 3 ? `−${drop}%` : "без змін"; };
const clock = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });

/** Раптові зміни зв'язності інтернету по областях за добу (усі оператори разом). Хронічних руйнувань не показує — див. примітку в блоці. */
export function RegionsHealth() {
  const query = useQuery({ queryKey: ["context-regions"], queryFn: () => api<RegionsResponse>("/context/regions"), refetchInterval: 10 * 60_000 });
  const data = query.data, ready = data?.available ? data : null;
  const troubled = ready?.regions.filter((r) => r.level !== "normal") ?? [];
  const dipped = ready ? [...ready.regions].sort((a, b) => a.lowest - b.lowest)[0] : undefined;
  return (
    <Card className="span-12 context-card" title="Раптові збої зв'язку по областях · 24 години"
      actions={ready && (troubled.length
        ? <Badge tone={troubled.some((r) => r.level === "outage") ? "danger" : "warning"} dot>{troubled.length} {plural(troubled.length, "область", "області", "областей")} з раптовим просіданням</Badge>
        : <Badge tone="success" dot>Раптових збоїв немає</Badge>)}
      footer={<span className="note context-source">
        Зовнішні вимірювання <a href="https://ioda.inetintel.cc.gatech.edu/country/UA" target="_blank" rel="noopener noreferrer">IODA, Georgia Tech<ExternalLink size={12} aria-hidden="true" /></a>
        {" "}· усі оператори разом, не окремі вишки · відхилення — від звичного рівня області за цю ж добу · без Криму, Севастополя й Луганщини{ready ? ` · оновлено ${clock(ready.fetched_at)}` : ""}
      </span>}>
      {query.isPending && <div className="chart-no-data" role="status">Отримуємо вимірювання…</div>}
      {data && !data.available && <div className="chart-no-data">{data.reason}</div>}
      {query.isError && <div className="chart-no-data">Не вдалося отримати вимірювання.</div>}
      {ready && <>
        <p className="regions-lead">
          {troubled.length
            ? <>Різко гірше, ніж було цієї доби: {troubled.slice(0, 4).map((r) => `${r.name} ${change(r.ratio)}`).join(", ")}. Звідти варто чекати скарг на зв'язок.</>
            : <>Раптових збоїв зв'язку за добу немає.{dipped && dipped.lowest < 0.97 ? ` Найглибше короткочасне просідання: ${dipped.name}, ${change(dipped.lowest)} о ${clock(dipped.lowest_at)}.` : ""}</>}
        </p>
        <p className="regions-caveat"><strong>Що цей блок не показує.</strong> Він порівнює «зараз» зі звичним рівнем цієї ж доби, тому ловить лише раптові збої. У прифронтових областях зв'язок хронічно гірший — але там це вже і є «звичний рівень», тож «без змін» не означає «все добре».</p>
        <div className="regions-grid">
          {ready.regions.map((r) => <a key={r.code} className={`region region-${r.level}`} href={`https://ioda.inetintel.cc.gatech.edu/region/${r.code}`} target="_blank" rel="noopener noreferrer"
            aria-label={`${r.name}${r.frontline ? ", прифронтова" : ""}: ${change(r.ratio)} відносно звичного рівня доби, ${LEVEL[r.level]}; найглибше просідання за добу ${change(r.lowest)} о ${clock(r.lowest_at)}`}>
            <span className="region-name">{r.name}</span>
            <strong className={change(r.ratio) === "без змін" ? "region-value region-value-flat" : "region-value"}>{change(r.ratio)}</strong>
            <Spark points={r.percent} />
            <span className="region-state"><i aria-hidden="true" />{LEVEL[r.level]}{r.frontline && r.level === "normal" ? " · прифронтова" : ""}</span>
          </a>)}
        </div>
      </>}
    </Card>
  );
}

function Spark({ points }: { points: (number | null)[] }) {
  const known = points.filter((v): v is number => v !== null);
  if (known.length < 2) return <span className="region-spark" />;
  // Спільна шкала 50–105% для всіх областей: однаковий нахил означає однакове падіння.
  const y = (v: number) => 22 - ((Math.min(105, Math.max(50, v)) - 50) * 20) / 55;
  const d = points.reduce((path, v, i) => (v === null ? path : `${path}${path && points[i - 1] != null ? "L" : "M"}${((i * 100) / (points.length - 1)).toFixed(1)},${y(v).toFixed(1)}`), "");
  return <svg className="region-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><path d={d} /></svg>;
}
