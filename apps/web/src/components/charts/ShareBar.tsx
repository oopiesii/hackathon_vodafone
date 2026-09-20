import { useState } from "react";
import { Link } from "react-router";

type Part = { label: string; value: number; kind: "negative" | "ironic" | "sad" | "positive" };
export function ShareBar({ negative, ironic=0, sad, positive, href }: { negative: number; ironic?:number; sad: number; positive: number; href: string }) {
  const [active, setActive] = useState<string | null>(null);
  const parts: Part[] = [{ label: "Негативні emoji", value: negative, kind: "negative" }, {label:"Іронічні",value:ironic,kind:"ironic"}, { label: "Сумні", value: sad, kind: "sad" }, { label: "Інші реакції", value: positive, kind: "positive" }];
  const total = negative + ironic + sad + positive;
  let offset = 0;
  return <div className="reaction-chart">
    {total > 0 ? <svg className="reaction-svg" viewBox="0 0 600 32" role="group" aria-label="Розподіл агрегованих реакцій">
      {parts.map(p => { const width = p.value / total * 600, x = offset; offset += width; return p.value > 0 && <a key={p.kind} href={href} aria-label={`${p.label}: ${p.value.toLocaleString("uk-UA")}`} onMouseEnter={() => setActive(p.kind)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(p.kind)} onBlur={() => setActive(null)}><rect x={x} y="0" width={width} height="32" fill="transparent" /><rect x={x} y="8" width={Math.max(.5, width - 2)} height="16" className={`reaction-${p.kind}`} /></a>; })}
    </svg> : <div className="chart-no-data">Реакції ще не спостерігалися</div>}
    {total > 0 && <div className="reaction-values">{parts.map(p => <Link to={href} key={p.kind} className={active === p.kind ? "reaction-value is-active" : "reaction-value"}><span><i className={`reaction-${p.kind}`} />{p.label}</span><strong>{p.value.toLocaleString("uk-UA")}</strong><small>{`${Math.round(p.value / total * 100)}%`}</small></Link>)}</div>}
  </div>;
}
