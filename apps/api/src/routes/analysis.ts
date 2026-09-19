import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireSession, requirePermission, type AppEnv } from '../auth/middleware.js';
import { query } from './telegram-admin.js';

// Read the narrow operator view, never grant API access to raw tables.
const checked=`select l.raw_item_id,l.raw_version,l.label,i.url,i.channel_title,
  i.published_at,i.source_kind,i.kind,i.source_id,
  (not i.deleted and i.version=l.raw_version and not exists(
    select 1 from jsonb_array_elements(l.label->'context_versions') cv
    left join core.incoming_items p on p.id=(cv->>'id')::bigint and p.workflow_id=$2
    where p.id is null or p.deleted or p.version<>(cv->>'version')::int
  ) and (l.label->>'missing_parent_key' is null or not exists(
    select 1 from core.incoming_items p where p.source_id=i.source_id
      and p.source_item_id=l.label->>'missing_parent_key' and not p.deleted
  ))) current
  from core.analysis_labels l join core.incoming_items i on i.id=l.raw_item_id
  where l.run_id=$1 and i.workflow_id=$2`;

const allowed=(value:string|undefined,values:string[],fallback='all')=>{
  if(value!==undefined&&!values.includes(value))throw new HTTPException(400);
  return value||fallback;
};

// Unreviewed AI labels and rejected input are for admin/analyst, never public shares.
export const analysis = new Hono<AppEnv>()
  .use('*',requireSession,requirePermission({incident:['edit']}))
  .get('/',async c=>{
    const workflow=c.req.query('workflow_id')||'1';
    if(!/^\d+$/.test(workflow))throw new HTTPException(400);
    const relevance=allowed(c.req.query('relevance'),['all','vodafone','competitor','telecom']);
    const kind=allowed(c.req.query('kind'),['all','post','comment']);
    const sentiment=allowed(c.req.query('sentiment'),['all','negative','positive','neutral','mixed','unknown']);
    const offsetText=c.req.query('offset')||'0';
    if(!/^\d{1,6}$/.test(offsetText))throw new HTTPException(400);
    const offset=Number(offsetText),limit=50;
    const [runs,search]=await Promise.all([
      query('select * from core.analysis_runs where workflow_id=$1 order by created_at desc limit 1',[workflow]),
      query(`select * from (select distinct on(url) * from core.search_briefs where workflow_id=$1
        order by url,searched_at desc) b order by published_on desc nulls last,searched_at desc limit 30`,[workflow]),
    ]);
    const run=runs[0]||null;
    if(!run)return c.json({run,counts:{},analyzed:0,current:0,stale:0,items:[],search,
      total_matching:0,offset,limit,comment_sentiments:{},brand_sentiments:[],brief:null,search_automatic:false});
    const [summary,items,briefRows]=await Promise.all([
      query(`with checked as materialized (${checked}) select
        (select count(*)::int from checked) analyzed,
        (select count(*)::int from checked where current) current,
        (select coalesce(jsonb_agg(g),'[]') from (
          select label->>'decision' decision,label->>'relevance' relevance,kind,
            label->>'sentiment' sentiment,count(*)::int n
          from checked where current group by 1,2,3,4) g) groups,
        (select coalesce(jsonb_agg(g),'[]') from (
          select a->>'brand' brand,a->>'sentiment' sentiment,count(distinct raw_item_id)::int n
          from checked cross join lateral jsonb_array_elements(label->'aspects') a
          where current and kind<>'post' and label->>'decision'='relevant' group by 1,2) g) brands,
        (select count(distinct coalesce(label->>'semantic_group',raw_item_id::text))::int
          from checked where current and label->>'decision'='relevant') unique_relevant`,[run.id,workflow]),
      query(`with checked as (${checked}) select *,count(*) over()::int total_matching from checked
        where current and label->>'decision' in ('relevant','review')
          and ($3='all' or label->>'relevance'=$3)
          and ($4='all' or ($4='post' and kind='post') or ($4='comment' and kind<>'post'))
          and ($5='all' or label->>'sentiment'=$5)
        order by published_at desc nulls last,raw_item_id desc limit $6 offset $7`,
        [run.id,workflow,relevance,kind,sentiment,limit,offset]),
      query('select brief,generated_at from core.analysis_briefs where run_id=$1',[run.id]),
    ]);
    const stats=summary[0],counts:Record<string,number>={},commentSentiments:Record<string,number>={};
    let relevantPosts=0,relevantComments=0;
    for(const g of stats.groups){
      const key=g.decision==='relevant'?g.relevance:g.decision;
      counts[key]=(counts[key]||0)+g.n;
      if(g.decision==='relevant'){
        if(g.kind==='post')relevantPosts+=g.n;
        else {relevantComments+=g.n;commentSentiments[g.sentiment]=(commentSentiments[g.sentiment]||0)+g.n;}
      }
    }
    let brief=briefRows[0]?.brief||null,briefStale=false;
    const briefIds:number[]=brief?[...new Set<number>([...brief.findings,...brief.actions].flatMap(x=>x.evidence_ids))]:[];
    const briefEvidence=briefIds.length?await query(`with checked as (${checked}) select * from checked
      where current and raw_item_id=any($3::bigint[])`,[run.id,workflow,briefIds]):[];
    if(briefIds.length!==briefEvidence.length){brief=null;briefStale=true;}
    const evidenceIds=[...new Set([...items,...briefEvidence].flatMap(x=>[
      ...x.label.evidence,...(x.label.aspects||[]).flatMap((a:any)=>a.evidence)
    ].map((e:{id:number})=>e.id)))];
    const evidence=evidenceIds.length?await query(`select id,url from core.incoming_items
      where workflow_id=$1 and id=any($2::bigint[]) and not deleted`,[workflow,evidenceIds]):[];
    const urls=new Map(evidence.map(e=>[String(e.id),e.url]));
    const attach=(list:any[])=>list.map(e=>({...e,url:urls.get(String(e.id))||null}));
    for(const row of [...items,...briefEvidence]){
      row.label.evidence=attach(row.label.evidence);
      for(const a of row.label.aspects||[])a.evidence=attach(a.evidence);
    }
    if(brief){
      const map=new Map(briefEvidence.map(r=>[Number(r.raw_item_id),r]));
      for(const section of [brief.findings,brief.actions])for(const item of section){
        item.evidence=item.evidence_ids.map((id:number)=>{
          const row=map.get(id)!;
          return {id,url:row.url,kind:row.kind,summary:row.label.summary,quotes:row.label.evidence};
        });
      }
    }
    return c.json({run,counts,analyzed:stats.analyzed,current:stats.current,stale:stats.analyzed-stats.current,
      unique_relevant:stats.unique_relevant,items,offset,limit,total_matching:items[0]?.total_matching||0,
      relevant_posts:relevantPosts,relevant_comments:relevantComments,comment_sentiments:commentSentiments,
      brand_sentiments:stats.brands,brief,brief_stale:briefStale,search,search_automatic:false});
  });
