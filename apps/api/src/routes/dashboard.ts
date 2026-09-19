import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { hasPermission } from '@ufv/shared/permissions';
import type { DashboardResponse, DashboardMetric, DashboardWindow, DashboardSignal } from '@ufv/shared/dashboard';
import { requireSession, type AppEnv } from '../auth/middleware.js';
import { dashboardSummary } from '../lib/dashboard-summary.js';
import { operatorCountsSql, wideOperatorCountsSql, growthSql } from '../lib/dashboard-queries.js';
import { reactionAttention, criticalAttention } from '../lib/metric-attention.js';
import { query } from './telegram-admin.js';

type Item = Record<string, any>;
const HOUR = 3600000;
const NEG = new Set(['👎','😡','🤬','🤮','💩','🤡']);
const IRONIC = new Set(['🤣','😁','😈']);
const SAD = new Set(['😢','💔','😭']);
const topicNames:Record<string,string>={mobile:'Мобільний зв’язок',internet:'Інтернет',network:'Мережа',billing:'Тарифи й оплата',support:'Підтримка',other:'Інше'};
const iso=(value:Date|string)=>new Date(value).toISOString();
const time=(value:Date|string)=>new Date(value).getTime();
const sum=(values:number[])=>values.reduce((a,b)=>a+b,0);
const median=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return s.length?(s[Math.floor((s.length-1)/2)]!+s[Math.floor(s.length/2)]!)/2:null;};
const dayKey=(value:Date|string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const visible=(item:Item,review:boolean)=>item.decision==='accepted'||(review&&item.decision==='review');
const commentEligible=(i:Item,end:number)=>i.kind!=='comment'||(i.watch_active&&time(i.event_at)>=end-7*24*HOUR);
function reactions(items:Item[]) {
 const r={negative:0,ironic:0,sad:0,positive:0,total:0,observed_items:0,negative_share:null as number|null};
 for(const item of items){
  if(!item.reactions||typeof item.reactions!=='object'||Array.isArray(item.reactions))continue;
  r.observed_items++;
  for(const [emoji,value] of Object.entries(item.reactions)){
   if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)continue;
   r[NEG.has(emoji)?'negative':IRONIC.has(emoji)?'ironic':SAD.has(emoji)?'sad':'positive']+=value;r.total+=value;
  }
 }
 r.negative_share=r.total?r.negative/r.total:null;
 return r;
}
function spreadGroups(items:Item[],href:(filters?:Record<string,string>)=>string){
 const grouped=new Map<string,Item[]>();
 for(const i of items.filter(i=>i.kind==='post')){
  const key=i.quote?.length>=100?'hash:'+i.content_hash:'canonical:'+(i.canonical_item_id||i.raw_item_id);
  const group=grouped.get(key)||[];group.push(i);grouped.set(key,group);
 }
 const result:DashboardResponse['spread']=[];
 for(const group of grouped.values()){
  group.sort((a,b)=>time(a.event_at)-time(b.event_at));
  while(group.length){
   const first=group.shift()!;const cluster=[first];
   while(group.length&&time(group[0]!.event_at)-time(first.event_at)<=48*HOUR)cluster.push(group.shift()!);
   if(cluster.length<2)continue;
   const published=cluster.filter(i=>i.published_at).sort((a,b)=>time(a.published_at)-time(b.published_at));
   result.push({id:String(first.id),count:cluster.length-1,source_count:new Set(cluster.map(i=>String(i.source_id))).size,
    third_repost_seconds:published.length===cluster.length&&published[3]?(time(published[3].published_at)-time(published[0]!.published_at))/1000:null,
    items_per_hour_first_6h:published.length?published.filter(i=>time(i.published_at)-time(published[0]!.published_at)<=6*HOUR).length/6:0,
    href:href({ids:cluster.map(i=>i.id).join(',')})});
  }
 }
 return result.sort((a,b)=>b.count-a.count).slice(0,10);
}

export async function getDashboard(params:Record<string,string>,review:boolean):Promise<DashboardResponse> {
 const workflow=params.workflow_id||'1';
 if(!/^[1-9]\d{0,14}$/.test(workflow))throw new HTTPException(400);
 const window=(params.window||'24h') as DashboardWindow;
 if(!['24h','7d','30d'].includes(window))throw new HTTPException(400);
 if(!(await query('select id from core.workflows where id=$1',[workflow])).length)throw new HTTPException(404);
 const completedRuns=await query(`select ar.model,ar.cutoff_at from core.analysis_runs ar where ar.workflow_id=$1 and
  (ar.status='complete' or (ar.status='running' and ar.scope->>'mode'='continuous' and exists(
   select 1 from core.sources s join core.workflows w on w.id=s.workflow_id left join core.rss_sources rs on rs.source_id=s.id
   where s.workflow_id=ar.workflow_id and s.enabled and w.enabled and s.llm_allowed and length(trim(s.llm_basis))>=10
    and (s.kind<>'rss' or rs.rights_status='allowed')))) order by ar.cutoff_at desc`,[workflow]);
 const semantic=completedRuns.length>0,includeReview=review&&!semantic;
 const now=Date.now(),end=new Date(now),hours=window==='24h'?24:window==='7d'?168:720;
 // Month uses Kyiv calendar days, including today; exact boundary comes from PostgreSQL (DST-safe).
 const start=window==='30d'?new Date((await query("select (((now() at time zone 'Europe/Kyiv')::date-29)::timestamp at time zone 'Europe/Kyiv') start"))[0].start):new Date(now-hours*HOUR);
 const href=(filters:Record<string,string>={})=>'/feed?'+new URLSearchParams({workflow_id:workflow,decision:includeReview?'visible':'accepted',from:iso(start),until:iso(end),window,...filters});
 const inboxHref=(filters:Record<string,string>={})=>'/inbox?'+new URLSearchParams({workflow_id:workflow,from:iso(start),until:iso(end),window,...filters});
 const metric=(value:number|null,unit:string,link:string,series:number[]=[],measured=0,note=''):DashboardMetric=>({value,unit,href:link,series,measured,note});
 const [freshnessRows,monthly,rawRows,operatorRows,watchPolicy]=await Promise.all([
  query(`select s.kind service,bool_or(s.enabled and w.enabled and coalesce(md.enabled,false)) enabled,
   max(case when s.kind='telegram' then st.last_success_at else rs.last_success_at end) last_success_at,
   max(svc.heartbeat_at) heartbeat_at from core.sources s join core.workflows w on w.id=s.workflow_id
   left join core.modules md on md.name=s.kind left join raw.source_state st on st.source_id=s.id
   left join core.rss_status rs on rs.id=s.id left join raw.service_status svc on svc.name=case when s.kind='rss' then 'collector-rss' else 'collector-telegram' end
   where s.workflow_id=$1 group by s.kind`,[workflow]),
  window==='30d'?query(`select
    (select row_to_json(c) from core.dashboard_rollup_coverage c where c.workflow_id=$1) coverage,
    coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('day_key',r.day::text,'title',s.title,'external_id',s.external_id) order by r.day),'[]') rollups
    from core.daily_rollups r join core.sources s on s.id=r.source_id and s.workflow_id=r.workflow_id
    join core.dashboard_rollup_state st on st.source_id=r.source_id and not st.dirty
    where r.workflow_id=$1 and r.day>=($2::timestamptz at time zone 'Europe/Kyiv')::date
    ${review?'':"and r.decision='accepted'"}`, [workflow,iso(start)]):Promise.resolve([]),
  window==='30d'?Promise.resolve([]):query(`select raw_item_id,id,source_id,source_kind,source_title,kind,url,published_at,fetched_at,
    event_at,content_hash,canonical_item_id,left(quote,280) quote,topic,brand,decision,negative,outage,action,
    views,reactions,metrics_observed_at,lag_seconds,watch_active
    from core.curated_visible_items where workflow_id=$1 and event_at>=$2 and event_at<=$3
    and decision=any($4::text[]) order by event_at,id`,[workflow,new Date(now-7*24*HOUR),end,includeReview?['accepted','review']:['accepted']]),
  window==='30d'||!review?Promise.resolve([]):query(window==='24h'?operatorCountsSql:wideOperatorCountsSql,[workflow,start,end]),
  query('select active_seconds,cooling_seconds,sleeping_seconds from core.telegram_watch_policies where workflow_id=$1',[workflow]),
 ]);
 const coverage=monthly[0]?.coverage||{source_count:0,dirty_sources:0,generated_at:null};
 const rollups:Item[]=monthly[0]?.rollups||[];
 const eligible=rawRows.filter(i=>commentEligible(i,now));
 const all=rawRows.filter(i=>time(i.event_at)>=start.getTime());
 const items=all.filter(i=>visible(i,includeReview)&&commentEligible(i,now));
 const historical=eligible.filter(i=>visible(i,includeReview));
 const current=historical.filter(i=>time(i.event_at)>=now-24*HOUR);
 const aggregate=rollups.filter(i=>visible(i,includeReview));
 const rx=window==='30d'?{
  negative:sum(aggregate.map(r=>Number(r.reaction_negative))),ironic:sum(aggregate.map(r=>Number(r.reaction_ironic))),
  sad:sum(aggregate.map(r=>Number(r.reaction_sad))),positive:sum(aggregate.map(r=>Number(r.reaction_positive))),
  observed_items:sum(aggregate.map(r=>r.reactions_measured)),total:0,negative_share:null as number|null,
 }:reactions(items);
 rx.total=rx.negative+rx.ironic+rx.sad+rx.positive;rx.negative_share=rx.total?rx.negative/rx.total:null;
 const count=(decision:string)=>window==='30d'?sum(rollups.filter(i=>i.decision===decision).map(i=>i.count)):review?sum(operatorRows.filter(i=>i.decision===decision).map(i=>i.count)):all.filter(i=>i.decision===decision).length;
 const mentions=window==='30d'?sum(aggregate.map(i=>i.count)):items.length;
 const byTopic=new Map<string,number>(),bySource=new Map<string,{id:string;title:string;kind:string;count:number;href:string}>();
 for(const i of window==='30d'?aggregate:items){
  const n=window==='30d'?i.count:1,key=String(i.source_id);
  byTopic.set(i.topic,(byTopic.get(i.topic)||0)+n);
  const s=bySource.get(key)||{id:key,title:i.source_title||i.title||i.external_id,kind:i.source_kind,count:0,href:href({source_id:key})};
  s.count+=n;bySource.set(key,s);
 }
 const buckets=new Map<string,DashboardResponse['hourly'][number]>();
 if(window!=='30d')for(let at=Math.floor(start.getTime()/HOUR)*HOUR;at<=now;at+=HOUR){
  const key=iso(new Date(at));buckets.set(key,{at:key,count:0,topics:{},href:href({from:iso(new Date(Math.max(at,start.getTime()))),until:iso(new Date(Math.min(at+HOUR,now)))})});
 }
 for(const i of window==='30d'?aggregate:items){
  const key=window==='30d'?i.day_key:iso(new Date(Math.floor(time(i.event_at)/HOUR)*HOUR));
  const bucket:DashboardResponse['hourly'][number]=buckets.get(key)||{at:key,count:0,topics:{},href:href({day:key})};
  const n=window==='30d'?i.count:1;bucket.count+=n;bucket.topics[i.topic]=(bucket.topics[i.topic]||0)+n;buckets.set(key,bucket);
 }
 const hourly=[...buckets.values()].sort((a,b)=>a.at.localeCompare(b.at));
 // Baselines use only material visible to this role. A viewer cannot infer rejected material through a denominator.
 const baselineRows=window==='30d'?[]:await query(`select source_id,views from (
  select source_id,views,row_number() over(partition by source_id order by event_at desc,raw_item_id desc) rank
  from core.curated_visible_items where workflow_id=$1 and kind='post' and event_at<$2
  and decision=any($3::text[]) and views is not null) b where rank<=30`,[workflow,end,includeReview?['accepted','review']:['accepted']]);
 const baselines=new Map<string,number[]>();
 for(const b of baselineRows){const key=String(b.source_id);const v=baselines.get(key)||[];v.push(Number(b.views));baselines.set(key,v);}
 const anomalies:DashboardResponse['reach_anomalies']=[];
 for(const i of items){const sample=baselines.get(String(i.source_id))||[];const base=sample.length>=10?median(sample):null;if(i.kind==='post'&&(i.negative||i.outage)&&i.views!==null&&base&&Number(i.views)/base>=3)anomalies.push({id:String(i.id),views:Number(i.views),baseline:base,ratio:Number(i.views)/base,href:href({ids:String(i.id)})});}
 const anomalyIds=new Set(anomalies.map(i=>i.id));
 const spread=spreadGroups(items,href);
 const signals:DashboardSignal[]=[];
 const candidates=new Map<string,Item[]>();
 for(const i of current){if(!i.negative&&!anomalyIds.has(String(i.id)))continue;const key=i.topic+':'+i.brand;const group=candidates.get(key)||[];group.push(i);candidates.set(key,group);}
 for(const group of candidates.values()){
  const outageSources=new Set(group.filter(i=>i.outage&&time(i.event_at)>=now-2*HOUR).map(i=>String(i.source_id)));
  const negativeSources=new Set(group.filter(i=>i.negative).map(i=>String(i.source_id)));
  const high=group.some(i=>anomalyIds.has(String(i.id)))||outageSources.size>=3;
  const first=group[group.length-1]!;const level=high?'h':negativeSources.size>=2?'m':'l';
  const groupHref=href({ids:group.map(i=>i.id).join(','),from:iso(new Date(now-24*HOUR))});
  const actions=group.map(i=>i.action);
  signals.push({id:String(first.id),title:topicNames[first.topic]||first.topic,topic:first.topic,brand:first.brand,level,count:group.length,
   sources:new Set(group.map(i=>String(i.source_id))).size,spread:spread.filter(s=>group.some(i=>String(i.id)===s.id)).reduce((n,s)=>n+s.count,0),
   action:actions.every(a=>a==='resolved')?'resolved':actions.includes('responding')?'responding':actions.includes('investigating')?'investigating':'none',
   href:groupHref,evidence:group.slice(-3).map(i=>({id:String(i.id),url:i.url,quote:i.quote.slice(0,280),published_at:i.published_at?iso(i.published_at):null})),
   reason:high?(outageSources.size>=3?'Ознаки збою у ≥3 джерелах за 2 години.':'Негативний тематичний матеріал: перегляди ≥3× медіани джерела.'):negativeSources.size>=2?'Ознаки негативу у ≥2 джерелах.':'Поодинокий тематичний сигнал; потрібна перевірка.'});
 }
 signals.sort((a,b)=>({h:0,m:1,l:2}[a.level]-{h:0,m:1,l:2}[b.level])||b.count-a.count);
 const activeBrand=signals.filter(s=>s.brand==='vodafone'&&s.action!=='resolved');
 const brandToday=current.filter(i=>i.brand==='vodafone');
 const todayShare=reactions(brandToday).negative_share;
 const dailyShares:number[]=[];
 const days=new Map<string,Item[]>();
 for(const i of historical.filter(i=>i.brand==='vodafone'&&time(i.event_at)<now-24*HOUR)){const key=dayKey(i.event_at);const group=days.get(key)||[];group.push(i);days.set(key,group);}
 for(const group of days.values()){const n=reactions(group).negative_share;if(n!==null)dailyShares.push(n);}
 const delta=todayShare!==null&&dailyShares.length?(todayShare-sum(dailyShares)/dailyShares.length)*100:null;
 const brandLevel=window==='30d'||!brandToday.length?'unknown':activeBrand.some(s=>s.level==='h')?'critical':activeBrand.some(s=>s.level==='m')||(delta!==null&&delta>=10)?'attention':'calm';
 const measured=window==='30d'?aggregate.flatMap(i=>i.lag_samples.map(Number)):items.filter(i=>i.lag_seconds!==null).map(i=>Number(i.lag_seconds));
 const lags=window==='30d'?rollups:review?operatorRows:all;
 const lagServices=[...new Set(lags.map(i=>i.source_kind))].map(service=>{const rows=lags.filter(i=>i.source_kind===service);const samples=window==='30d'||review?rows.flatMap(i=>i.lag_samples.map(Number)):rows.filter(i=>i.lag_seconds!==null).map(i=>Number(i.lag_seconds));return {service,median_seconds:median(samples),measured:samples.length,href:review?inboxHref({source_kind:service,lag:'1'}):href({source_kind:service,lag:'1'})};});
 const lagSamples=review?(window==='30d'?rollups.flatMap(i=>i.lag_samples.map(Number)):operatorRows.flatMap(i=>i.lag_samples.map(Number))):measured;
 const negative=items.filter(i=>i.negative&&i.decision==='accepted');
 const reachMeasured=window==='30d'?sum(aggregate.map(i=>i.views_measured)):negative.filter(i=>i.views!==null).length;
 const negativeReach=window==='30d'?sum(aggregate.map(i=>Number(i.negative_reach))):sum(negative.filter(i=>i.views!==null).map(i=>Number(i.views)));
 const complaints=window==='30d'?sum(aggregate.map(i=>i.complaints)):items.filter(i=>i.negative&&i.kind==='comment'&&i.watch_active).length;
 const growthRows=window==='30d'||!items.length?[]:await query(growthSql,
  [items.map(i=>i.raw_item_id),workflow,includeReview?['accepted','review']:['accepted'],start,end]);
 const growth=growthRows.filter(r=>Number(r.last_views)>=Number(r.first_views)).map(r=>{const i=items.find(i=>String(i.raw_item_id)===String(r.item_id))!;return {id:String(i.id),views_per_hour:(Number(r.last_views)-Number(r.first_views))/Number(r.seconds)*3600,observations:r.observations,href:href({ids:String(i.id)})};}).sort((a,b)=>b.views_per_hour-a.views_per_hour).slice(0,10);
 const countSeries=hourly.map(b=>b.count);
 const reactionShares=window==='30d'?[]:hourly.map(b=>reactions(items.filter(i=>Math.floor(time(i.event_at)/HOUR)===Math.floor(time(b.at)/HOUR))).negative_share);
 const reactionSeries=reactionShares.some(n=>n===null)?[]:reactionShares.map(n=>n!*100);
 const counts:DashboardResponse['counts']={accepted:count('accepted')};
 if(review)Object.assign(counts,{review:count('review'),collected:window==='30d'?sum(rollups.map(i=>i.count)):sum(operatorRows.map(i=>i.count)),rejected:count('rejected'),pending:count('pending')});
 const criticalIds=current.filter(i=>signals.some(s=>s.level==='h'&&s.topic===i.topic&&s.brand===i.brand)&&(i.negative||anomalyIds.has(String(i.id)))).map(i=>String(i.id));
 const result:DashboardResponse={
  version:1,aggregation:window==='30d'?{complete:coverage.dirty_sources===0,...(review?{dirty_sources:coverage.dirty_sources,source_count:coverage.source_count}:{}),generated_at:coverage.generated_at,note:coverage.dirty_sources?'Згортки перераховуються; неповні значення приховано.':'Атомарний зріз добових згорток.'}:undefined,aggregate_updated_at:window==='30d'&&rollups.length?iso(new Date(Math.min(...rollups.map(r=>time(r.generated_at))))):null,workflow_id:workflow,window,start:iso(start),end:iso(end),timezone:'Europe/Kyiv',generated_at:iso(end),aggregated:window==='30d',visibility:includeReview?'accepted_review':'accepted',
  brand_status:{level:brandLevel,title:{calm:'Спокійно',attention:'Увага',critical:'Критично',unknown:'Недостатньо даних'}[brandLevel],reason:brandLevel==='unknown'?(window==='30d'?'Статус зараз доступний у вікні 24 годин.':'За 24 години немає видимих згадок Vodafone.'):(activeBrand[0]?.title||'Правила не виявили високого сигналу.'),negative_delta_pp:delta,href:href({brand:'vodafone',from:iso(new Date(now-24*HOUR))})},
  metrics:{mentions:metric(mentions,'матеріалів',href(),countSeries,mentions,semantic?'Тільки актуальні тематичні результати AI або прийняті людиною. На перевірці — окремо.':'Прийняті та на перевірці; viewer бачить тільки прийняті.'),
   critical:metric(window==='30d'?null:criticalIds.length,'матеріалів',href({ids:criticalIds.join(',')||'0',from:iso(new Date(now-24*HOUR))}),[],criticalIds.length,'Високий сигнал за останні 24 години; поріг правил, не ймовірність кризи.'),
   negative_share:metric(rx.negative_share===null?null:rx.negative_share*100,'percent',href({has_reactions:'1'}),reactionSeries,rx.observed_items,'👎 😡 🤬 🤮 💩 🤡 / усі реакції. Іронія та сум окремо. Реакція на новину не доводить ставлення до оператора.'),
   negative_reach:metric(reachMeasured?negativeReach:null,'переглядів',href({negative:'1',decision:'accepted',has_views:'1'}),[],reachMeasured,'Сума переглядів прийнятих матеріалів з негативними аспектами; не унікальні люди й не виміряне охоплення.'),
   collection_lag:metric(median(lagSamples),'seconds',review?inboxHref({lag:'1'}):href({lag:'1'}),[],lagSamples.length,'Медіана fetched_at − published_at. Історичне добирання теж входить; це не live SLA.')},counts,hourly,
  topics:[...byTopic].map(([topic,count])=>({topic,count,href:href({topic})})).sort((a,b)=>b.count-a.count),sources:[...bySource.values()].sort((a,b)=>b.count-a.count).slice(0,10),
  reactions:{...rx,href:href({has_reactions:'1'}),note:'Евристика емоцій, не оцінка всіх абонентів. Невідомі й custom emoji входять до решти реакцій.'},
  signals:signals.slice(0,5),spread,reach_anomalies:anomalies.sort((a,b)=>b.ratio-a.ratio).slice(0,10),growth,
  complaints:{count:complaints,per_hour:complaints/Math.min(hours,168),href:href({negative:'1',kind:'comment'}),note:'Негативні тематичні коментарі під постами на спостереженні, не доведені скарги; максимум 7 днів.'},lag_by_service:lagServices,
  freshness:freshnessRows.map(r=>({...r,last_success_at:r.last_success_at?iso(r.last_success_at):null,heartbeat_at:r.heartbeat_at?iso(r.heartbeat_at):null})),
  competitors:['kyivstar','lifecell'].map(brand=>{const rows=(window==='30d'?aggregate:items).filter(i=>i.brand===brand);return {brand,count:window==='30d'?sum(rows.map(i=>i.count)):rows.length,negative:window==='30d'?sum(rows.map(i=>i.negative_count)):rows.filter(i=>i.negative).length,href:href({brand})};}),
  ai:{status:'rules',label:'Зведення доступних матеріалів',summary:`За вікно — ${mentions} тематичних матеріалів. ${window==='30d'?'Місячні дані агреговані.':`Високий сигнал: ${criticalIds.length} матеріалів за 24 години.`}`,href:href()},
  methodology:['Часове вікно: останні 24 години / 7 днів; 30 календарних днів за місцевим часом України включно із сьогодні. Невідома дата публікації → час збору для включення до вікна, але не для затримки.',
   semantic?'Тематичність і тональність — актуальна Gemini-розмітка зі знімка, з перевіркою версії тексту та контексту. Нові, застарілі й сумнівні результати не входять до основних метрик. Рішення людини має пріоритет для тієї самої версії. Точність не виміряна.':'Негатив тексту визначено словниковими правилами; точність не виміряна. Сигнал не доводить реальний збій.',
   'Високий сигнал: негативний матеріал із ≥3× медіани останніх 30 видимих постів джерела (щонайменше 10 виміряних постів) або ознаки збою у ≥3 джерелах за 2 години. Середній: негатив у ≥2 джерелах. Пороги — припущення; кілька джерел можуть передруковувати одну новину, це не незалежні підтвердження.',
   'Статус Vodafone враховує відкриті сигнали за 24 години; відхилення реакцій від середнього попередніх доступних днів (до 6) ≥10 п.п. підвищує стан до «Увага». Це евристика.',
   'Поширення: однаковий текст від 100 символів або canonical ID за 48 годин. Перепублікація не є незалежним підтвердженням. Третя перепублікація — четвертий матеріал із відомою датою.',
   'Темп поширення: кількість датованих матеріалів у перші 6 годин / 6. Для молодших кластерів вікно ще неповне. Набір переглядів: два чи більше спостережень у перші 2 години; зменшення не рахується приростом.',
   'Коментарі входять до метрик тільки у межах 7 днів і під постами на спостереженні. Місячні показники походять з атомарного покоління агрегатів; його час показано окремо. Перерахунок після зміни рішення приховує неповний підсумок; місячний API не читає тексти.',
   ...(window==='30d'?['У місячному режимі доступні агрегати. Поточні сигнали, швидкості окремих матеріалів і аномалії охоплення відкрийте у вікні 24 години або 7 днів.']:[])],
 };
 const brandWeekCount=window==='30d'?sum(aggregate.filter(r=>r.brand==='vodafone'&&r.decision==='accepted').map(r=>Number(r.rolling_7d_count))):historical.filter(i=>i.brand==='vodafone'&&i.decision==='accepted').length;
 const observedDates=window==='30d'?aggregate.flatMap(r=>[r.metrics_oldest_at,r.metrics_newest_at].filter(Boolean)):items.filter(i=>i.reactions&&typeof i.reactions==='object'&&!Array.isArray(i.reactions)&&i.metrics_observed_at).map(i=>i.metrics_observed_at);
 const oldestMetric=observedDates.length?iso(new Date(Math.min(...observedDates.map(time)))):null;
 const newestMetric=observedDates.length?iso(new Date(Math.max(...observedDates.map(time)))):null;
 const reactionNote='Пороги уваги: 25% / 50% / 75% негативних emoji, лише за ≥20 реакцій на ≥3 матеріалах. Це налаштування демо, не перевірені пороги кризи.';
 Object.assign(result.metrics.negative_share,{attention:reactionAttention(rx.negative_share,rx.total,rx.observed_items),attention_note:reactionNote});
 Object.assign(result.metrics.critical,{attention:criticalAttention(result.metrics.critical.value),attention_note:'1–2 / 3–4 / ≥5 матеріалів високого сигналу посилюють червоний акцент. Пороги уваги для демо, не ймовірність кризи.'});
 result.vodafone_7d={count:brandWeekCount,href:href({brand:'vodafone',decision:'accepted',window:'7d',from:iso(new Date(now-7*24*HOUR))})};
 result.analysis_coverage={label:semantic?'Семантичний відбір · з перевіркою версії та контексту':'Попередній відбір правилами',cutoff_at:completedRuns[0]?iso(completedRuns[0].cutoff_at):null,...(review?{pending:count('pending')}:{}),note:semantic?'Метрики включають актуальні прийняті результати аналізу. Нові записи й змінений контекст очікують аналізу; поточний стан AI-сервісу показано окремо.':'Працює попередній відбір правилами.'};
 result.reaction_freshness={oldest_at:oldestMetric,newest_at:newestMetric,
   active_seconds:Number(watchPolicy[0]?.active_seconds??300),cooling_seconds:Number(watchPolicy[0]?.cooling_seconds??3600),sleeping_seconds:Number(watchPolicy[0]?.sleeping_seconds??21600),
   note:'Плановий інтервал залежить від стану поста. Черга, доступ до обговорень і FloodWait можуть його збільшити. В архіві та на паузі планові перевірки зупинені. Час кожного вимірювання — у «Контекст і доказ».'};
 result.methodology.push(reactionNote,'Негативні emoji: 👎 😡 🤬 🤮 💩 🤡; іронічні: 🤣 😁 😈; сумні: 😢 💔 😭. Решта не вважаються позитивними автоматично. Це реакції на зміст допису, не оцінка оператора.');
 if(review)result.metrics.noise=metric(count('rejected'),'матеріалів',href({decision:'rejected'}),[],count('rejected'),'Відсіяно чинним аналізом або рішенням людини; це не доведена точність фільтра.');
 if(window==='30d'&&coverage.dirty_sources){
  for(const m of Object.values(result.metrics)){m.value=null;m.series=[];m.measured=0;m.note='Згортки перераховуються; неповний підсумок не показуємо.';}
  result.hourly=[];result.topics=[];result.sources=[];result.competitors=[];result.lag_by_service=[];
  result.reactions={negative:0,ironic:0,sad:0,positive:0,total:0,observed_items:0,negative_share:null,href:href(),note:'Згортки перераховуються.'};
  result.counts={accepted:0};result.complaints={count:0,per_hour:0,href:href({kind:'comment'}),note:'Згортки перераховуються.'};
  delete result.vodafone_7d;
  if(result.analysis_coverage)delete result.analysis_coverage.pending;
  if(result.reaction_freshness){result.reaction_freshness.oldest_at=null;result.reaction_freshness.newest_at=null;}
  for(const metric of Object.values(result.metrics))metric.attention=0;
  result.ai.summary='Згортки перераховуються; підсумок з’явиться після завершення.';
 }
 result.ai=await dashboardSummary(workflow,window,review,result.ai,window!=='30d'||coverage.dirty_sources===0);
 return result;
}
export const dashboard=new Hono<AppEnv>().get('/',requireSession,async c=>c.json(await getDashboard(c.req.query(),hasPermission(c.get('user').role,{incident:['edit']}))));
