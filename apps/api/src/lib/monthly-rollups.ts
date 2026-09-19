import { HTTPException } from 'hono/http-exception';

type Query = (text:string, values?:unknown[])=>Promise<Record<string,any>[]>;

/** Bridge for API image rollback across the 0014/0030 aggregate migration. */
export async function monthlyRollups(query:Query,workflow:string,start:string,includeReview:boolean) {
 const coverageAvailable=async()=>Boolean((await query("select to_regclass('core.dashboard_rollup_state') is not null available"))[0]?.available);
 const hasCoverage=await coverageAvailable();
 const rowsSql=`select r.*,r.day::text day_key,s.title,s.external_id
  from core.curated_daily_rollups r join core.sources s on s.id=r.source_id
  where r.workflow_id=$1 and r.day>=($2::timestamptz at time zone 'Europe/Kyiv')::date
  ${includeReview?'':"and r.decision='accepted'"}`;
 // Before 0014 the curated view calculates a complete result directly. Do not
 // cache this capability: the same running image must notice later migrations.
 if(!hasCoverage){
  const legacyRows=await query(rowsSql+' order by r.day',[workflow,start]);
  // A migration can finish between the first probe and SELECT, replacing the
  // live view with physical rows. Discard that result once coverage appears.
  if(!await coverageAvailable())return legacyRows;
 }
 // Both coverage and rows belong to this one statement's MVCC snapshot. Missing
 // generations count as incomplete, including a newly added source with no rows.
 const rows=await query(`with coverage as materialized (
   select count(*) filter(where st.source_id is null or st.dirty or st.generated_at is null)::int incomplete
   from core.sources s left join core.dashboard_rollup_state st on st.source_id=s.id
   where s.workflow_id=$1
  ) select coverage.incomplete,r.* from coverage left join lateral (
   ${rowsSql} and coverage.incomplete=0
  ) r on true order by r.day`,[workflow,start]);
 if(!rows.length||Number(rows[0]!.incomplete)!==0)throw new HTTPException(503,{
  message:'Місячні агрегати перераховуються. Спробуйте оновити сторінку пізніше.',
 });
 // The LEFT JOIN retains the coverage result even for a genuinely empty month.
 return rows.filter(row=>row.source_id!==null);
}
