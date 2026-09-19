import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireSession, requirePermission, type AppEnv } from '../auth/middleware.js';
import { appPool } from '../db/pool.js';
import { query } from './telegram-admin.js';

const toggle = z.object({ enabled: z.boolean() }).strict();
const settings = z.object({ enabled:z.boolean(), poll_seconds:z.number().int().min(120).max(86400) }).strict();
const bulk = z.object({ urls:z.string().min(1).max(15000), workflow_id:z.number().int().positive(),
  permission_note:z.string().trim().min(20).max(1000), terms_url:z.string().url().max(2048),
  poll_seconds:z.number().int().min(120).max(86400).default(300), enabled:z.boolean().default(true) }).strict();
async function body<T>(c:{req:{json:()=>Promise<unknown>}},schema:z.ZodType<T>):Promise<T>{
  const result=schema.safeParse(await c.req.json().catch(()=>null));
  if(!result.success)throw new HTTPException(422,{message:'Перевірте поля RSS: '+result.error.issues.map(i=>i.path.join('.')).join(', ')});
  return result.data;
}
function feedUrl(raw:string){
  try {
    const u=new URL(raw);
    if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||u.hash||!u.hostname.includes('.')||raw.length>2048)throw new Error();
    return u.href;
  } catch {throw new HTTPException(422,{message:'Потрібна публічна HTTPS-адреса RSS без пароля та fragment.'});}
}
function ident(v:string){if(!/^\d+$/.test(v))throw new HTTPException(400);return v;}
export const rssAdmin=new Hono<AppEnv>().use(requireSession).use(requirePermission({collector:['manage']}));
rssAdmin.get('/',async c=>{
  const [module,items,services,workflows]=await Promise.all([
    query("select enabled from core.modules where name='rss'"),query('select * from core.rss_status order by enabled desc,publisher,title'),
    query("select * from raw.service_status where name='collector-rss'"),query('select id,name,enabled from core.workflows order by id'),
  ]);
  return c.json({enabled:module[0]?.enabled??false,items,service:services[0]??null,workflows});
});
rssAdmin.post('/module',async c=>{
  const b=await body(c,toggle);
  await query("update core.modules set enabled=$1 where name='rss'",[b.enabled]);
  await query("insert into core.audit(actor_id,action,object_type) values($1,$2,'rss')",[c.get('user').id,b.enabled?'module_enabled':'module_disabled']);
  return c.json(b);
});
rssAdmin.put('/sources/:id',async c=>{
  const b=await body(c,settings), id=ident(c.req.param('id'));
  const client=await appPool.connect();
  try {
    await client.query('begin');
    const rows=(await client.query('select rights_status from core.rss_sources where source_id=$1 for update',[id])).rows;
    if(!rows.length)throw new HTTPException(404);
    if(b.enabled&&rows[0].rights_status!=='allowed')throw new HTTPException(422,{message:'Для цього джерела ще немає підтверджених прав на регулярне використання.'});
    await client.query("update core.sources set enabled=$1 where id=$2 and kind='rss'",[b.enabled,id]);
    await client.query('update core.rss_sources set poll_seconds=$1,revision=revision+1 where source_id=$2',[b.poll_seconds,id]);
    await client.query("insert into core.audit(actor_id,action,object_type,object_id) values($1,'settings_updated','rss',$2)",[c.get('user').id,id]);
    await client.query('commit');
  } catch(e){await client.query('rollback');throw e;}finally{client.release();}
  return c.json({ok:true});
});
rssAdmin.post('/sources',async c=>{
  const b=await body(c,bulk);
  const urls=[...new Set(b.urls.split(/\s+/).filter(Boolean).map(feedUrl))];
  if(!urls.length||urls.length>50)throw new HTTPException(422,{message:'Додайте від 1 до 50 RSS-посилань.'});
  const client=await appPool.connect();let added=0;
  try {
    await client.query('begin');
    for(const url of urls){
      const publisher=new URL(url).hostname;
      const result=await client.query(`insert into core.sources(kind,external_id,title,enabled,workflow_id,permission_note)
        values('rss',$1,$2,$3,$4,$5) on conflict(kind,external_id) do nothing returning id`,[url,publisher,b.enabled,b.workflow_id,b.permission_note]);
      if(!result.rows.length)continue; // Existing restrictions/configuration are never overwritten by bulk import.
      const id=result.rows[0].id;
      await client.query(`insert into core.rss_sources(source_id,poll_seconds,rights_status,terms_url,publisher)
        values($1,$2,'allowed',$3,$4)`,[id,b.poll_seconds,b.terms_url,publisher]);
      await client.query("insert into core.audit(actor_id,action,object_type,object_id) values($1,'source_added','rss',$2)",[c.get('user').id,id]);added++;
    }
    await client.query('commit');
  }catch(e){await client.query('rollback');throw e;}finally{client.release();}
  return c.json({added,existing:urls.length-added},201);
});
