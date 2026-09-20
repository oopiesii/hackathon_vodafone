import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Star } from "lucide-react";
import { api } from "../../lib/api";
import { plural } from "../../lib/plural";
import { Badge, Card } from "../ui";
import type { WidgetHandle } from "../../lib/dashboard-layout";

type Review = { rating: number; date: string; version: string; title: string; text: string };
type App = {
  id: "vodafone" | "kyivstar" | "lifecell"; name: string; url: string; sample: number; negative: number; negative_share: number | null; average: number | null;
  unavailable?: "empty" | "error"; stale_at?: string;
  period: { from: string | null; to: string | null }; store_rating: number | null; store_count: number | null;
  distribution: { stars: number; count: number }[]; daily: { date: string; negative: number; other: number }[]; recent_negative: Review[];
};
type ReviewsResponse = { available: false; reason: string } | { available: true; fetched_at: string; apps: App[] };

const num = (v: number | null, digits = 1) => (v === null ? "—" : v.toLocaleString("uk-UA", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const day = (iso: string | null) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "—");
const clock = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const stars = (app: App, from: number, to: number) => app.distribution.filter((d) => d.stars >= from && d.stars <= to).reduce((a, d) => a + d.count, 0);

/** Голос клієнта: публічна вибірка з офіційних сторінок App Store. Оцінка в зірках — розмітка від самих користувачів, без моделі. */
export function AppReviews({ widget }: { widget?: WidgetHandle }) {
  const query = useQuery({ queryKey: ["context-reviews"], queryFn: () => api<ReviewsResponse>("/context/reviews"), refetchInterval: 30 * 60_000 });
  const data = query.data, ready = data?.available ? data : null;
  const own = ready?.apps.find((a) => a.id === "vodafone" && a.sample > 0);
  const missing = ready?.apps.filter((a) => a.sample === 0) ?? [];
  const stale = ready?.apps.filter((a) => a.stale_at) ?? [];
  return (
    <Card widget={widget} className="span-5 context-card" title="Відгуки App Store"
      actions={<Badge tone="secondary" title="Apple показує публічну вибірку на сторінці застосунку; вона не репрезентує всіх користувачів.">Сторінка App Store</Badge>}
      footer={<span className="note context-source">Офіційні сторінки apps.apple.com · app ID перевірено через Apple Lookup · автори не зберігаються · публічна вибірка, не всі користувачі{stale.length ? ` · ${stale.map((a) => `${a.name} — збережений зріз ${clock(a.stale_at!)}`).join("; ")}` : ""}{missing.length ? ` · ${missing.map((a) => a.name).join(", ")} — сторінка не віддала відгуків, це не означає, що їх немає` : ""}</span>}>
      {query.isPending && <div className="chart-no-data" role="status">Отримуємо відгуки…</div>}
      {data && !data.available && <div className="chart-no-data">{data.reason}</div>}
      {query.isError && <div className="chart-no-data">Не вдалося отримати відгуки.</div>}
      {ready && <div className="reviews">
        <div className="reviews-legend chart-legend"><span><i className="reaction-negative" />1–2★</span><span><i className="reaction-sad" />3★</span><span><i className="review-positive" />4–5★</span></div>
        <div className="reviews-rows">
          {ready.apps.map((app) => <ReviewRow key={app.id} app={app} />)}
        </div>
        {own && own.daily.length > 1 && <Daily app={own} />}
        {own && own.recent_negative.length > 0 && <div className="reviews-quotes">
          {own.recent_negative.slice(0, 2).map((r, i) => <Quote key={i} review={r} />)}
          {own.recent_negative.length > 2 && <details><summary>Ще {own.recent_negative.length - 2} {plural(own.recent_negative.length - 2, "негативний відгук", "негативні відгуки", "негативних відгуків")} Vodafone</summary>
            <div className="reviews-quotes">{own.recent_negative.slice(2).map((r, i) => <Quote key={i} review={r} />)}</div></details>}
        </div>}
      </div>}
    </Card>
  );
}

function ReviewRow({ app }: { app: App }) {
  if (app.sample === 0) return <a className="reviews-row reviews-row-empty" href={app.url} target="_blank" rel="noopener noreferrer"
    aria-label={`${app.name}: сторінка App Store не віддала відгуків, дані відсутні`}>
    <span className="reviews-name">{app.name}<ExternalLink size={12} aria-hidden="true" /></span>
    <span className="reviews-missing">{app.unavailable === "error" ? "сторінка недоступна" : "відгуків у відповіді немає"}</span>
  </a>;
  const parts = [{ kind: "reaction-negative", value: stars(app, 1, 2) }, { kind: "reaction-sad", value: stars(app, 3, 3) }, { kind: "review-positive", value: stars(app, 4, 5) }];
  let offset = 0;
  return <a className={app.id === "vodafone" ? "reviews-row reviews-row-own" : "reviews-row"} href={app.url} target="_blank" rel="noopener noreferrer"
    aria-label={`${app.name}: ${app.negative} з ${app.sample} останніх відгуків негативні; середня оцінка вибірки ${num(app.average)}; рейтинг у магазині ${num(app.store_rating, 2)}`}>
    <span className="reviews-name">{app.name}<ExternalLink size={12} aria-hidden="true" /></span>
    <svg className="reviews-bar" viewBox="0 0 300 12" preserveAspectRatio="none" aria-hidden="true">
      {parts.map((p) => { const width = app.sample ? (p.value / app.sample) * 300 : 0, x = offset; offset += width; return width > 0 && <rect key={p.kind} className={p.kind} x={x + (x ? 1 : 0)} y="0" width={Math.max(0, width - (x ? 1 : 0))} height="12" />; })}
    </svg>
    <strong className="reviews-share">{app.negative_share === null ? "—" : `${Math.round(app.negative_share * 100)}%`}</strong>
    <span className="reviews-meta" title={`Рейтинг у магазині за весь час: ${num(app.store_rating, 2)} (${app.store_count?.toLocaleString("uk-UA") ?? "—"} оцінок)`}><Star size={12} aria-hidden="true" />{num(app.average)} <small>/ {num(app.store_rating, 2)}</small></span>
    <span className="reviews-period">{app.sample} {plural(app.sample, "відгук", "відгуки", "відгуків")} · {day(app.period.from)}–{day(app.period.to)}</span>
  </a>;
}

function Daily({ app }: { app: App }) {
  const max = Math.max(1, ...app.daily.map((d) => d.negative + d.other)), W = 300, H = 44, step = W / app.daily.length, bar = Math.min(10, step - 2);
  return <figure className="reviews-daily">
    <figcaption className="note">Vodafone за днями: негативні та решта</figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Відгуки Vodafone за днями з ${day(app.period.from)} до ${day(app.period.to)}; найбільше за день — ${max}`}>
      {app.daily.map((d, i) => { const x = i * step + (step - bar) / 2, neg = (d.negative / max) * (H - 2), rest = (d.other / max) * (H - 2);
        return <g key={d.date}><title>{`${day(d.date)}: негативних ${d.negative}, решта ${d.other}`}</title>
          {d.other > 0 && <rect className="review-positive" x={x} y={H - rest - neg - (neg ? 1 : 0)} width={bar} height={rest} />}
          {d.negative > 0 && <rect className="reaction-negative" x={x} y={H - neg} width={bar} height={neg} />}</g>; })}
    </svg>
  </figure>;
}

function Quote({ review }: { review: Review }) {
  return <blockquote className="reviews-quote"><span className="reviews-quote-head"><Badge tone="warning">{review.rating}★</Badge><span className="note">{day(review.date)}{review.version ? ` · версія ${review.version}` : ""}</span></span>
    <strong>{review.title}</strong><span>{review.text}</span></blockquote>;
}
