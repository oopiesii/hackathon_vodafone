import type { DashboardResponse } from "@ufv/shared/dashboard";
import { useQuery } from "@tanstack/react-query";
import { SendHorizontal, Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api } from "../../lib/api";
import { Badge } from "../ui";

// Ті самі ключі запитів, що й у блоках нижче: дані беруться зі спільного кешу, зайвих звернень до API немає.
type Level = "normal" | "degraded" | "outage";
type Network = { available: boolean; operators?: { id: string; name: string; signals: { source: string; ratio: number; level: Level }[] }[]; events?: unknown[] };
type Regions = { available: boolean; regions?: { name: string; ratio: number; level: Level }[] };
type Reviews = { available: boolean; apps?: { id: string; name: string; sample: number; negative_share: number | null; recent_negative: { title: string; text: string }[] }[] };

const capped = (ratio: number) => Math.min(1, ratio);
const drop = (ratio: number) => `−${Math.max(0, Math.round((1 - ratio) * 100))}%`;
const pct = (ratio: number | null | undefined, digits = 0) => (ratio == null ? "—" : `${(ratio * 100).toLocaleString("uk-UA", { maximumFractionDigits: digits })}%`);
const int = (value: number | null | undefined) => (value == null ? "—" : value.toLocaleString("uk-UA"));
const WINDOW = { "24h": "за добу", "7d": "за 7 днів", "30d": "за 30 днів" } as const;
const THEMES: [string, RegExp][] = [
  ["підтримка", /дозвон|дописа|оператор[ауо]?\b|підтрим|поддерж|чат|гаряч|горяч/i],
  ["списання й тарифи", /баланс|спис|гроші|деньги|тариф|поповн|пополн|мінус|минус/i],
  ["зв'язок та інтернет", /зв'яз|связь|інтернет|интернет|мереж|сеть|покритт|не лов|швидк|скорост/i],
  ["застосунок", /додаток|застосун|приложен|оновлен|обновлен|вхід|логін|вилітає/i],
];

type Fact = { key: string; text: string; href?: string };
type Advice = { text: string; why: string };
type Brief = { tone: "calm" | "attention" | "critical"; headline: string; facts: Fact[]; advice: Advice[]; answers: Record<string, { label: string; text: string }> };

/** Підсумок за правилами з живих показників екрана. З ключем LLM заголовок і спостереження замінює зведення моделі (data.ai). */
function build(d: DashboardResponse, network?: Network, regions?: Regions, reviews?: Reviews): Brief {
  const own = network?.available ? network.operators?.find((o) => o.id === "vodafone")?.signals.find((s) => s.source === "ping-slash24") : undefined;
  const troubled = regions?.available ? (regions.regions ?? []).filter((r) => r.level !== "normal") : [];
  const app = reviews?.available ? reviews.apps?.find((a) => a.id === "vodafone") : undefined;
  const rivals = reviews?.available ? (reviews.apps ?? []).filter((a) => a.id !== "vodafone") : [];
  const critical = d.signals.filter((s) => s.level === "h");
  const mentions = d.metrics.mentions.value ?? 0, negative = d.metrics.negative_share.value;
  const rivalMentions = d.competitors.reduce((a, c) => a + c.count, 0), vodafone = d.vodafone_7d?.count;
  const themes = app ? THEMES.map(([name, re]) => [name, app.recent_negative.filter((r) => re.test(`${r.title} ${r.text}`)).length] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]) : [];

  const tone: Brief["tone"] = own?.level === "outage" || troubled.some((r) => r.level === "outage") || critical.length ? "critical"
    : own?.level === "degraded" || troubled.length || (negative !== null && negative >= 35) ? "attention" : "calm";
  const headline = own && own.level !== "normal" ? `Мережа Vodafone працює гірше, ніж зазвичай: ${pct(capped(own.ratio), 1)} від звичного рівня.`
    : critical.length ? `Критичний сигнал: ${critical[0]!.title}`
    : troubled.length ? `Раптове просідання зв'язку: ${troubled.slice(0, 3).map((r) => `${r.name} ${drop(r.ratio)}`).join(", ")}. Звідти варто чекати скарг.`
    : negative !== null && negative >= 35 ? `Масових збоїв немає, але негативу багато: ${int(Math.round(negative))}% реакцій під тематичними постами — негатив або іронія.`
    : "Спокійно: масових збоїв і критичних сигналів немає.";

  const facts: Fact[] = [];
  facts.push({ key: "mentions", href: d.metrics.mentions.href, text: `${int(mentions)} тематичних матеріалів ${WINDOW[d.window]}${vodafone != null ? `; прямо про Vodafone за 7 днів — ${int(vodafone)}` : ""}` });
  if (d.counts.collected != null) facts.push({ key: "funnel", text: `Зібрано ${int(d.counts.collected)} матеріалів, ${int(d.counts.rejected ?? d.metrics.noise?.value)} відсіяно як шум — аналітик читає лише суттєве` });
  if (own) facts.push({ key: "network", text: `Мережа Vodafone: ${pct(capped(own.ratio), 1)} від звичного рівня доби; зафіксованих збоїв за 30 днів — ${int(network?.events?.length ?? 0)}` });
  if (regions?.available) facts.push({ key: "regions", text: troubled.length ? `Області з раптовим просіданням зв'язку: ${troubled.map((r) => r.name).join(", ")}` : `Раптових збоїв зв'язку за добу немає ні в одній із ${int(regions.regions?.length)} областей` });
  if (app) facts.push({ key: "reviews", text: `App Store: ${pct(app.negative_share)} негативних серед останніх ${app.sample} відгуків${rivals.length ? ` (${rivals.map((r) => `${r.name} — ${pct(r.negative_share)}`).join(", ")})` : ""}` });
  if (negative !== null) facts.push({ key: "reactions", href: d.reactions.href, text: `Негатив та іронія — ${int(Math.round(negative))}% реакцій під тематичними постами` });
  if (rivalMentions) facts.push({ key: "rivals", text: `Конкуренти в інфополі: ${d.competitors.filter((c) => c.count).map((c) => `${c.brand === "kyivstar" ? "Київстар" : c.brand} — ${int(c.count)}`).join(", ")}` });

  const advice: Advice[] = [];
  if (own && own.level !== "normal") advice.push({ text: "Опублікувати статус у Telegram і оновлювати його кожні 60–90 хв, доки показник не повернеться до норми.", why: "зовнішні вимірювання показують падіння доступності мережі" });
  if (troubled.length) advice.push({ text: `Підготувати відповідь абонентам (${troubled.slice(0, 3).map((r) => r.name).join(", ")}) і звірити причину з технічною службою.`, why: "просідання зв'язку в області зазвичай випереджає хвилю скарг" });
  if (critical.length) advice.push({ text: "Відкрити критичний сигнал, перевірити цитати й першоджерела та призначити статус дій.", why: `${int(critical.length)} сигнал(и) найвищого рівня за правилами` });
  if (negative !== null && negative >= 35) advice.push({ text: "Переглянути пости з найбільшим негативом і перевірити, чи реакції стосуються оператора, а не самої події.", why: `${int(Math.round(negative))}% реакцій — негатив або іронія` });
  if (app && themes.length && (app.negative_share ?? 0) >= 0.3) advice.push({ text: `Розібрати скарги в App Store: найчастіша тема — ${themes[0]![0]}${themes[1] ? `, далі ${themes[1][0]}` : ""}. Відповісти на відгуки з 1★.`, why: `${pct(app.negative_share)} останніх відгуків негативні` });
  if (vodafone != null && rivalMentions >= 3 * Math.max(1, vodafone)) advice.push({ text: "Конкуренти помітніші в інфополі — переглянути їхні приводи та оцінити, чи потрібна відповідь.", why: `${int(rivalMentions)} згадок конкурентів проти ${int(vodafone)} у Vodafone` });
  if (!advice.length) advice.push({ text: "Термінових дій не потрібно. Тримати готовими шаблони відповідей на типові скарги.", why: "немає збоїв, критичних сигналів і сплеску негативу" });

  const fact = (key: string) => facts.find((f) => f.key === key)?.text;
  const answers: Brief["answers"] = {
    now: { label: "Що зараз?", text: `${headline} ${facts.slice(0, 2).map((f) => f.text).join(". ")}.` },
    network: { label: "Що з мережею?", text: [fact("network"), fact("regions")].filter(Boolean).join(". ") + ". Це зовнішні вимірювання, які ловлять раптові збої відносно звичного рівня доби; хронічний стан зв'язку у прифронтових областях і окремі вишки вони не показують." },
    reviews: { label: "Що кажуть клієнти?", text: app ? `${fact("reviews")}.${themes.length ? ` Найчастіші теми скарг: ${themes.map(([n, c]) => `${n} (${c})`).join(", ")}.` : ""} Це найновіші відгуки, а не всі користувачі: рейтинг застосунку в магазині значно вищий.` : "Відгуки App Store зараз недоступні." },
    rivals: { label: "Що у конкурентів?", text: `${fact("rivals") ?? "Згадок конкурентів у вибраному вікні немає"}.${rivals.length ? ` У відгуках App Store негативних: ${rivals.map((r) => `${r.name} — ${pct(r.negative_share)}`).join(", ")}; у Vodafone — ${pct(app?.negative_share)}.` : ""}` },
    actions: { label: "Що робити?", text: advice.map((a, i) => `${i + 1}. ${a.text}`).join(" ") + " Це рекомендації за правилами, а не встановлені факти." },
    money: { label: "Скільки це коштує?", text: "Орієнтир: година виручки Vodafone Україна ≈ 3,4 млн грн (14,9 млрд грн за I півріччя 2026). Збій на 10% абонентів протягом години — порядку 340 тис. грн. Кожна 1 000 абонентів, що пішли, — ≈ 1,85 млн грн на рік. Це оцінки за припущенням пропорційності; калькулятор — у блоці «Вплив на Vodafone»." },
  };
  return { tone, headline, facts, advice, answers };
}

function intent(text: string): string | null {
  const t = text.toLowerCase();
  if (/мереж|вишк|зв'яз|звяз|област|збій|збо[ії]/.test(t)) return "network";
  if (/відгук|отзыв|клієнт|app ?store|застосун|скарг/.test(t)) return "reviews";
  if (/конкурент|київстар|kyivstar|lifecell|лайф/.test(t)) return "rivals";
  if (/грош|кошту|втрат|вируч|\$|долар/.test(t)) return "money";
  if (/робити|діяти|рекоменд|порад|дії\b/.test(t)) return "actions";
  if (/зараз|сьогодні|стан|підсум|звед|звіт|головне/.test(t)) return "now";
  return null;
}

export function Briefing({ data }: { data: DashboardResponse }) {
  const span = data.window === "24h" ? "24h" : "7d";
  const network = useQuery({ queryKey: ["context-network", span], queryFn: () => api<Network>(`/context/network?window=${span}`), refetchInterval: 5 * 60_000 });
  const regions = useQuery({ queryKey: ["context-regions"], queryFn: () => api<Regions>("/context/regions"), refetchInterval: 10 * 60_000 });
  const reviews = useQuery({ queryKey: ["context-reviews"], queryFn: () => api<Reviews>("/context/reviews"), refetchInterval: 30 * 60_000 });
  const brief = build(data, network.data, regions.data, reviews.data);
  const ai = data.ai.mode === "ai" && data.ai.status === "ready" ? data.ai : null;
  const [log, setLog] = useState<{ q: string; key: string | null }[]>([]), [draft, setDraft] = useState("");
  const asked = new Set(log.map((l) => l.key));
  const ask = (q: string, key: string | null) => setLog((prev) => [...prev, { q, key }].slice(-4));
  const submit = (event: FormEvent) => { event.preventDefault(); const q = draft.trim(); if (!q) return; ask(q, intent(q)); setDraft(""); };
  // LLM-SEAM(S5-chat): з ключем питання йде на сервер (намір → SQL-агрегати → відповідь моделі з доказами); зараз відповіді складаються з показників екрана.
  return (
    <section className={`briefing briefing-${brief.tone}`} aria-labelledby="briefing-title">
      <div className="briefing-main">
        <div className="briefing-eyebrow"><span id="briefing-title">Головне зараз</span>
          {ai ? <Badge tone="info"><Sparkles size={12} aria-hidden="true" />AI-зведення · {ai.model ?? "модель"}</Badge> : <Badge tone="secondary" title="Зведення моделі з'явиться після додавання ключа LLM; зараз підсумок складається за правилами з показників екрана.">За правилами · AI очікує ключ</Badge>}
        </div>
        <h2 className="briefing-headline">{ai ? ai.summary : brief.headline}</h2>
        {ai && <p className="note">Показники екрана: {brief.headline}</p>}
        <ul className="briefing-facts">{brief.facts.map((f) => <li key={f.key}>{f.href ? <Link to={f.href}>{f.text}</Link> : f.text}</li>)}</ul>
      </div>
      <div className="briefing-advice">
        <h3>Що з цим робити <Badge tone="secondary">рекомендації, не факти</Badge></h3>
        <ol>{brief.advice.map((a, i) => <li key={i}>{a.text}<span>Чому: {a.why}.</span></li>)}</ol>
      </div>
      <div className="briefing-chat">
        {log.length > 0 && <div className="briefing-log" role="log" aria-live="polite">{log.map((l, i) => <div key={i}>
          <p className="briefing-q">{l.q}</p>
          <p className="briefing-a">{l.key ? brief.answers[l.key]!.text : "Поки відповідаю лише про показники цього екрана: стан зараз, мережа й області, відгуки клієнтів, конкуренти, гроші, що робити. Вільні запитання запрацюють після додавання ключа LLM."}</p>
        </div>)}</div>}
        <div className="briefing-ask">
          <span className="briefing-more">{log.length ? "Хочеш дізнатись більше?" : "Запитайте аналітика:"}</span>
          {Object.entries(brief.answers).filter(([key]) => !asked.has(key)).slice(0, 4).map(([key, a]) => <button key={key} type="button" className="btn btn-outline btn-sm" onClick={() => ask(a.label, key)}>{a.label}</button>)}
          <form onSubmit={submit}><label className="sr-only" htmlFor="briefing-input">Питання до аналітика</label>
            <input id="briefing-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Або напишіть своє питання…" autoComplete="off" />
            <button type="submit" className="btn btn-sm" aria-label="Запитати"><SendHorizontal size={14} aria-hidden="true" /></button></form>
        </div>
      </div>
    </section>
  );
}
