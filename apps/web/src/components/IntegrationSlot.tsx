import { useRef, useState } from "react";
import { ArrowLeft, ChevronRight, RadioTower } from "lucide-react";
import { Badge, Card, Dialog, Field } from "./ui";
import { DEMO_REGIONS, type DemoTower } from "../demo/towers";
import { quantity } from "../lib/plural";
import networkSchema from "../../../../packages/contracts/events/network.site.status.v1.schema.json?raw";
import type { WidgetHandle } from "../lib/dashboard-layout";

const states = { available: { label: "Доступна", tone: "success" }, unavailable: { label: "Недоступна", tone: "warning" }, unknown: { label: "Невідомо", tone: "secondary" } } as const;
export function IntegrationSlot({ widget }: { widget?: WidgetHandle }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [region, setRegion] = useState<string | null>(null), [site, setSite] = useState<DemoTower | null>(null);
  const [minutes, setMinutes] = useState(30);
  const selected = DEMO_REGIONS.find(r => r.id === region);
  const open = () => { setRegion(null); setSite(null); dialog.current?.showModal(); };
  return <>
    <Card widget={widget} className="span-4" title="Стан мережі" actions={<Badge tone="secondary">Демо</Badge>} footer={<button className="btn btn-outline btn-sm" type="button" onClick={open}>Регіони та вишки<ChevronRight size={14} aria-hidden="true" /></button>}>
      <div className="integration-teaser"><RadioTower size={24} aria-hidden="true" /><strong>Інтеграцію не підключено</strong><span>Реальний стан мережі невідомий</span><div className="row">{DEMO_REGIONS.map(r => <button type="button" className="btn btn-ghost btn-sm" key={r.id} onClick={() => { setRegion(r.id); setSite(null); dialog.current?.showModal(); }}>{r.name}</button>)}</div></div>
    </Card>
    <Dialog ref={dialog} title={site ? `Демо · ${site.id}` : selected ? `Демо · ${selected.name}` : "Демо · стан мережі"} titleId="network-slot-title">
      <div className="stack">
        <Badge tone="warning">Демо · інтеграцію не підключено</Badge>
        {(selected || site) && <button type="button" className="btn btn-ghost btn-sm slot-back" onClick={() => site ? setSite(null) : setRegion(null)}><ArrowLeft size={14} aria-hidden="true" />{site ? "До вишок регіону" : "До регіонів"}</button>}
        {site ? <div className="stack"><div className="row"><h3>{site.label}</h3><Badge tone={states[site.status].tone}>{states[site.status].label}</Badge></div><p>{site.reason}</p><dl className="meta-list"><dt>Майданчик</dt><dd>{site.id}</dd><dt>Останнє спостереження</dt><dd>Синтетичний сценарій, реальних даних немає</dd><dt>Коментарі абонентів</dt><dd>Не пов’язані з цим демо</dd></dl></div>
          : selected ? <div className="slot-list">{selected.sites.map(s => <button type="button" className="slot-row" key={s.id} onClick={() => setSite(s)}><span><strong>{s.id}</strong><small>{s.label}</small></span><Badge tone={states[s.status].tone}>{states[s.status].label}</Badge><ChevronRight size={16} aria-hidden="true" /></button>)}</div>
          : <div className="slot-list">{DEMO_REGIONS.map(r => <button type="button" className="slot-row" key={r.id} onClick={() => setRegion(r.id)}><strong>{r.name}</strong><span>{quantity(r.sites.length, "вишка", "вишки", "вишок")}</span><ChevronRight size={16} aria-hidden="true" /></button>)}</div>}
        <details><summary>Як поєднати зі скаргами</summary><div className="stack"><Field label="Вікно після відмови, хв"><input type="number" min="1" max="180" value={minutes} onChange={e => setMinutes(Math.min(180, Math.max(1, Number(e.target.value) || 1)))} /></Field><p className="hint">Припущення: скарги з того самого регіону протягом {minutes} хв після відмови можна згрупувати в один інцидент для перевірки. Збіг часу й регіону не доводить причину. Перевірка — на історичних інцидентах із телеметрією оператора.</p></div></details>
        <details><summary>Контракт події інтеграції</summary><pre className="slot-contract">{networkSchema}</pre></details>
      </div>
    </Dialog>
  </>;
}
