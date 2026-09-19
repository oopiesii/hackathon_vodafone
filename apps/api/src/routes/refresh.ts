import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireSession, requirePermission, type AppEnv } from '../auth/middleware.js';
import { appPool } from '../db/pool.js';
import { query } from './telegram-admin.js';

const requestSchema=z.object({workflow_id:z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
const fields='id,workflow_id,service,status,requested_at,started_at,completed_at,detail';
async function readRefresh(workflow:string|number,ids?:string[],run:typeof query=query){
 const rows=await run(`select ${fields.split(',').map(f=>'r.'+f).join(',')},svc.heartbeat_at collector_heartbeat_at,
  coalesce(svc.heartbeat_at>=now()-interval '5 minutes',false) collector_online,
  (r.status in ('pending','running') and coalesce(r.started_at,r.requested_at)<now()-interval '5 minutes') stale
  from core.refresh_requests r left join raw.service_status svc on svc.name=case when r.service='rss' then 'collector-rss' else 'collector-telegram' end
  where r.workflow_id=$1 ${ids?'and r.id=any($2::bigint[])':''} order by r.requested_at desc,r.id desc limit 10`,ids?[workflow,ids]:[workflow]);
 return rows.map(row=>({...row,detail:row.stale
  ?row.collector_online?'Збирач працює, але запит ще очікує завершення черги. Оновлення не підтверджено.'
   :'Немає свіжого heartbeat збирача. Запит залишається в черзі; оновлення не підтверджено.'
  :row.detail}));
}
export const refresh=new Hono<AppEnv>().use(requireSession).use(requirePermission({collector:['manage']}));
refresh.get('/',async c=>{
 const workflow=c.req.query('workflow_id')||'1';
 if(!/^[1-9]\d{0,14}$/.test(workflow))throw new HTTPException(400);
 return c.json({requests:await readRefresh(workflow)});
});
refresh.post('/',async c=>{
 const parsed=requestSchema.safeParse(await c.req.json().catch(()=>null));
 if(!parsed.success)throw new HTTPException(422);
 const client=await appPool.connect();
 try{
  await client.query('begin');
  // One short transaction serializes repeat clicks and different admin sessions.
  await client.query('select pg_advisory_xact_lock(727116)');
  const workflow=parsed.data.workflow_id;
  if(!(await client.query('select id from core.workflows where id=$1',[workflow])).rowCount)throw new HTTPException(404);
  const requests=[];
  for(const service of ['telegram','rss']){
   const previous=(await client.query(`select ${fields} from core.refresh_requests where workflow_id=$1 and service=$2
    and (status in ('pending','running') or requested_at>now()-interval '30 seconds') order by id desc limit 1`,[workflow,service])).rows[0];
   if(previous){requests.push(previous);continue;}
   const row=(await client.query(`insert into core.refresh_requests(workflow_id,service,requested_by) values($1,$2,$3) returning ${fields}`,[workflow,service,c.get('user').id])).rows[0];
   requests.push(row);
   await client.query("insert into core.audit(actor_id,action,object_type,object_id) values($1,'refresh_requested','refresh',$2)",[c.get('user').id,row.id]);
  }
  await client.query('commit');
  return c.json({requests:await readRefresh(workflow,requests.map(r=>String(r.id)),async(sql,values)=>(await client.query(sql,values)).rows)},202);
 }catch(error){await client.query('rollback');throw error;}finally{client.release();}
});
