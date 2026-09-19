import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireSession, requirePermission, type AppEnv } from '../auth/middleware.js';
import { appPool } from '../db/pool.js';
import { query } from './telegram-admin.js';

const id = (s:string) => { if(!/^\d+$/.test(s)) throw new HTTPException(400); return s; };
const uuid = (s:string) => { if(!z.uuid().safeParse(s).success) throw new HTTPException(400); return s; };
async function parse<T>(c:{req:{json:()=>Promise<unknown>}},schema:z.ZodType<T>):Promise<T>{
  const parsed=schema.safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)throw new HTTPException(422,{message:'Перевірте поля: '+parsed.error.issues.map(i=>i.path.join('.')).join(', ')});
  return parsed.data;
}

export function parseSources(input:string){
  const seen=new Set<string>();
  return input.split(/[\n,;]+/).map(v=>v.trim().replace(/^"|"$/g,'')).filter(Boolean).map(value=>{
    let username=value;
    if(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i.test(value)){
      try {
        const url=new URL(/^https?:/i.test(value)?value:'https://'+value);
        if(url.username||url.password||url.port||url.search||url.hash)throw new Error();
        const path=url.pathname.replace(/^\/s\//,'/');
        if(!/^\/[a-z][a-z\d_]{3,31}\/?$/i.test(path))throw new Error();
        username=path.replaceAll('/','');
      }catch {return {input:value,username:null,error:'Потрібне публічне @username або посилання на джерело без номера поста'};}
    }
    username=username.replace(/^@/,'').toLowerCase();
    if(!/^[a-z][a-z\d_]{3,31}$/i.test(username))return {input:value,username:null,error:'Некоректне публічне джерело'};
    if(seen.has(username))return {input:value,username,error:'Повтор у списку'};
    seen.add(username);return {input:value,username,error:null};
  });
}

const imported=z.object({input:z.string().min(1).max(30000),workflow_id:z.number().int().positive(),account_id:z.number().int().positive(),
  permission_note:z.string().min(10).max(1000),enabled:z.boolean().default(true),idempotency_key:z.string().min(8).max(100)}).strict();
export const telegramControl=new Hono<AppEnv>().use(requireSession).use(requirePermission({collector:['manage']}));

telegramControl.post('/imports/preview',async c=>{
  const b=await parse(c,z.object({input:z.string().max(30000)}).strict());
  const rows=parseSources(b.input);if(rows.length>200)throw new HTTPException(422,{message:'До 200 рядків за один імпорт'});
  return c.json({rows});
});
telegramControl.post('/imports',async c=>{
  const b=await parse(c,imported);const rows=parseSources(b.input);
  if(rows.length>200||!rows.some(r=>!r.error))throw new HTTPException(422,{message:'Потрібен список до 200 публічних джерел'});
  const hash=createHash('sha256').update(JSON.stringify({...b,idempotency_key:undefined})).digest('hex');
  const client=await appPool.connect();
  try{
    await client.query('begin');await client.query('select pg_advisory_xact_lock(727106)');
    const existing=(await client.query('select id,request_hash from core.telegram_imports where idempotency_key=$1',[b.idempotency_key])).rows[0];
    if(existing){if(existing.request_hash!==hash)throw new HTTPException(409,{message:'Ключ повтору вже використано для іншого списку'});await client.query('commit');return c.json({id:existing.id});}
    const account=(await client.query('select id from core.telegram_accounts where id=$1 and session is not null and api_id is not null and api_hash is not null',[b.account_id])).rows[0];
    if(!account)throw new HTTPException(422,{message:'Спочатку завершіть підключення акаунта'});
    if(!(await client.query('select id from core.workflows where id=$1',[b.workflow_id])).rowCount)throw new HTTPException(404,{message:'Workflow не знайдено'});
    const importId=randomUUID();
    await client.query('insert into core.telegram_imports(id,workflow_id,account_id,idempotency_key,request_hash,permission_note,enabled,created_by) values($1,$2,$3,$4,$5,$6,$7,$8)',[importId,b.workflow_id,b.account_id,b.idempotency_key,hash,b.permission_note,b.enabled,c.get('user').id]);
    for(const row of rows.filter(r=>!r.error))await client.query("insert into core.telegram_jobs(import_id,account_id,workflow_id,username,kind) values($1,$2,$3,$4,'resolve')",[importId,b.account_id,b.workflow_id,row.username]);
    await client.query('commit');return c.json({id:importId,rows});
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
});
telegramControl.get('/imports',async c=>c.json({items:await query('select id,workflow_id,account_id,created_at from core.telegram_imports order by created_at desc limit 30')}));
telegramControl.get('/imports/:id',async c=>{
  const rows=await query('select * from core.telegram_imports where id=$1',[uuid(c.req.param('id'))]);if(!rows.length)throw new HTTPException(404);
  return c.json({import:rows[0],jobs:await query('select id,username,kind,state,result,source_id,attempts,next_run_at,last_error from core.telegram_jobs where import_id=$1 order by id',[rows[0].id])});
});
telegramControl.post('/imports/:id/commit',async c=>{
  const importId=uuid(c.req.param('id')),client=await appPool.connect();
  try{
    await client.query('begin');await client.query('select pg_advisory_xact_lock(727107)');
    const batch=(await client.query('select * from core.telegram_imports where id=$1',[importId])).rows[0];if(!batch)throw new HTTPException(404);
    const jobs=(await client.query("select * from core.telegram_jobs where import_id=$1 and kind='resolve' and state='resolved' for update",[importId])).rows;
    const results=[];
    for(const job of jobs){
      const result=job.result;if(!/^-[0-9]+$/.test(result.peer_id)||!['channel','supergroup','forum'].includes(result.source_type))continue;
      let source=(await client.query('select s.id,s.workflow_id,s.account_id from core.sources s left join raw.source_state r on r.source_id=s.id where s.telegram_peer_id=$1 or r.peer_id=$1 or (s.kind=\'telegram\' and s.external_id=$2)',[result.peer_id,result.username.toLowerCase()])).rows[0];
      if(source&&String(source.workflow_id)!==String(batch.workflow_id)){results.push({username:job.username,status:'other_workflow'});continue;}
      if(source&&String(source.account_id)!==String(batch.account_id)){results.push({username:job.username,status:'other_account'});continue;}
      if(!source)source=(await client.query("insert into core.sources(kind,external_id,workflow_id,account_id,permission_note,enabled,telegram_peer_id,history_since) select 'telegram',$1,$2,$3,$4,$5,$6,now()-make_interval(days=>history_days) from core.workflows where id=$2 returning id",[result.username.toLowerCase(),batch.workflow_id,batch.account_id,batch.permission_note,batch.enabled,result.peer_id])).rows[0];
      await client.query('update core.telegram_jobs set source_id=$1 where id=$2',[source.id,job.id]);
      results.push({username:job.username,status:'added',source_id:source.id});
    }
    await client.query("insert into core.audit(actor_id,action,object_type) values($1,'sources_imported','telegram')",[c.get('user').id]);
    await client.query('commit');return c.json({results});
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
});
telegramControl.post('/imports/:id/join',async c=>{
  const importId=uuid(c.req.param('id'));
  if(!(await query('select id from core.telegram_imports where id=$1',[importId])).length)throw new HTTPException(404);
  const rows=await query("insert into core.telegram_jobs(import_id,account_id,workflow_id,source_id,username,kind) select import_id,account_id,workflow_id,source_id,username,'join' from core.telegram_jobs where import_id=$1 and kind='resolve' and state='resolved' and source_id is not null on conflict(import_id,username,kind) do nothing returning id",[importId]);
  await query("insert into core.audit(actor_id,action,object_type) values($1,'join_requested','telegram')",[c.get('user').id]);
  return c.json({queued:rows.length});
});
telegramControl.post('/jobs/:id/action',async c=>{
  const b=await parse(c,z.object({action:z.enum(['pause','resume','cancel','retry'])}).strict());
  const states={pause:'paused',resume:'queued',cancel:'cancelled',retry:'queued'};
  // Never shorten a recorded FloodWait or retry a completed external action.
  const allowed=b.action==='retry'?['failed','approval_pending']:b.action==='resume'?['paused']:['queued','running','flood_wait'];
  const rows=await query("update core.telegram_jobs set result=case when state='approval_pending' and $4='retry' then result||'{\"membership_check_only\":true}'::jsonb else result end,state=$1,lease_token=null,lease_until=null,updated_at=now() where id=$2 and state=any($3::text[]) returning id",[states[b.action],id(c.req.param('id')),allowed,b.action]);
  if(!rows.length)throw new HTTPException(409,{message:'Дія недоступна для поточного стану'});
  await query("insert into core.audit(actor_id,action,object_type,object_id) values($1,$2,'telegram_job',$3)",[c.get('user').id,b.action,c.req.param('id')]);
  return c.json({ok:true});
});

const policy=z.object({active_days:z.number().int().min(1).max(24),sleep_days:z.number().int().min(2).max(90),archive_days:z.number().int().min(2).max(365),
 active_seconds:z.number().int().min(30).max(86400),cooling_seconds:z.number().int().min(60).max(604800),sleeping_seconds:z.number().int().min(300).max(604800),
 min_views_delta:z.number().int().min(1),min_replies_delta:z.number().int().min(1),min_reactions_delta:z.number().int().min(1)}).strict()
 .refine(b=>b.active_days<b.sleep_days&&b.sleep_days<b.archive_days&&b.active_seconds<=b.cooling_seconds&&b.cooling_seconds<=b.sleeping_seconds,{message:'Перевірте порядок строків та інтервалів'});
telegramControl.get('/policies/:id',async c=>{
  const rows=await query('select * from core.telegram_watch_policies where workflow_id=$1',[id(c.req.param('id'))]);
  return c.json(rows[0]||{active_days:2,sleep_days:7,archive_days:24,active_seconds:300,cooling_seconds:3600,sleeping_seconds:21600,min_views_delta:100,min_replies_delta:1,min_reactions_delta:5});
});
telegramControl.put('/policies/:id',async c=>{
  const b=await parse(c,policy),keys=Object.keys(b);
  if(!(await query('select id from core.workflows where id=$1',[id(c.req.param('id'))])).length)throw new HTTPException(404);
  await query(`insert into core.telegram_watch_policies(workflow_id,${keys.join(',')}) values($1,${keys.map((_,i)=>'$'+(i+2)).join(',')}) on conflict(workflow_id) do update set ${keys.map(k=>k+'=excluded.'+k).join(',')},revision=core.telegram_watch_policies.revision+1`,[id(c.req.param('id')),...Object.values(b)]);
  await query("insert into core.audit(actor_id,action,object_type,object_id) values($1,'policy_updated','workflow',$2)",[c.get('user').id,c.req.param('id')]);
  return c.json({ok:true});
});
telegramControl.get('/watches',async c=>{
  const workflow=id(c.req.query('workflow_id')||'1');
  return c.json({items:await query('select item_id,state,external_id,kind,reason,last_error,next_check_at,last_checked_at,override_mode,url,collected_replies from core.telegram_watches where workflow_id=$1 order by last_checked_at desc nulls first,item_id desc limit 200',[workflow])});
});
telegramControl.post('/watches/:id',async c=>{
  const b=await parse(c,z.object({mode:z.enum(['auto','pinned','paused']),reason:z.string().max(500).default('')}).strict());
  const found=await query('select item_id from core.telegram_watches where item_id=$1',[id(c.req.param('id'))]);if(!found.length)throw new HTTPException(404);
  await query('insert into core.telegram_watch_overrides(item_id,mode,reason,updated_by) values($1,$2,$3,$4) on conflict(item_id) do update set mode=excluded.mode,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=now()', [c.req.param('id'),b.mode,b.reason,c.get('user').id]);
  await query("insert into core.audit(actor_id,action,object_type,object_id) values($1,$2,'telegram_watch',$3)",[c.get('user').id,b.mode,c.req.param('id')]);
  return c.json({ok:true});
});
