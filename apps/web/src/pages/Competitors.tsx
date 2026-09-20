import type { BrandSummary, DashboardResponse, DashboardWindow } from "@ufv/shared/dashboard";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ExternalLink } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { Alert, Badge, Card, PageHeader, Tabs } from "../components/ui";
import { BarList } from "../components/charts/BarList";
import { api, errorText } from "../lib/api";
import { TOPICS } from "../lib/labels";
import { brandName, quantity } from "../lib/plural";
import { formatDateTime } from "../lib/format";

const percent = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
const int = (value: number) => value.toLocaleString("uk-UA");

/** Конкуренти на тих самих матеріалах, що й дашборд: кількість — це зібрані публікації,
 *  а не частка ринку й не охоплення аудиторії. Кожне число веде до матеріалів. */
export function Competitors() {
  const [params, setParams] = useSearchParams();
  const value = params.get("window");
  const window: DashboardWindow = value === "7d" || value === "30d" ? value : "24h";
  const workflow = params.get("workflow_id") || "1";
  const query = useQuery({ queryKey: ["dashboard", workflow, window, "competitors"], queryFn: () => api<DashboardResponse>(`/dashboard?${new URLSearchParams({ workflow_id: workflow, window })}`), refetchInterval: 300000 });
  const data = query.data;
  const brands = data?.brands ?? [];
  const total = brands.reduce((sum, b) => sum + b.count, 0);
  const setWindow = (next: string) => { const copy = new URLSearchParams(params); copy.set("window", next); setParams(copy); };

  return <div className="dashboard">
    <PageHeader title="Конкуренти" description="Vodafone поруч із Київстар і lifecell на одних і тих самих зібраних матеріалах."
      breadcrumb={<Link className="btn btn-ghost btn-sm" to={`/?workflow_id=${workflow}&window=${window}`}>До дашборда</Link>} />
    <div className="dashboard-controls">
      <Tabs label="Період порівняння" value={window} onChange={setWindow} items={[{ value: "24h", label: "Сьогодні" }, { value: "7d", label: "7 днів" }, { value: "30d", label: "30 днів" }]} />
      <span className="dashboard-period">{window === "24h" ? "Останні 24 години" : `Останні ${window === "7d" ? "7" : "30"} днів`} · Україна</span>
    </div>

    {query.isError && <Alert tone="danger"><div>Не вдалося отримати порівняння. {errorText(query.error)}</div><button className="btn btn-outline btn-sm" type="button" onClick={() => query.refetch()}>Спробувати знову</button></Alert>}
    {query.isPending && <p className="loading" role="status">Збираємо матеріали за брендами…</p>}

    {data && !total && <Alert>За вибраний період матеріалів із жодним із трьох брендів немає. Це стан збору, а не доказ відсутності подій.</Alert>}

    {data && Boolean(total) && <>
      <Card className="span-12" title="Частка в зібраних матеріалах" actions={<Badge tone="secondary" title="Це частка публікацій у нашій вибірці, а не частка ринку, не охоплення й не кількість абонентів.">Не частка ринку</Badge>}
        footer={<span className="note">Усього {quantity(total, "матеріал", "матеріали", "матеріалів")} за період. Перепублікації однієї новини рахуються окремо й не є незалежними підтвердженнями.</span>}>
        <BarList data={brands.filter(b => b.count).map(b => ({ id: b.brand, label: brandName(b.brand), value: b.count, href: b.href }))} />
      </Card>

      <div className="dashboard-grid competitors-grid">
        {brands.map(brand => <BrandCard key={brand.brand} brand={brand} window={window} />)}
      </div>

      <details className="dashboard-methodology"><summary>Як читати це порівняння</summary>
        <ul>
          <li>Кількість — це зібрані матеріали з дозволених джерел, а не згадки в усьому інтернеті. Покриття джерел у брендів різне.</li>
          <li>Негатив визначено чинним відбором (розмітка моделі зі знімка або правила). Точність не вимірювалась.</li>
          <li>Частка негативних реакцій рахується лише там, де лічильники реакцій отримано; для новинних джерел їх зазвичай немає.</li>
          <li>За 30 днів доступні лише агрегати: тексти й приклади показуються у вікнах 24 години та 7 днів.</li>
          <li>Оцінки «сильний хід» чи «можливість» тут не робляться: для цього потрібен окремий шов S7 і ключ моделі.</li>
        </ul>
      </details>
    </>}
  </div>;
}

function BrandCard({ brand, window }: { brand: BrandSummary; window: DashboardWindow }) {
  const share = brand.count ? brand.negative / brand.count : null;
  return <Card className="span-4" title={brandName(brand.brand)}
    actions={brand.brand === "vodafone" ? <Badge>Наш бренд</Badge> : <Badge tone="secondary">Конкурент</Badge>}
    footer={<Link className="btn btn-ghost btn-sm" to={brand.href}>Відкрити матеріали<ArrowUpRight size={14} aria-hidden="true" /></Link>}>
    <div className="brand-figures">
      <div><strong>{int(brand.count)}</strong><span>{quantity(brand.count, "матеріал", "матеріали", "матеріалів")}</span></div>
      <div><strong>{int(brand.negative)}</strong><span>негативних{share === null ? "" : ` · ${percent(share)}`}</span></div>
      <div><strong>{percent(brand.reaction_negative_share)}</strong><span>негативних реакцій{brand.reaction_total ? ` · ${int(brand.reaction_total)} вимірювань` : " · немає вимірювань"}</span></div>
    </div>
    {brand.topics.length > 0 && <BarList data={brand.topics.map(t => ({ id: t.topic, label: TOPICS[t.topic] ?? t.topic, value: t.count, href: t.href }))} />}
    {window === "30d"
      ? <p className="note">За місяць показуємо лише агрегати. Приклади матеріалів — у вікнах 24 години та 7 днів.</p>
      : brand.latest.length
        ? <ul className="brand-latest">{brand.latest.map(item => <li key={item.id}>
            <span className="brand-latest-meta">{item.negative && <Badge tone="warning">Негатив</Badge>}<span>{TOPICS[item.topic] ?? item.topic}</span><span>{item.source_title ?? "джерело невідоме"}</span><span>{formatDateTime(item.published_at)}</span></span>
            <blockquote className="quote">{item.quote}</blockquote>
            <span className="row">
              <Link className="btn btn-ghost btn-sm" to={item.href}>Контекст і доказ</Link>
              {item.url && <a className="btn btn-ghost btn-sm" href={item.url} target="_blank" rel="noopener noreferrer">Оригінал<ExternalLink size={14} aria-hidden="true" /></a>}
            </span>
          </li>)}</ul>
        : <p className="note">Матеріалів із цим брендом за період немає.</p>}
  </Card>;
}
