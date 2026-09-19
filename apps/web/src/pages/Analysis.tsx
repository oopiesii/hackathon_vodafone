import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Alert, Badge, Card, Empty, Field, PageHeader, Stat } from '../components/ui';
import { api, errorText } from '../lib/api';
import { formatDate } from '../lib/format';

type Evidence={id:number;quote:string;url:string|null};
type Aspect={brand:string;topic:string;sentiment:string;cause:string;evidence:Evidence[]};
type Result={raw_item_id:string;url:string|null;channel_title:string;published_at:string|null;source_kind:string;kind:string;is_test?:boolean;
  label:{decision:string;relevance:string;topic:string;sentiment:string;summary:string;reason:string;evidence:Evidence[];aspects?:Aspect[]}};
type SearchItem={id:string;title:string;url:string;publisher:string;published_on:string|null;searched_at:string;
  summary:string;evidence_quote:string;verification:string;topic:string};
type BriefItem={text:string;evidence:{id:number;url:string|null;summary:string;quotes:Evidence[]}[]};
type Data={run:{id:string;status:string;model:string;cutoff_at:string;total:number;note:string;completed_at:string|null;
    progress?:{phase:string;screened:number;detailed:number;candidates:number};
    scope?:{source_kind?:string;missing_direct_context?:number;deleted_excluded?:number;kinds?:Record<string,number>}}|null;
  counts:Record<string,number>;analyzed:number;current:number;stale:number;unique_relevant:number;items:Result[];
  total_matching:number;limit:number;offset:number;relevant_posts:number;relevant_comments:number;
  comment_sentiments:Record<string,number>;brand_sentiments:{brand:string;sentiment:string;n:number}[];
  brief:{findings:BriefItem[];actions:BriefItem[];limitations:string[];coverage?:{examples:number;relevant_records:number;selection:string}}|null;
  test_records?:number;brief_stale?:boolean;search:SearchItem[]};
const words:Record<string,string>={vodafone:'Vodafone',kyivstar:'Kyivstar',lifecell:'lifecell',competitor:'Конкуренти',telecom:'Телеком',unrelated:'Поза темою',
  review:'Перевірити',spam:'Спам',ad:'Реклама',relevant:'Релевантне',positive:'Позитивна',neutral:'Нейтральна',
  negative:'Негативна',mixed:'Змішана',unknown:'Невідомо',outage:'Збій',recovery:'Відновлення',
  infrastructure_attack:'Удари по інфраструктурі',tariff:'Тарифи',billing:'Списання',support:'Підтримка',
  coverage:'Покриття',internet:'Інтернет',roaming:'Роумінг',security:'Безпека',investment:'Інвестиції',
  regulation:'Регулювання',other:'Інше',running:'Триває',complete:'Завершено',partial:'Частково',failed:'Помилка',
  screening:'Семантичний відбір',details:'Тональність і причини',summary:'Підготовка зведення',post:'Допис',comment:'Коментар',group_message:'Повідомлення групи'};
const moods=['negative','positive','neutral','mixed','unknown'];
const day=(value:string|null)=>value?new Date(value).toLocaleDateString('uk-UA'):'Невідомо';
const num=(n:number|undefined)=>(n||0).toLocaleString('uk-UA');
function Quotes({items}:{items:Evidence[]}){
  return <>{items.map((e,n)=><blockquote className="quote" key={n}>{e.quote}
    {e.url&&<> <a href={e.url} target="_blank" rel="noopener noreferrer">Доказ ↗</a></>}</blockquote>)}</>;
}
function BriefItems({items}:{items:BriefItem[]}){
  return <div className="stack">{items.map((item,n)=><article className="section" key={n}>
    <p>{item.text}</p><details><summary>Перевірити докази ({item.evidence.length})</summary>
      {item.evidence.map(e=><div key={e.id}><p className="note">{e.summary}</p><Quotes items={e.quotes}/></div>)}
    </details>
  </article>)}</div>;
}

export function Analysis(){
  const [workflow,setWorkflow]=useState('1'),[filter,setFilter]=useState('all');
  const [kind,setKind]=useState('all'),[sentiment,setSentiment]=useState('all'),[offset,setOffset]=useState(0);
  const workflows=useQuery({queryKey:['workflows'],queryFn:()=>api<{items:{id:string;name:string}[]}>('/workflows')});
  const result=useQuery({queryKey:['analysis',workflow,filter,kind,sentiment,offset],
    queryFn:()=>api<Data>('/analysis?'+new URLSearchParams({workflow_id:workflow,relevance:filter,kind,sentiment,offset:String(offset)})),
    placeholderData:keepPreviousData,refetchInterval:q=>q.state.data?.run?.status==='running'?15000:false});
  const data=result.data,p=data?.run?.progress,isTelegram=data?.run?.scope?.source_kind==='telegram';
  return <>
    <PageHeader title="Vodafone: аналіз і пошук"
      description="Telegram: тематичні дописи, настрої в коментарях і коротке зведення з доказами."
      actions={<button className="btn btn-outline" onClick={()=>result.refetch()} disabled={result.isFetching}><RefreshCw size={16}/>Оновити результати</button>}/>
    <Field label="Workflow"><select value={workflow} onChange={e=>{setWorkflow(e.target.value);setOffset(0);}}>
      {(workflows.data?.items||[{id:'1',name:'Vodafone та український телеком'}]).map(w=><option key={w.id} value={w.id}>{w.name}</option>)}
    </select></Field>
    {result.isPending&&<p className="loading" role="status">Завантаження результатів…</p>}
    {result.isError&&<Alert tone="danger">{errorText(result.error)}</Alert>}
    {data&&<div className="stack" aria-busy={result.isFetching}>
      <Card title={`${isTelegram?'Telegram':'Матеріали'} · Gemini 3.8 Flash`}>
        {!data.run?<Empty title="Розмітку ще не запущено"/>:<>
          <div className="row"><Badge tone="secondary">{words[data.run.status]||data.run.status}</Badge>
            <span className="note">Зріз: {formatDate(data.run.cutoff_at)} · збережено {num(data.analyzed)} / {num(data.run.total)} результатів</span></div>
          {p&&<p role="status">{words[p.phase]||p.phase}: прочитано {num(p.screened)} / {num(data.run.total)} записів.
            Детально розібрано {num(p.detailed)} / {num(p.candidates)} кандидатів.</p>}
          {data.run.status==='running'&&<Alert>Аналіз триває. Лічильники ще неповні; відсутність результату зараз не означає відсутності згадок. Прогрес оновлюється кожні 15 секунд.</Alert>}
          <p className="note">{data.run.note}</p>
          <div className="stats">
            <Stat label="Vodafone · записів">{num(data.counts.vodafone)}</Stat>
            <Stat label="Конкуренти · записів">{num(data.counts.competitor)}</Stat>
            <Stat label="Телеком · записів">{num(data.counts.telecom)}</Stat>
            <Stat label="Поза темою / спам / реклама">{num((data.counts.unrelated||0)+(data.counts.spam||0)+(data.counts.ad||0))}</Stat>
          </div>
          <p className="note">Тематичних дописів: {num(data.relevant_posts)} · коментарів / повідомлень груп: {num(data.relevant_comments)}.
            На перевірку: {num(data.counts.review)}. Застарілих версій виключено: {num(data.stale)}.
            Текстів із різним контекстом без точних повторів: {num(data.unique_relevant)}. Це не кількість незалежних підтверджень чи людей.</p>
          {isTelegram&&<p className="note">Без прямої батьківської відповіді у зрізі: {num(data.run.scope?.missing_direct_context)}.
            Видалені записи не аналізувалися. Нові надходження після часу зрізу до цього разового прогону не входять.</p>}
          {!!data.test_records&&<p className="note">Окремо оброблено {num(data.test_records)} записів із ваших тестових джерел. Вони позначені в списку та виключені зі статистики й зведення.</p>}
          <Link to="/inbox">Весь вхід до фільтрації та контекст →</Link>
        </>}
      </Card>
      {isTelegram&&<Card title="Настрій у тематичних коментарях" description="Оцінка оператора або послуги, висловлена в зібраних коментарях. Дописи каналів у ці лічильники не входять.">
        <div className="stats">{moods.map(m=><Stat key={m} label={words[m]||m}>{num(data.comment_sentiments[m])}</Stat>)}</div>
        {!!data.brand_sentiments.length&&<div className="tablewrap"><table>
          <thead><tr><th>Оператор</th>{moods.map(m=><th key={m}>{words[m]}</th>)}</tr></thead>
          <tbody>{['vodafone','kyivstar','lifecell','other'].map(b=><tr key={b}><th>{words[b]}</th>
            {moods.map(m=><td key={m}>{num(data.brand_sentiments.find(s=>s.brand===b&&s.sentiment===m)?.n)}</td>)}</tr>)}</tbody>
        </table></div>}
        <p className="note">Це настрої зібраних коментарів, а не всіх абонентів. Один коментар може оцінювати кількох операторів або містити різні оцінки. Точність моделі ще не виміряна.</p>
      </Card>}
      {isTelegram&&<Card title="Коротке AI-зведення" description="Висновки про зібрані повідомлення та окремо рекомендовані перевірки. Кожен пункт має докази.">
        {data.brief?<>
          <BriefItems items={data.brief.findings}/>
          {!!data.brief.actions.length&&<><h3>Рекомендовані дії</h3><BriefItems items={data.brief.actions}/></>}
          <ul className="note">{data.brief.limitations.map((l,n)=><li key={n}>{l}</li>)}</ul>
          {data.brief.coverage&&<p className="note">Для тексту зведення використано {num(data.brief.coverage.examples)} прикладів із {num(data.brief.coverage.relevant_records)} тематичних записів. {data.brief.coverage.selection}</p>}
        </>:<p className="note">{data.brief_stale?'Частина доказів змінилася або видалена. Зведення приховано до повторного аналізу.':
          'Зведення з’явиться після завершення відбору й детального аналізу.'}</p>}
      </Card>}
      <Card title="Тематичні повідомлення й причини оцінок">
        <div className="form-grid">
          <Field label="Показати результати"><select value={filter} onChange={e=>{setFilter(e.target.value);setOffset(0);}}>
            <option value="all">Усі відібрані та сумнівні</option><option value="vodafone">Vodafone</option>
            <option value="competitor">Конкуренти</option><option value="telecom">Телеком</option>
          </select></Field>
          <Field label="Тип повідомлення"><select value={kind} onChange={e=>{setKind(e.target.value);setOffset(0);}}>
            <option value="all">Дописи й коментарі</option><option value="post">Лише дописи</option><option value="comment">Лише коментарі / групи</option>
          </select></Field>
          <Field label="Тональність"><select value={sentiment} onChange={e=>{setSentiment(e.target.value);setOffset(0);}}>
            <option value="all">Усі оцінки</option>{moods.map(m=><option key={m} value={m}>{words[m]}</option>)}
          </select></Field>
        </div>
        <p className="note">За фільтрами: {num(data.total_matching)}. Показано {data.items.length?offset+1:0}–{offset+data.items.length}.</p>
        <div className="stack">{data.items.map(i=><article key={i.raw_item_id} className="section">
          <div className="row"><Badge>{words[i.label.relevance]}</Badge><Badge tone="secondary">{words[i.kind]||i.kind}</Badge>
            {i.is_test&&<Badge tone="warning">Тестове джерело · поза статистикою</Badge>}
            <Badge>{words[i.label.sentiment]}</Badge>{i.label.decision==='review'&&<Badge>Перевірити</Badge>}</div>
          {i.url&&<a href={i.url} target="_blank" rel="noopener noreferrer">Джерело: {i.channel_title}</a>}
          <p className="note">Опубліковано: {formatDate(i.published_at)} · {words[i.label.topic]||i.label.topic}</p>
          <p>{i.label.summary}</p><p className="note">{i.label.reason}</p>
          <Quotes items={i.label.evidence}/>
          {i.label.aspects?.map((a,n)=><div key={n} className="section">
            <p><strong>{words[a.brand]} · {words[a.sentiment]} · {words[a.topic]}</strong></p><p>{a.cause}</p>
            <Quotes items={a.evidence}/>
          </div>)}
        </article>)}</div>
        {!data.items.length&&<Empty title="За цим фільтром згадок немає"><p>Відсутність згадок у зрізі не означає відсутності проблем у мережі.</p></Empty>}
        <div className="row">
          <button className="btn btn-outline" disabled={!offset||result.isFetching} onClick={()=>setOffset(Math.max(0,offset-data.limit))}>Попередні</button>
          <button className="btn btn-outline" disabled={offset+data.items.length>=data.total_matching||result.isFetching} onClick={()=>setOffset(offset+data.limit)}>Наступні</button>
        </div>
      </Card>
      <Card title="Вебпошук · додаткові матеріали" description="Окрема перевірена добірка. Автоматичний щоденний пошук ще не підключений.">
        <details><summary>Переглянути матеріали пошуку ({data.search.length})</summary>
          {!data.search.length?<Empty title="Для цього workflow пошук ще не виконано"/>:
            <div className="stack">{data.search.map(s=><article key={s.id} className="section">
              <a className="item-source" href={s.url} target="_blank" rel="noopener noreferrer">{s.publisher} · {s.title} <ExternalLink size={14}/></a>
              <p className="note">Опубліковано: {day(s.published_on)} · Знайдено: {formatDate(s.searched_at)}</p>
              <p>{s.summary}</p><blockquote className="quote">{s.evidence_quote}</blockquote><p className="note">{s.verification}</p>
            </article>)}</div>}
        </details>
      </Card>
    </div>}
  </>;
}
