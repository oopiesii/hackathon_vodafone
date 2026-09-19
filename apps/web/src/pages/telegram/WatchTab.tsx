import { useQuery } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { Alert, Badge, Card, Field } from '../../components/ui';
import { api,send,errorText } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { TabProps } from './types';

export const watchLabels:Record<string,string>={active:'Активне',cooling:'Затихає',sleeping:'Рідкі перевірки',archived:'Архів',paused:'Пауза',blocked:'Недостатньо даних',deleted:'Видалено'};
type Policy=Record<string,number>;
type Target={item_id:string;state:string;external_id:string;reason:string;last_error:string|null;next_check_at:string|null;last_checked_at:string|null;override_mode:string;url:string|null;collected_replies:number};
const fields=[['active_days','Початкове стеження, днів',1,24],['sleep_days','Рідкі перевірки після, днів',2,90],['archive_days','Архів після, днів',2,365],['active_seconds','Активний інтервал, секунд',30,86400],['cooling_seconds','Інтервал затихання, секунд',60,604800],['sleeping_seconds','Рідкий інтервал, секунд',300,604800],['min_views_delta','Мінімальний приріст переглядів',1,100000000],['min_replies_delta','Мінімальний приріст відповідей',1,100000000],['min_reactions_delta','Мінімальний приріст реакцій',1,100000000]] as const;

export function WatchTab({workflowId,busy,run}:TabProps){
  const policy=useQuery({queryKey:['watch-policy',workflowId],queryFn:()=>api<Policy>(`/admin/telegram/policies/${workflowId}`)});
  const targets=useQuery({queryKey:['watches',workflowId],queryFn:()=>api<{items:Target[]}>(`/admin/telegram/watches?workflow_id=${workflowId}`),refetchInterval:5000});
  async function save(e:FormEvent<HTMLFormElement>){e.preventDefault();const form=new FormData(e.currentTarget);const body=Object.fromEntries(fields.map(([key])=>[key,Number(form.get(key))]));await run(async()=>{await send(`/admin/telegram/policies/${workflowId}`,'PUT',body);await policy.refetch();});}
  async function override(id:string,mode:string){await run(async()=>{await send(`/admin/telegram/watches/${id}`,'POST',{mode,reason:'Змінено у вкладці стеження'});await targets.refetch();return 'Пріоритет збережено. Збирач застосує його на наступному циклі.';});}
  return <div className="stack">
    <Card title="Стеження за старими постами" description="Нові повідомлення джерела продовжують збиратися. Ці параметри керують повторною перевіркою метрик і старих обговорень.">
      <Alert>Пороги — стартові припущення для налаштування, не оцінка ймовірності кризи. Приріст нормується на час між спостереженнями. Помилки та відсутні лічильники не означають тишу.</Alert>
      {policy.isError&&<Alert tone="danger">{errorText(policy.error)}</Alert>}
      {policy.data&&<form className="form-grid" onSubmit={save} key={workflowId+JSON.stringify(policy.data)}>{fields.map(([key,label,min,max])=><Field label={label} key={key}><input name={key} type="number" min={min} max={max} required defaultValue={policy.data[key]}/></Field>)}<div className="form-actions full"><button className="btn" disabled={busy}>Зберегти стеження</button></div></form>}
    </Card>
    <Card title="Пости під спостереженням" description="До 200 останніх записів. Архів зупиняє опитування, але не видаляє матеріал. Закріплення відновлює перевірки.">
      {targets.isError&&<Alert tone="danger">{errorText(targets.error)}</Alert>}
      {targets.data?.items.length===0&&<p className="hint">Після отримання постів тут з'явиться розклад.</p>}
      {targets.data?.items.map(item=><article className="record stack-sm" key={item.item_id}>
        <div className="record-head"><strong>@{item.external_id} · #{item.item_id}</strong><Badge tone={item.state==='blocked'?'warning':'secondary'}>{watchLabels[item.state]||item.state}</Badge>{item.override_mode==='pinned'&&<Badge tone="info">Закріплено</Badge>}</div>
        <p>{item.reason}</p>{item.last_error&&<p className="item-reason">{item.last_error}</p>}
        <p className="note">Остання перевірка: {formatDateTime(item.last_checked_at)} · Наступна: {formatDateTime(item.next_check_at,'не заплановано')} · Зібрано коментарів: {item.collected_replies}</p>
        <div className="row"><button className="btn btn-outline btn-sm" disabled={busy} onClick={()=>override(item.item_id,'pinned')}>Стежити далі</button><button className="btn btn-outline btn-sm" disabled={busy} onClick={()=>override(item.item_id,'auto')}>Автоматично</button><button className="btn btn-ghost btn-sm" disabled={busy} onClick={()=>override(item.item_id,'paused')}>Пауза</button>{item.url&&<a className="btn btn-ghost btn-sm" href={item.url} target="_blank" rel="noopener noreferrer">Джерело</a>}</div>
      </article>)}
    </Card>
  </div>;
}
