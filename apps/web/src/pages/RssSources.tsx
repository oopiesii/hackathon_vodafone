import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Alert, Badge, Card, Field, PageHeader, Switch } from '../components/ui';
import { api, errorText, send } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { quantity } from '../lib/plural';

type Source={id:string;title:string;feed_url:string;enabled:boolean;workflow_name:string;workflow_enabled:boolean;
  poll_seconds:number;rights_status:string;terms_url:string;permission_note:string;status:string|null;last_error:string|null;
  last_success_at:string|null;next_poll_at:string|null;collected_count:number;accepted_count:number;last_new_count:number|null};
type State={enabled:boolean;items:Source[];service:{heartbeat_at:string}|null;workflows:{id:string;name:string;enabled:boolean}[]};
function useRss(){return useQuery({queryKey:['rss-state'],queryFn:()=>api<State>('/admin/rss'),refetchInterval:10000});}
export function RssCard(){
  const state=useRss(),cache=useQueryClient();
  const toggle=useMutation({mutationFn:(enabled:boolean)=>send('/admin/rss/module','POST',{enabled}),onSuccess:()=>cache.invalidateQueries({queryKey:['rss-state']})});
  return <Card title="Новини / RSS" actions={<Badge tone="secondary">RSS / Atom</Badge>}
    footer={<Link className="btn btn-outline" to="/sources/rss">Налаштувати RSS</Link>}>
    <div className="stack">
      <p>Заголовки та анонси видань. Усі отримані матеріали — у вхідних, релевантні — у стрічці.</p>
      {state.isPending&&<p role="status">Завантаження стану…</p>}
      {(state.isError||toggle.isError)&&<Alert tone="danger">{errorText(state.error||toggle.error)}</Alert>}
      {state.data&&<><Switch checked={state.data.enabled} disabled={toggle.isPending} ariaLabel="Збір RSS" label={state.data.enabled?'Збір увімкнено':'Збір вимкнено'} onChange={v=>toggle.mutate(v)}/>
        <p>{quantity(state.data.items.filter(s=>s.enabled&&s.rights_status==='allowed').length,'увімкнена стрічка','увімкнені стрічки','увімкнених стрічок')} · {quantity(state.data.items.reduce((n,s)=>n+s.collected_count,0),'отриманий матеріал','отримані матеріали','отриманих матеріалів')}</p>
        <p className="note">Останній сигнал збирача: {formatDateTime(state.data.service?.heartbeat_at??null)}.</p></>}
    </div>
  </Card>;
}
const errors:Record<string,string>={unsafe_url:'Недозволена адреса',unsafe_address:'Адреса веде до непублічної мережі',invalid_feed:'Відповідь не є коректним RSS/Atom',http_403:'Джерело відмовило в доступі (403)',http_429:'Ліміт джерела (429); повторну спробу відкладено',feed_too_large:'Стрічка перевищує ліміт розміру'};
export function RssSources(){
  const state=useRss(),cache=useQueryClient();
  const [urls,setUrls]=useState(''),[terms,setTerms]=useState(''),[note,setNote]=useState(''),[workflow,setWorkflow]=useState('1');
  const refresh=()=>cache.invalidateQueries({queryKey:['rss-state']});
  const update=useMutation({mutationFn:({source,enabled}:{source:Source;enabled:boolean})=>send(`/admin/rss/sources/${source.id}`,'PUT',{enabled,poll_seconds:source.poll_seconds}),onSuccess:refresh});
  const add=useMutation({mutationFn:()=>send<{added:number;existing:number}>('/admin/rss/sources','POST',{urls,terms_url:terms,permission_note:note,workflow_id:Number(workflow),poll_seconds:300,enabled:true}),onSuccess:()=>{setUrls('');void refresh();}});
  return <>
    <PageHeader title="RSS-джерела" description="Автоматичний збір анонсів із явно підключених стрічок. Частота перевірки не дорівнює затримці від події."
      breadcrumb={<Link to="/sources">← Sources</Link>} actions={<Link className="btn btn-outline" to="/inbox">Увесь вхід</Link>}/>
    <RssCard/>
    {(state.isError||update.isError)&&<Alert tone="danger">{errorText(state.error||update.error)}</Alert>}
    <div className="stack">{state.data?.items.map(s=><Card key={s.id} title={s.title}
      actions={<Badge tone={s.rights_status!=='allowed'?'secondary':s.status==='error'?'warning':s.enabled?'success':'secondary'}>{s.rights_status!=='allowed'?'Потрібен дозвіл':!s.enabled?'Вимкнено':!state.data?.enabled?'Модуль вимкнено':!s.workflow_enabled?'Workflow вимкнено':s.status==='ok'?'Працює':s.status==='error'?'Помилка збору':'Очікує збору'}</Badge>}
      footer={<><a className="btn btn-ghost btn-sm rss-url" href={s.feed_url} target="_blank" rel="noopener noreferrer">Відкрити RSS</a><a className="btn btn-ghost btn-sm" href={s.terms_url} target="_blank" rel="noopener noreferrer">Умови використання</a></>}>
      <div className="stack">
        <Switch checked={s.enabled} disabled={update.isPending||s.rights_status!=='allowed'} ariaLabel={`Збір ${s.title}`} label={s.enabled?'Увімкнено':'Вимкнено'} onChange={enabled=>update.mutate({source:s,enabled})}/>
        <p className="hint rss-url">{s.feed_url}</p><p className="note">{s.permission_note}</p>
        <dl className="facts"><div><dt>Отримано / прийнято правилами</dt><dd>{s.collected_count.toLocaleString('uk-UA')} / {s.accepted_count.toLocaleString('uk-UA')}</dd></div><div><dt>Перевірка</dt><dd>Кожні {Math.round(s.poll_seconds/60)} хв</dd></div><div><dt>Workflow</dt><dd>{s.workflow_name}</dd></div></dl>
        <p className="note">Попередній відбір правилами. Після семантичної перевірки склад стрічки може відрізнятися.</p>
        <p className="note">Успішний збір: {formatDateTime(s.last_success_at)}. Наступна перевірка: {s.enabled&&state.data?.enabled&&s.workflow_enabled?formatDateTime(s.next_poll_at):'збір призупинено'}.</p>
        {s.last_error&&<Alert tone="danger">{errors[s.last_error]||s.last_error}. Повторна спроба виконується автоматично.</Alert>}
      </div>
    </Card>)}</div>
    <Card title="Додати стрічки списком" description="Один URL на рядок. Для різних умов використання додавайте джерела окремими групами.">
      <form className="stack" onSubmit={e=>{e.preventDefault();add.mutate();}}>
        <Field label="RSS / Atom URL"><textarea required rows={4} value={urls} onChange={e=>setUrls(e.target.value)} placeholder="https://example.org/rss"/></Field>
        <Field label="Workflow"><select value={workflow} onChange={e=>setWorkflow(e.target.value)}>{state.data?.workflows.map(w=><option key={w.id} value={w.id}>{w.name}{w.enabled?'':' — вимкнено'}</option>)}</select></Field>
        <Field label="Посилання на умови використання"><input required type="url" value={terms} onChange={e=>setTerms(e.target.value)}/></Field>
        <Field label="Підстава для регулярного збору й показу анонсів" hint="Опишіть дозвіл або відповідний пункт умов. Доступність RSS сама по собі не є дозволом."><textarea required minLength={20} maxLength={1000} rows={3} value={note} onChange={e=>setNote(e.target.value)}/></Field>
        <div><button className="btn" disabled={add.isPending}>{add.isPending?'Додаємо…':'Додати та ввімкнути'}</button></div>
        {add.isError&&<Alert tone="danger">{errorText(add.error)}</Alert>}
        {add.data&&<Alert tone="success">Додано: {add.data.added}. Уже існували: {add.data.existing}.</Alert>}
      </form>
    </Card>
    <p className="note">Початкове завантаження читає доступну частину RSS, а не весь архів видання. Коментарі й перегляди статей не збираються. Повтори між стрічками одного видавця не є незалежними підтвердженнями.</p>
  </>;
}
