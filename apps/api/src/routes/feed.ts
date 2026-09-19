import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { hasPermission } from '@ufv/shared/permissions';
import { requireSession, type AppEnv } from '../auth/middleware.js';
import { query } from './telegram-admin.js';
import { dashboardFilters } from '../lib/dashboard-filters.js';
import { telegramDetail } from '../lib/telegram-detail.js';

export type ShareScope = {workflow_id:string;scope:'summary'|'posts'|'full';channel_ids:number[];topics:string[];name:string};
const joins = ` from core.mentions m join core.sources s on s.id=m.source_id
 left join core.review_decisions r on r.mention_id=m.id and r.raw_version=m.raw_version`;
export function selection(params:Record<string,string>, review=false, share?:ShareScope) {
  const args:unknown[]=[];
  const add=(v:unknown)=>{args.push(v);return '$'+args.length;};
  const filters=['m.deleted=false'];
  const workflow=params.workflow_id || share?.workflow_id || '1';
  if(!/^\d+$/.test(workflow))throw new HTTPException(400);
  if(share && String(share.workflow_id)!==workflow)throw new HTTPException(403);
  filters.push('s.workflow_id='+add(workflow));
  const decision=review ? params.decision || 'accepted' : 'accepted';
  if(decision==='visible')filters.push("coalesce(r.decision,m.decision) in ('accepted','review')");
  else if(decision!=='all'){
    if(!['accepted','review','rejected'].includes(decision))throw new HTTPException(400);
    filters.push('coalesce(r.decision,m.decision)='+add(decision));
  }
  if(share?.scope==='posts') filters.push("m.kind='post'");
  if(share?.channel_ids.length)filters.push('s.id=any('+add(share.channel_ids)+'::bigint[])');
  if(share?.topics.length)filters.push('m.category=any('+add(share.topics)+'::text[])');
  if(params.q){if(share?.scope==='summary')throw new HTTPException(403);filters.push('m.quote ilike '+add('%'+params.q.slice(0,200)+'%'));}
  if(params.topic)filters.push('m.category='+add(params.topic));
  if(params.kind)filters.push('m.kind='+add(params.kind));
  const drilldown=Boolean(params.window||params.from||params.until||params.day||params.source_id||params.source_kind||params.brand||params.ids||params.negative||params.has_views||params.has_reactions||params.lag);
  if(drilldown){
    filters.push(...dashboardFilters(params,add));
    filters.push(review?(decision==='visible'?"d.decision in ('accepted','review')":decision==='all'?"d.decision<>'deleted'":'d.decision='+add(decision)):"d.decision='accepted'");
  }
  return {sql:joins+(drilldown?' join core.dashboard_items d on d.id=m.id':'')+' where '+filters.join(' and '),args};
}

export async function getFeed(params:Record<string,string>,review=false,share?:ShareScope) {
  const {sql,args}=selection(params,review,share);
  const [total,topics,kinds,module]=await Promise.all([
    query('select count(*)::int count,max(m.fetched_at) last_fetched_at,max(m.analyzed_at) last_processed_at'+sql,args),
    query('select m.category topic,count(*)::int count'+sql+' group by m.category',args),
    query('select m.kind,count(*)::int count'+sql+' group by m.kind',args),
    query("select enabled from core.modules where name='telegram'"),
  ]);
  const pageargs=[...args];let pagesql=sql;
  if(params.before){if(!/^\d+$/.test(params.before))throw new HTTPException(400);pageargs.push(params.before);pagesql+=' and m.id<$'+pageargs.length;}
  const items=share?.scope==='summary' ? [] : await query(`select m.id,m.url source_url,m.published_at,m.category topic,m.severity,m.quote text,m.summary,
    m.analyzed_at processed_at,m.fetched_at,m.edited_at,m.kind,m.reason,m.decision,m.brand,m.context_id,m.duplicate_of,
    r.decision manual_decision,s.kind source_kind,s.id channel_id,s.external_id username,coalesce(s.title,s.external_id) channel_title`+pagesql+' order by m.id desc limit 51',pageargs);
  return {items:items.slice(0,50),total:total[0],topics,kinds,next_before:items.length>50?items[49].id:null,summary_only:share?.scope==='summary',classifier:'rules-v2',telegram_enabled:module[0].enabled};
}

export async function getDocument(id:string,review=false,share?:ShareScope) {
  if(!/^\d+$/.test(id))throw new HTTPException(400);
  if(share?.scope==='summary')throw new HTTPException(403);
  const rows=await query('select s.workflow_id from core.mentions m join core.sources s on s.id=m.source_id where m.id=$1',[id]);
  if(!rows.length)throw new HTTPException(404);
  const {sql,args}=selection({workflow_id:String(rows[0].workflow_id),decision:'all'},review,share);
  const fields=`select m.*,m.quote text,m.url source_url,m.category topic,m.analyzed_at processed_at,s.external_id username,s.kind source_kind,coalesce(s.title,s.external_id) channel_title,r.decision manual_decision`;
  const docs=await query(fields+sql+' and m.id=$'+(args.length+1),[...args,id]);
  if(!docs.length)throw new HTTPException(404);
  const doc=docs[0];let context=null;
  if(doc.context_id){const parents=await query('select m.id,m.quote text,m.url source_url,m.kind'+sql+' and m.id=$'+(args.length+1),[...args,doc.context_id]);context=parents[0]||null;}
  return {document:doc,context,telegram:doc.source_kind==='telegram'?await telegramDetail(doc.raw_item_id):null};
}
export const feed=new Hono<AppEnv>().get('/',requireSession,async c=>c.json(await getFeed(c.req.query(),hasPermission(c.get('user').role,{incident:['edit']}))));
export const documents=new Hono<AppEnv>().get('/:id',requireSession,async c=>c.json(await getDocument(c.req.param('id'),hasPermission(c.get('user').role,{incident:['edit']}))));
