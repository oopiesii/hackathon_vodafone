import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Calculator, ExternalLink } from "lucide-react";
import { api } from "../../lib/api";
import { Badge, Card, Dialog, Field } from "../ui";
import type { WidgetHandle } from "../../lib/dashboard-layout";
const SOURCE = "https://interfax.com.ua/news/telecom/1196790.html";
const revenuePerHour = 14_900_000_000 / (181 * 24);
const money = (value: number) => value.toLocaleString("uk-UA", { maximumFractionDigits: 0 }) + " грн";
const valid = (value: string, max: number) => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= max;
type Level = "normal" | "degraded" | "outage";
type NetworkState = { available: boolean; operators?: { id: string; signals: { source: string; ratio: number; level: Level }[] }[] };
type RegionsState = { available: boolean; regions?: { name: string; level: Level }[] };
export function Impact({ widget }: { widget?: WidgetHandle }) {
  const dialog = useRef<HTMLDialogElement>(null);
  // Ті самі ключі запитів, що й у блоках мережі: дані зі спільного кешу.
  const network = useQuery({ queryKey: ["context-network", "24h"], queryFn: () => api<NetworkState>("/context/network?window=24h"), refetchInterval: 5 * 60_000 });
  const regions = useQuery({ queryKey: ["context-regions"], queryFn: () => api<RegionsState>("/context/regions"), refetchInterval: 10 * 60_000 });
  const own = network.data?.available ? network.data.operators?.find(o => o.id === "vodafone")?.signals.find(s => s.source === "ping-slash24") : undefined;
  const troubled = regions.data?.available ? (regions.data.regions ?? []).filter(r => r.level !== "normal") : [];
  const known = own !== undefined || regions.data?.available === true;
  const incident = (own && own.level !== "normal") || troubled.length > 0;
  const [hours, setHours] = useState("1"), [share, setShare] = useState("10"), [churn, setChurn] = useState("1000"), [work, setWork] = useState("1");
  const loss = valid(hours, 240) && valid(share, 100) ? revenuePerHour * Number(hours) * Number(share) / 100 : null;
  return <>
    <Card widget={widget} className="span-4" title="Вплив на Vodafone" actions={<Badge>Припущення</Badge>} footer={<button className="btn btn-outline btn-sm" type="button" onClick={() => dialog.current?.showModal()}><Calculator size={14} aria-hidden="true" />Розрахувати сценарій</button>}>
      <div className={incident ? "impact-state impact-state-alert" : "impact-state"}>
        <strong>{!known ? "Стан мережі зараз невідомий" : incident ? "Є раптове просідання зв'язку" : "Збоїв не зафіксовано"}</strong>
        <span>{!known ? "Оцінку втрат почнемо рахувати, щойно з'являться вимірювання." : incident
          ? `${own && own.level !== "normal" ? `Мережа Vodafone — ${Math.round(Math.min(1, own.ratio) * 100)}% від звичного рівня. ` : ""}${troubled.length ? `Області: ${troubled.slice(0, 3).map(r => r.name).join(", ")}. ` : ""}Втрати залежать від тривалості й частки абонентів — порахуйте сценарій.`
          : "Оцінених грошових втрат зараз немає. Калькулятор нижче — для сценаріїв «що, якщо»."}</span>
      </div>
      <div className="impact-teaser"><span>Година виручки компанії</span><strong>≈ 3,4 млн грн</strong><small>Орієнтир масштабу · I півріччя 2026</small><a href={SOURCE} target="_blank" rel="noopener noreferrer">Джерело · 28.08.2026<ExternalLink size={12} aria-hidden="true" /></a></div>
    </Card>
    <Dialog ref={dialog} title="Оцінка впливу · припущення" titleId="impact-title">
      <div className="stack"><p className="hint">Сценарний розрахунок. Фактичні тривалість збою, частка абонентів і втрати невідомі.</p>
        <div className="impact-fields"><Field label="Тривалість, год"><input id="impact-hours" type="number" min="0" max="240" step="0.5" value={hours} onChange={e => setHours(e.target.value)} /></Field><Field label="Частка абонентів, %"><input id="impact-share" type="number" min="0" max="100" value={share} onChange={e => setShare(e.target.value)} /></Field></div>
        <div className="impact-result"><span>Оцінка недоотриманої виручки</span><output htmlFor="impact-hours impact-share" aria-live="polite">{loss === null ? "Вкажіть 0–240 год і 0–100%" : "≈ " + money(loss)}</output></div>
        <details><summary>Формула й спосіб перевірки</summary><p className="hint">14,9 млрд грн ÷ 4 344 год × тривалість × частка абонентів. Припускаємо пропорційне зменшення виручки під час повного простою; це не бухгалтерський збиток. Передплата, компенсації й відкладене споживання можуть змінити результат. Перевірка: зіставити з внутрішніми даними трафіку, білінгу та інцидентів.</p></details>
        <div className="impact-fields"><Field label="Припущений відтік, абонентів"><input id="impact-churn" type="number" min="0" max="15100000" value={churn} onChange={e => setChurn(e.target.value)} /></Field><div className="impact-secondary"><span>Виручка за рік під ризиком</span><output htmlFor="impact-churn">{valid(churn, 15100000) ? "≈ " + money(Number(churn) * 154 * 12) : "Вкажіть кількість 0–15,1 млн"}</output></div></div>
        <p className="hint">Припущення: середній ARPU 154 грн/міс. зберігається 12 місяців. Реальний відтік невідомий; потрібні дані MNP та утримання.</p>
        <div className="impact-fields"><Field label="Реагування, людино-годин"><input id="impact-work" type="number" min="0" max="10000" step="0.5" value={work} onChange={e => setWork(e.target.value)} /></Field><div className="impact-secondary"><span>Вартість реагування</span><output htmlFor="impact-work">{valid(work, 10000) ? "≈ $" + (Number(work) * 15).toLocaleString("uk-UA") : "Вкажіть 0–10 000 год"}</output></div></div>
        <p className="hint">Ставка $15 за людино-годину — орієнтир ментора, не виміряні витрати. Для перевірки підставте фактичні години й внутрішню ставку команди.</p>
        <a className="btn btn-ghost btn-sm" href={SOURCE} target="_blank" rel="noopener noreferrer">Фінансові показники · Інтерфакс-Україна, 28.08.2026<ExternalLink size={14} aria-hidden="true" /></a>
      </div>
    </Dialog>
  </>;
}
