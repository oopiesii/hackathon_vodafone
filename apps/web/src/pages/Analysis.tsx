import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Alert, Badge, Card, Empty, Field, PageHeader, Stat } from '../components/ui';
import { api, errorText } from '../lib/api';
import { excerpt, formatDate } from '../lib/format';

type Evidence={id:number;quote:string;url:string|null};
type Result={raw_item_id:string;url:string|null;channel_title:string;published_at:string|null;source_kind:string;
  label:{decision:string;relevance:string;topic:string;sentiment:string;summary:string;reason:string;evidence:Evidence[]}};
type SearchItem={id:string;title:string;url:string;publisher:string;published_on:string|null;searched_at:string;
  summary:string;evidence_quote:string;verification:string;topic:string};
type Data={run:{id:string;status:string;model:string;cutoff_at:string;total:number;note:string;completed_at:string|null}|null;
  counts:Record<string,number>;analyzed:number;current:number;stale:number;unique_relevant:number;items:Result[];
  search:SearchItem[];telegram_total:number;telegram:{id:string;url:string|null;text:string;published_at:string|null;channel_title:string}[]};
const words:Record<string,string>={vodafone:'Vodafone',competitor:'Конкуренти',telecom:'Телеком',unrelated:'Поза темою',
  review:'Перевірити',spam:'Спам',ad:'Реклама',relevant:'Релевантне',positive:'Позитивна',neutral:'Нейтральна',
  negative:'Негативна',mixed:'Змішана',unknown:'Невідомо',outage:'Збій',recovery:'Відновлення',
  infrastructure_attack:'Удари по інфраструктурі',tariff:'Тарифи',billing:'Списання',support:'Підтримка',
  coverage:'Покриття',internet:'Інтернет',roaming:'Роумінг',security:'Безпека',investment:'Інвестиції',
  regulation:'Регулювання',other:'Інше',running:'Триває',complete:'Завершено',partial:'Частково',failed:'Помилка'};
const day=(value:string|null)=>value?new Date(value).toLocaleDateString('uk-UA'):'Невідомо';

export function Analysis(){
  const [workflow,setWorkflow]=useState('1'),[filter,setFilter]=useState('all');
  const workflows=useQuery({queryKey:['workflows'],queryFn:()=>api<{items:{id:string;name:string}[]}>('/workflows')});
  const result=useQuery({queryKey:['analysis',workflow],queryFn:()=>api<Data>('/analysis?workflow_id='+workflow),
    refetchInterval:q=>q.state.data?.run?.status==='running'?15000:false});
  const data=result.data;
  return <>
    <PageHeader title="Vodafone: аналіз і пошук"
      description="Разова модельна розмітка, результати пошуку та окремо — Telegram-кандидати, відібрані правилами."
      actions={<button className="btn btn-outline" onClick={()=>result.refetch()} disabled={result.isFetching}><RefreshCw size={16}/>Оновити результати</button>}/>
    <Field label="Workflow"><select value={workflow} onChange={e=>setWorkflow(e.target.value)}>
      {(workflows.data?.items||[{id:'1',name:'Vodafone та український телеком'}]).map(w=><option key={w.id} value={w.id}>{w.name}</option>)}
    </select></Field>
    {result.isPending&&<p className="loading" role="status">Завантаження результатів…</p>}
    {result.isError&&<Alert tone="danger">{errorText(result.error)}</Alert>}
    {data&&<div className="stack">
      <Card title="Пошук за день" description="Перевірена добірка вебматеріалів. Дата пошуку окрема від дати публікації. Автоматичний щоденний запуск ще не підключений.">
        {!data.search.length?<Empty title="Для цього workflow пошук ще не виконано"/>:
          <div className="stack">{data.search.map(s=><article key={s.id} className="section">
            <a className="item-source" href={s.url} target="_blank" rel="noopener noreferrer">{s.publisher} · {s.title} <ExternalLink size={14}/></a>
            <p className="note">Опубліковано: {day(s.published_on)} · Знайдено: {formatDate(s.searched_at)} · {words[s.topic]||s.topic}</p>
            <p>{s.summary}</p><blockquote className="quote">{s.evidence_quote}</blockquote>
            <p className="note">{s.verification}</p>
          </article>)}</div>}
      </Card>
      <Card title="Gemini 3.8 Flash · разова розмітка">
        {!data.run?<Empty title="Розмітку ще не запущено"/>:<>
          <div className="row"><Badge tone="secondary">{words[data.run.status]||data.run.status}</Badge>
            <span className="note">Зріз: {formatDate(data.run.cutoff_at)} · {data.analyzed} / {data.run.total} записів</span></div>
          <p className="note">{data.run.note}</p>
          <div className="stats">
            <Stat label="Vodafone · записів">{data.counts.vodafone||0}</Stat>
            <Stat label="Конкуренти · записів">{data.counts.competitor||0}</Stat>
            <Stat label="Телеком · записів">{data.counts.telecom||0}</Stat>
            <Stat label="Поза темою / спам / реклама">{(data.counts.unrelated||0)+(data.counts.spam||0)+(data.counts.ad||0)}</Stat>
          </div>
          <p className="note">На перевірку: {data.counts.review||0}. Застарілих версій виключено: {data.stale}.
            Це кількість записів у зрізі, а не незалежних підтверджень чи криз. У списку одна картка на URL; повноту та точність не виміряно.</p>
          <Field label="Показати результати"><select value={filter} onChange={e=>setFilter(e.target.value)}>
            <option value="all">Усі відібрані та сумнівні</option><option value="vodafone">Vodafone</option>
            <option value="competitor">Конкуренти</option><option value="telecom">Телеком</option>
          </select></Field>
          <div className="stack">{data.items.filter(i=>filter==='all'||i.label.relevance===filter).map(i=><article key={i.raw_item_id} className="section">
            <div className="row"><Badge>{words[i.label.relevance]}</Badge><Badge tone="secondary">{words[i.label.topic]}</Badge>
              <Badge>{words[i.label.sentiment]}</Badge>{i.label.decision==='review'&&<Badge>Перевірити</Badge>}</div>
            {i.url&&<a href={i.url} target="_blank" rel="noopener noreferrer">Джерело: {i.channel_title}</a>}
            <p className="note">Опубліковано: {formatDate(i.published_at)} · {i.source_kind==='rss'?'RSS-анонс':'Telegram'}</p>
            <p>{i.label.summary}</p><p className="note">{i.label.reason}</p>
            {i.label.evidence.map((e,n)=><blockquote className="quote" key={n}>{e.quote}
              {e.url&&<> <a href={e.url} target="_blank" rel="noopener noreferrer">Доказ ↗</a></>}</blockquote>)}
          </article>)}</div>
          {!data.items.some(i=>filter==='all'||i.label.relevance===filter)&&<Empty title="За цим фільтром згадок немає"><p>Відсутність згадок у зрізі не означає відсутності проблем у мережі.</p></Empty>}
        </>}
      </Card>
      <Card title="Telegram · кандидати про Vodafone" description="Поточний відбір за правилами та ручними рішеннями. Ці тексти не передаються Gemini без підтверджених прав.">
        <p>Знайдено {data.telegram_total} кандидатів. Показано до 30 останніх за датою публікації.</p>
        <div className="stack">{data.telegram.map(t=><article className="section" key={t.id}>
          <div className="row"><span className="item-source">{t.channel_title}</span><Badge tone="secondary">Правила, не LLM</Badge></div>
          <p className="note">Опубліковано: {formatDate(t.published_at)}</p><p className="item-text">{excerpt(t.text,600)}</p>
          {t.url&&<a href={t.url} target="_blank" rel="noopener noreferrer">Оригінал ↗</a>}
        </article>)}</div>
        <Link to="/inbox">Перевірити весь вхід і контекст →</Link>
      </Card>
    </div>}
  </>;
}
