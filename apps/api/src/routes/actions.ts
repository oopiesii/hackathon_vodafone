import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireSession, requirePermission, type AppEnv } from '../auth/middleware.js';
import { appPool } from '../db/pool.js';

const schema=z.object({status:z.enum(['none','investigating','responding','resolved'])}).strict();
export const actions=new Hono<AppEnv>().use(requireSession).use(requirePermission({collector:['manage']}));
actions.put('/:id/action',async c=>{
 const id=c.req.param('id');
 if(!/^[1-9]\d{0,14}$/.test(id))throw new HTTPException(400);
 const parsed=schema.safeParse(await c.req.json().catch(()=>null));
 if(!parsed.success)throw new HTTPException(422);
 const client=await appPool.connect();
 try{
  await client.query('begin');
  const item=(await client.query('select id from core.mentions where id=$1 and not deleted',[id])).rows[0];
  if(!item)throw new HTTPException(404);
  const action=(await client.query(`insert into core.action_status(mention_id,status,updated_by) values($1,$2,$3)
   on conflict(mention_id) do update set status=excluded.status,updated_by=excluded.updated_by,updated_at=now()
   returning mention_id,status,updated_at`,[id,parsed.data.status,c.get('user').id])).rows[0];
  await client.query("insert into core.audit(actor_id,action,object_type,object_id) values($1,$2,'document',$3)",[c.get('user').id,'action_'+parsed.data.status,id]);
  await client.query('commit');
  return c.json({action});
 }catch(error){await client.query('rollback');throw error;}finally{client.release();}
});
