import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Alert, Badge, Card, Field } from '../../components/ui';
import { api, send, errorText } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { TabProps } from './types';
import { SOURCE_TYPES } from '../../lib/labels';

type Row={input:string;username:string|null;error:string|null};
type Job={id:string;username:string;kind:string;state:string;source_id:string|null;result:{source_type?:string;membership?:string};last_error:string|null;next_run_at:string};
type Batch={jobs:Job[]};
const states:Record<string,string>={queued:'У черзі',running:'Виконується',resolved:'Перевірено',joined:'Вступ виконано',already_joined:'Уже підписаний',approval_pending:'Заявка на вступ',flood_wait:'Пауза Telegram',failed:'Помилка',cancelled:'Скасовано',paused:'Призупинено'};

export function BulkTab({state,workflowId,busy,run}:TabProps){
  const [input,setInput]=useState(''),[account,setAccount]=useState(String(state.accounts[0]?.id||''));
  const [permission,setPermission]=useState(''),[rows,setRows]=useState<Row[]>([]),[batch,setBatch]=useState('');
  const [error,setError]=useState('');
  const request=useRef({signature:'',key:''});
  const batches=useQuery({queryKey:['telegram-imports'],queryFn:()=>api<{items:{id:string;created_at:string;workflow_id:string}[]}>('/admin/telegram/imports')});
  const result=useQuery({queryKey:['telegram-import',batch],queryFn:()=>api<Batch>('/admin/telegram/imports/'+batch),enabled:!!batch,refetchInterval:3000});
  async function preview(){
    setError('');try{setRows((await send<{rows:Row[]}>('/admin/telegram/imports/preview','POST',{input})).rows);}catch(e){setError(errorText(e));}
  }
  async function create(event:FormEvent){
    event.preventDefault();
    await run(async()=>{
      const body={input,account_id:Number(account),workflow_id:workflowId,permission_note:permission,enabled:true};
      const signature=JSON.stringify(body);
      if(request.current.signature!==signature)request.current={signature,key:crypto.randomUUID()};
      const response=await send<{id:string;rows?:Row[]}>('/admin/telegram/imports','POST',{...body,idempotency_key:request.current.key});
      setBatch(response.id);if(response.rows)setRows(response.rows);await batches.refetch();
      return 'Перевірку джерел поставлено в чергу. Для виконання потрібні ввімкнені модуль і сесія.';
    });
  }
  const jobs=result.data?.jobs||[];
  async function action(job:Job,value:string){await run(async()=>{await send(`/admin/telegram/jobs/${job.id}/action`,'POST',{action:value});await result.refetch();});}
  return <div className="stack">
    <Card title="Масове додавання джерел" description="Додавання до списку й вступ акаунтом — окремі дії. Приймаються публічні канали та групи; до 200 адрес за один імпорт.">
      <form className="form-grid" onSubmit={create}>
        <Field label="Джерела: @username або t.me-посилання" className="full" hint="По одному в рядку; також підтримуються коми та крапки з комою. Посилання на приватні запрошення й окремі пости не приймаються.">
          <textarea rows={7} value={input} onChange={e=>setInput(e.target.value)} required maxLength={30000}/>
        </Field>
        <Field label="Акаунт для перевірки та збору"><select value={account} onChange={e=>setAccount(e.target.value)} required><option value="">Оберіть акаунт</option>{state.accounts.map(a=><option key={a.id} value={a.id} disabled={!a.credentials_ready}>{a.label}{a.enabled?'':' · вимкнено'}</option>)}</select></Field>
        <Field label="Підстава використання матеріалів"><textarea value={permission} onChange={e=>setPermission(e.target.value)} required minLength={10} maxLength={1000}/></Field>
        <div className="form-actions full"><button className="btn btn-outline" type="button" disabled={busy||!input} onClick={preview}>Перевірити список</button><button className="btn" disabled={busy}>Перевірити доступ у Telegram</button></div>
      </form>
      {error&&<Alert tone="danger">{error}</Alert>}
      {rows.length>0&&<div className="stack-sm">{rows.map((r,i)=><div className="list-row" key={i}><span className="telegram-source-address">{r.input}</span>{r.error?<span className="note">{r.error}</span>:<Badge tone="success">Формат правильний</Badge>}</div>)}</div>}
    </Card>
    <Card title="Перевірки та імпорти">
      <Field label="Імпорт"><select value={batch} onChange={e=>setBatch(e.target.value)}><option value="">Оберіть імпорт</option>{batches.data?.items.filter(b=>Number(b.workflow_id)===workflowId).map(b=><option key={b.id} value={b.id}>{formatDateTime(b.created_at)}</option>)}</select></Field>
      {result.isError&&<Alert tone="danger">{errorText(result.error)}</Alert>}
      {batch&&<>
        <div className="form-actions">
          <button className="btn" disabled={busy||!jobs.some(j=>j.kind==='resolve'&&j.state==='resolved')} onClick={()=>run(async()=>{
            const r=await send<{results:{status:string}[]}>(`/admin/telegram/imports/${batch}/commit`,'POST');await result.refetch();
            return `Додано або вже присутні: ${r.results.filter(v=>v.status==='added').length}; в іншому workflow: ${r.results.filter(v=>v.status==='other_workflow').length}; на іншому акаунті: ${r.results.filter(v=>v.status==='other_account').length}.`;
          })}>Додати перевірені джерела</button>
          <button className="btn btn-outline" disabled={busy||!jobs.some(j=>j.source_id)} onClick={()=>run(async()=>{
            const r=await send<{queued:number}>(`/admin/telegram/imports/${batch}/join`,'POST');await result.refetch();return `Заплановано вступів: ${r.queued}. Ліміти Telegram враховуються.`;
          })}>Вступити до доданих джерел</button>
        </div>
        <p className="note">Вступ виконується від обраного акаунта. Поточний запит може завершитися після натискання паузи. FloodWait не обходиться іншою сесією.</p>
        {jobs.map(job=><div className="record stack-sm" key={job.id}>
          <div className="record-head"><strong>@{job.username}</strong><Badge>{job.kind==='join'?'Вступ':'Перевірка'}</Badge><Badge tone={job.state==='failed'?'danger':'secondary'}>{states[job.state]||job.state}</Badge>{job.source_id&&<Badge tone="success">Джерело #{job.source_id}</Badge>}</div>
          {job.result.source_type&&<p>{SOURCE_TYPES[job.result.source_type] || 'Невідомий тип'} · {job.result.membership==='member'?'Акаунт підписаний':'Акаунт не підписаний'}</p>}
          {job.last_error&&<p className="item-reason">{job.last_error}</p>}
          {job.state==='flood_wait'&&<p>Наступна спроба: {formatDateTime(job.next_run_at)}</p>}
          <div className="row">{['queued','running','flood_wait'].includes(job.state)&&<><button className="btn btn-outline btn-sm" disabled={busy} onClick={()=>action(job,'pause')}>Пауза</button><button className="btn btn-ghost btn-sm" disabled={busy} onClick={()=>action(job,'cancel')}>Скасувати</button></>}{job.state==='paused'&&<button className="btn btn-outline btn-sm" disabled={busy} onClick={()=>action(job,'resume')}>Продовжити</button>}{['failed','approval_pending'].includes(job.state)&&<button className="btn btn-outline btn-sm" disabled={busy} onClick={()=>action(job,'retry')}>Перевірити знову</button>}</div>
        </div>)}
      </>}
    </Card>
  </div>;
}
