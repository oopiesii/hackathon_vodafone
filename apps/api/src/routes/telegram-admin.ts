import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { requireSession, requirePermission, type AppEnv } from '../auth/middleware.js';
import { appPool } from '../db/pool.js';
import { encrypt, digest } from '../lib/secret.js';

export const query = async (text: string, values: unknown[] = []) => (await appPool.query(text,values)).rows;
const workflow = z.object({name:z.string().trim().min(1).max(120),enabled:z.boolean().default(false),comments_enabled:z.boolean().default(true),filter_spam:z.boolean().default(true),poll_seconds:z.number().int().min(15).max(3600).default(30),history_days:z.number().int().min(1).max(90).default(7)}).strict();
const account = z.object({label:z.string().trim().min(1).max(80),api_id:z.number().int().positive(),api_hash:z.string().regex(/^[a-f\d]{32}$/i),session:z.string().min(100).max(1000),enabled:z.boolean().default(true)}).strict();
const channel = z.object({workflow_id:z.number().int().positive(),account_id:z.number().int().positive(),username:z.string().regex(/^@?[a-z][a-z\d_]{3,31}$/i),permission_note:z.string().min(10).max(1000),enabled:z.boolean().default(true)}).strict();
const share = z.object({workflow_id:z.number().int().positive(),name:z.string().min(1).max(120),scope:z.enum(['summary','posts','full']),channel_ids:z.array(z.number().int().positive()).max(100).default([]),topics:z.array(z.enum(['mobile','internet','network','billing','support','other'])).max(6).default([]),expires_days:z.number().int().min(1).max(90).default(7)}).strict();
const toggle = z.object({enabled:z.boolean()}).strict();
async function body<T>(c: {req:{json:()=>Promise<unknown>}}, schema:z.ZodType<T>):Promise<T> {
  const p=schema.safeParse(await c.req.json().catch(()=>null));
  if(!p.success) throw new HTTPException(422,{message:'Некоректні поля: '+p.error.issues.map(i=>i.path.join('.')).join(', ')});
  return p.data;
}
const idOf = (value:string) => {if(!/^\d+$/.test(value))throw new HTTPException(400);return value;};
const audit = (actor:string, action:string, type:string, id?:string|number) => query('insert into core.audit(actor_id,action,object_type,object_id) values($1,$2,$3,$4)',[actor,action,type,id??null]);
function sessionFields(b:z.infer<typeof account>) {
  const packed=Buffer.from(b.session.trim().slice(1),'base64url');
  if(b.session[0]!=='1' || ![263,275].includes(packed.length)) throw new HTTPException(422,{message:'Некоректна Telethon StringSession'});
  return [b.label,b.api_id,encrypt(b.api_hash),encrypt(b.session.trim()),digest(packed.subarray(-256).toString('hex')),b.enabled];
}
function ids(row:Record<string,unknown>) {for(const key of ['id','workflow_id','account_id','channel_id','expires_at','cooldown_until']) if(row[key]!=null)row[key]=Number(row[key]); return row;}

export const telegramAdmin = new Hono<AppEnv>().use(requireSession).use(requirePermission({collector:['manage']}));
telegramAdmin.get('/state',async c=>{
  const [modules,accounts,workflows,channels,memberships,threads,shares,auditRows,services]=await Promise.all([
    query("select enabled from core.modules where name='telegram'"),
    query("select a.id,a.label,a.api_id,a.enabled,a.revision,case when a.session is null then 'setup_required' when a.api_id is null or a.api_hash is null then 'api_credentials_required' else coalesce(s.status,'pending') end status,(a.session is not null and a.api_id is not null and a.api_hash is not null) credentials_ready,(a.session is not null) has_session,s.last_error,extract(epoch from s.cooldown_until) cooldown_until,s.checked_at from core.telegram_accounts a left join raw.account_status s on s.account_id=a.id order by a.id"),
    query('select * from core.workflows order by id'),
    query("select c.id,c.workflow_id,c.account_id,c.external_id username,c.enabled,c.permission_note,c.history_since,s.peer_id,coalesce(s.title,c.title) title,coalesce(s.post_cursor,0) post_cursor,coalesce(s.status,'pending') status,s.last_error,s.last_polled_at,s.last_success_at,s.source_type from core.sources c left join raw.source_state s on s.source_id=c.id where c.kind='telegram' order by c.id"),
    query('select * from raw.memberships order by account_id,username'),
    query('select id,source_id channel_id,post_id,discussion_id,root_id,comment_cursor,last_polled_at,status,last_error from raw.threads order by id desc limit 100'),
    query('select id,workflow_id,name,scope,channel_ids::text,topics::text,extract(epoch from expires_at) expires_at,revoked,created_at from auth.share_links order by id desc'),
    query('select occurred_at,action,object_type,object_id from core.audit order by id desc limit 30'),
    query('select * from raw.service_status union all select * from core.service_status'),
  ]);
  return c.json({telegram_enabled:modules[0].enabled,accounts:accounts.map(ids),workflows:workflows.map(ids),channels:channels.map(ids),memberships:memberships.map(ids),threads:threads.map(ids),shares:shares.map(ids),audit:auditRows,services,classifier:'rules-v2'});
});
telegramAdmin.post('/module',async c=>{const b=await body(c,toggle);await query("update core.modules set enabled=$1 where name='telegram'",[b.enabled]);await audit(c.get('user').id,b.enabled?'module_enabled':'module_disabled','telegram');return c.json(b);});
telegramAdmin.post('/workflows',async c=>{const b=await body(c,workflow);const rows=await query('insert into core.workflows(name,enabled,comments_enabled,filter_spam,poll_seconds,history_days) values($1,$2,$3,$4,$5,$6) returning id',Object.values(b));await audit(c.get('user').id,'created','workflow',rows[0].id);return c.json(rows[0]);});
telegramAdmin.put('/workflows/:id',async c=>{const b=await body(c,workflow);await query('update core.workflows set name=$1,enabled=$2,comments_enabled=$3,filter_spam=$4,poll_seconds=$5,history_days=$6,processor_revision=processor_revision+1 where id=$7',[...Object.values(b),idOf(c.req.param('id'))]);await audit(c.get('user').id,'updated','workflow',c.req.param('id'));return c.json({ok:true});});
telegramAdmin.post('/workflows/:id/reprocess',async c=>{await query('update core.workflows set processor_revision=processor_revision+1 where id=$1',[idOf(c.req.param('id'))]);const r=await query('select count(*)::int count from core.mentions m join core.sources s on s.id=m.source_id where s.workflow_id=$1',[c.req.param('id')]);await audit(c.get('user').id,'reprocess_requested','workflow',c.req.param('id'));return c.json({count:r[0].count,queued:true});});
telegramAdmin.post('/accounts/prepare', async c => {
  const client = await appPool.connect();
  let rows;
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(727102)');
    const existing = await client.query('select id from core.telegram_accounts order by id');
    for (let n = existing.rows.length; n < 2; n++) {
      await client.query('insert into core.telegram_accounts(label,enabled) values($1,false)', ['Telegram ' + (n + 1)]);
    }
    rows = (await client.query('select id,label,(session is not null and api_id is not null and api_hash is not null) credentials_ready from core.telegram_accounts order by id')).rows;
    await client.query('commit');
  } catch (error) {
    await client.query('rollback'); throw error;
  } finally { client.release(); }
  await audit(c.get('user').id, 'setup_prepared', 'telegram');
  return c.json({accounts:rows});
});
telegramAdmin.post('/accounts',async c=>{const b=await body(c,account);const rows=await query('insert into core.telegram_accounts(label,api_id,api_hash,session,session_fingerprint,enabled) values($1,$2,$3,$4,$5,$6) returning id',sessionFields(b));await audit(c.get('user').id,'created','account',rows[0].id);return c.json(rows[0]);});
telegramAdmin.put('/accounts/:id',async c=>{const b=await body(c,account);await query('update core.telegram_accounts set label=$1,api_id=$2,api_hash=$3,session=$4,session_fingerprint=$5,enabled=$6,revision=revision+1 where id=$7',[...sessionFields(b),idOf(c.req.param('id'))]);await audit(c.get('user').id,'credentials_rotated','account',c.req.param('id'));return c.json({ok:true});});
telegramAdmin.post('/accounts/:id/credentials', async c => {
  const b = await body(c, z.object({api_id:z.number().int().positive(),api_hash:z.string().regex(/^[a-f\d]{32}$/i)}).strict());
  const rows = await query('update core.telegram_accounts set api_id=$1,api_hash=$2,enabled=true,revision=revision+1 where id=$3 and session is not null returning id', [b.api_id,encrypt(b.api_hash),idOf(c.req.param('id'))]);
  if (!rows.length) throw new HTTPException(422,{message:'Спочатку потрібна збережена сесія'});
  await audit(c.get('user').id,'api_credentials_completed','account',c.req.param('id'));
  return c.json({ok:true});
});
telegramAdmin.post('/accounts/:id/toggle',async c=>{const b=await body(c,toggle);const changed=await query('update core.telegram_accounts set enabled=$1,revision=revision+1 where id=$2 and (not $1 or (session is not null and api_id is not null and api_hash is not null)) returning id',[b.enabled,idOf(c.req.param('id'))]);if(!changed.length)throw new HTTPException(422,{message:'Спочатку підключіть авторизовану сесію'});await audit(c.get('user').id,b.enabled?'enabled':'disabled','account',c.req.param('id'));return c.json({ok:true});});
telegramAdmin.post('/accounts/:id/refresh',async c=>{await query('update core.telegram_accounts set revision=revision+1 where id=$1',[idOf(c.req.param('id'))]);return c.json({ok:true});});
telegramAdmin.delete('/accounts/:id',async c=>{await query('delete from core.telegram_accounts where id=$1',[idOf(c.req.param('id'))]);await audit(c.get('user').id,'deleted','account',c.req.param('id'));return c.json({ok:true});});
telegramAdmin.post('/channels',async c=>{
  const b=await body(c,channel);
  const rows=await query("insert into core.sources(kind,external_id,workflow_id,account_id,permission_note,enabled,history_since) select 'telegram',$1,$2,$3,$4,$5,now()-make_interval(days=>history_days) from core.workflows where id=$2 returning id",[b.username.replace(/^@/,'').toLowerCase(),b.workflow_id,b.account_id,b.permission_note,b.enabled]);
  if(!rows.length)throw new HTTPException(404);await audit(c.get('user').id,'created','channel',rows[0].id);return c.json(rows[0]);
});
telegramAdmin.put('/channels/:id',async c=>{const b=await body(c,z.object({account_id:z.number().int().positive(),enabled:z.boolean(),permission_note:z.string().min(10).max(1000)}).strict());await query('update core.sources set account_id=$1,enabled=$2,permission_note=$3 where id=$4',[b.account_id,b.enabled,b.permission_note,idOf(c.req.param('id'))]);await audit(c.get('user').id,'updated','channel',c.req.param('id'));return c.json({ok:true});});
telegramAdmin.post('/shares',async c=>{
  const b=await body(c,share);
  if(b.channel_ids.length){const allowed=await query('select id from core.sources where workflow_id=$1 and id=any($2::bigint[])',[b.workflow_id,b.channel_ids]);if(allowed.length!==new Set(b.channel_ids).size)throw new HTTPException(422,{message:'Канал поза workflow'});}
  const token=randomBytes(32).toString('base64url');
  const r=await query('insert into auth.share_links(workflow_id,name,token_hash,scope,channel_ids,topics,expires_at,created_by) values($1,$2,$3,$4,$5,$6,now()+make_interval(days=>$7),$8) returning id',[b.workflow_id,b.name,digest(token),b.scope,JSON.stringify(b.channel_ids),JSON.stringify(b.topics),b.expires_days,c.get('user').id]);
  await audit(c.get('user').id,'created','share',r[0].id);return c.json({id:r[0].id,url:'/view#'+token});
});
telegramAdmin.delete('/shares/:id',async c=>{await query('update auth.share_links set revoked=true where id=$1',[idOf(c.req.param('id'))]);await query('delete from auth.share_sessions where share_id=$1',[c.req.param('id')]);await audit(c.get('user').id,'revoked','share',c.req.param('id'));return c.json({ok:true});});
telegramAdmin.post('/documents/:id/review',async c=>{
  const b=await body(c,z.object({decision:z.enum(['accepted','review','rejected'])}));
  const client=await appPool.connect();
  try{
    await client.query('begin');
    const rows=(await client.query('insert into core.review_decisions(mention_id,decision,raw_version,reviewed_by) select id,$1,raw_version,$2 from core.mentions where id=$3 on conflict(mention_id) do update set decision=excluded.decision,raw_version=excluded.raw_version,reviewed_by=excluded.reviewed_by,reviewed_at=now() returning mention_id',[b.decision,c.get('user').id,idOf(c.req.param('id'))])).rows;
    if(!rows.length)throw new HTTPException(404);
    // The processor owns receipts. Invalidate through workflow configuration so
    // replies also see a newly accepted/rejected parent without granting raw writes.
    await client.query('update core.workflows set processor_revision=processor_revision+1 where id in (select s.workflow_id from core.sources s join core.mentions m on m.source_id=s.id where m.id=$1)',[c.req.param('id')]);
    await client.query('insert into core.audit(actor_id,action,object_type,object_id) values($1,$2,$3,$4)',[c.get('user').id,'review_'+b.decision,'document',c.req.param('id')]);
    await client.query('commit');return c.json({ok:true});
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
});
