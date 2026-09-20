import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireSession, requirePermission, type AppEnv } from '../auth/middleware.js';
import { appPool } from '../db/pool.js';
import { query } from './telegram-admin.js';

const gate = z.object({ llm_allowed:z.boolean(), llm_basis:z.string().trim().max(1000) }).strict()
  .refine(value=>!value.llm_allowed||value.llm_basis.length>=10);

export const aiAdmin = new Hono<AppEnv>()
  .use('*',requireSession,requirePermission({collector:['manage']}))
  .get('/status',async c=>{
    const [states,budget,sources]=await Promise.all([
      query('select heartbeat_at,mode,model,last_error,limit_per_hour,last_label_at,last_summary_at from core.analyst_state where singleton'),
      query("select used from core.analyst_budget where hour=date_trunc('hour',now())"),
      query(`select s.id,s.title,s.kind,s.llm_allowed,s.llm_basis,r.rights_status
        from core.sources s left join core.rss_sources r on r.source_id=s.id order by s.kind,s.title,s.id`),
    ]);
    return c.json({...({heartbeat_at:null,mode:'waiting_key',model:null,last_error:null,limit_per_hour:60}),
      ...states[0],items_last_hour:budget[0]?.used||0,sources});
  })
  .post('/sources/allow-all',async c=>{
    const parsed=z.object({llm_basis:z.string().trim().min(10).max(1000)}).strict().safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)throw new HTTPException(400,{message:'Потрібна підстава дозволу (10–1000 символів).'});
    const basis=parsed.data.llm_basis,client=await appPool.connect();
    try{
      await client.query('begin');
      // Telegram дозволено прямим дорученням власника продукту. Для RSS зберігаємо
      // чинну межу прав: джерела зі статусом publisher-blocked не передаємо моделі.
      const updated=await client.query(`update core.sources s set llm_allowed=true,llm_basis=$1
        where s.enabled and not s.llm_allowed and (s.kind='telegram' or exists(
          select 1 from core.rss_sources r where r.source_id=s.id and r.rights_status='allowed')) returning s.id`,[basis]);
      for(const row of updated.rows)
        await client.query(`insert into core.audit(actor_id,action,object_type,object_id,detail)
          values($1,'llm_allowed','source',$2,$3::jsonb)`,[c.get('user').id,row.id,JSON.stringify({llm_allowed:true,llm_basis:basis,bulk:true})]);
      await client.query('commit');
      return c.json({updated:updated.rowCount??0});
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  })
  .put('/sources/:id',async c=>{
    const id=c.req.param('id');
    if(!/^[1-9]\d{0,17}$/.test(id))throw new HTTPException(400);
    const parsed=gate.safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)throw new HTTPException(400,{message:'Потрібні прапорець і підстава дозволу (10–1000 символів).'});
    const body=parsed.data,client=await appPool.connect();
    try{
      await client.query('begin');
      const source=await client.query('select id,kind from core.sources where id=$1 for update',[id]);
      if(!source.rows[0])throw new HTTPException(404);
      if(body.llm_allowed&&source.rows[0].kind==='rss'){
        const rights=await client.query('select rights_status from core.rss_sources where source_id=$1 for share',[id]);
        if(rights.rows[0]?.rights_status!=='allowed')throw new HTTPException(409,{message:'RSS-джерело не має дозволу на обробку.'});
      }
      await client.query('update core.sources set llm_allowed=$1,llm_basis=$2 where id=$3',[body.llm_allowed,body.llm_basis||null,id]);
      await client.query(`insert into core.audit(actor_id,action,object_type,object_id,detail)
        values($1,$2,'source',$3,$4::jsonb)`,[c.get('user').id,body.llm_allowed?'llm_allowed':'llm_revoked',id,JSON.stringify(body)]);
      await client.query('commit');
      return c.json({id,...body});
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  });
