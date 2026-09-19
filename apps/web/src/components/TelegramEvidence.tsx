import { Badge, Section } from './ui';
import { formatDateTime } from '../lib/format';

type Metric={id:string;observed_at:string;views:string|number|null;forwards:string|number|null;replies:string|number|null;reactions:Record<string,number>|null};
export type TelegramDetail={metrics:Metric[];watch:{state:string;next_check_at:string|null;last_checked_at:string|null;reason:string;last_error:string|null;collected_replies:number}|null;metadata:{content_truncated:boolean;normalization_version:string;topic_id:string|null;has_duplicate:boolean}|null};
const labels:Record<string,string>={active:'Активне стеження',cooling:'Затихає',sleeping:'Рідкі перевірки',archived:'Архів',paused:'Пауза',blocked:'Активність невідома',deleted:'Видалено'};
const reactions=(m:Metric)=>m.reactions===null?null:Object.values(m.reactions).reduce((a,b)=>a+b,0);
const display=(v:string|number|null|undefined)=>v===null||v===undefined?'Немає даних':Number(v).toLocaleString('uk-UA');

export function TelegramEvidence({data}:{data?:TelegramDetail}){
  if(!data)return null;
  const metrics=data.metrics,latest=metrics.at(-1),previous=metrics.at(-2);
  const points=metrics.filter(m=>m.views!==null);
  const start=points.length?Date.parse(points[0]!.observed_at):0,end=points.length?Date.parse(points.at(-1)!.observed_at):0;
  const low=points.length?Math.min(...points.map(m=>Number(m.views))):0,high=points.length?Math.max(...points.map(m=>Number(m.views))):0;
  const line=points.map(m=>`${10+300*(Date.parse(m.observed_at)-start)/Math.max(1,end-start)},${70-60*(Number(m.views)-low)/Math.max(1,high-low)}`).join(' ');
  return <>
    {data.metadata?.content_truncated&&<p className="alert alert-info">Текст перевищив технічний ліміт; збережено лише частину. Висновок не охоплює весь матеріал.</p>}
    {data.metadata?.has_duplicate&&<p className="note">Це саме Telegram-повідомлення також отримано через інше підключене джерело; не незалежне підтвердження.</p>}
    <Section title="Динаміка Telegram">
      {!latest?<p className="note">Знімків метрик ще немає.</p>:<>
        <dl className="meta-list"><dt>Перегляди</dt><dd>{display(latest.views)}</dd><dt>Пересилання</dt><dd>{display(latest.forwards)}</dd><dt>Відповідей за Telegram</dt><dd>{display(latest.replies)}</dd><dt>Реакцій</dt><dd>{display(reactions(latest))}</dd><dt>Час знімка</dt><dd>{formatDateTime(latest.observed_at)}</dd></dl>
        {previous&&latest.views!==null&&previous.views!==null&&<p>Зміна переглядів між двома останніми знімками: {Number(latest.views)-Number(previous.views)}. Інтервал: {Math.max(0,(Date.parse(latest.observed_at)-Date.parse(previous.observed_at))/60000).toFixed(1)} хв.</p>}
        {points.length>1&&<figure><svg viewBox="0 0 320 80" width="100%" height="120" role="img" aria-label={`Перегляди від ${low} до ${high}; дані також наведено в таблиці`}><polyline points={line} fill="none" stroke="currentColor" strokeWidth="2"/></svg><figcaption className="note">Перегляди у часі: {formatDateTime(points[0]!.observed_at)} — {formatDateTime(points.at(-1)!.observed_at)}.</figcaption></figure>}
        {latest.reactions&&Object.keys(latest.reactions).length>0&&<div className="row">{Object.entries(latest.reactions).map(([emoji,count])=><Badge key={emoji}>{emoji}: {count}</Badge>)}</div>}
        <details><summary>Останні знімки метрик</summary><div className="tablewrap"><table><thead><tr><th>Час</th><th>Перегляди</th><th>Відповіді</th><th>Реакції</th></tr></thead><tbody>{metrics.slice(-12).map(m=><tr key={m.id}><td>{formatDateTime(m.observed_at)}</td><td>{display(m.views)}</td><td>{display(m.replies)}</td><td>{display(reactions(m))}</td></tr>)}</tbody></table></div></details>
        <p className="note">Перегляди не дорівнюють унікальним людям. Emoji не визначає тональність щодо оператора. Відсутні лічильники показано як невідомі.</p>
      </>}
    </Section>
    {data.watch&&<Section title="Стан спостереження"><p><Badge>{labels[data.watch.state]||data.watch.state}</Badge> {data.watch.reason}</p><p className="note">Наступна перевірка: {formatDateTime(data.watch.next_check_at,'не заплановано')}. Реально зібраних коментарів: {data.watch.collected_replies}.</p>{data.watch.last_error&&<p className="item-reason">{data.watch.last_error}</p>}</Section>}
  </>;
}
