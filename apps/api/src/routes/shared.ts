import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query } from './telegram-admin.js';
import { digest } from '../lib/secret.js';
import { env } from '../env.js';
import { getFeed,getDocument,type ShareScope } from './feed.js';

type SharedEnv={Variables:{share:ShareScope}};
const cookie=env.NODE_ENV==='production'?'__Host-ufv_share':'ufv_share';
export const shared=new Hono<SharedEnv>();
shared.post('/redeem',async c=>{
  const parsed=z.object({token:z.string().min(40).max(100)}).safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return c.json({error:'invalid_link'},401);
  const links=await query('select id from auth.share_links where token_hash=$1 and not revoked and expires_at>now()',[digest(parsed.data.token)]);
  if(!links.length)return c.json({error:'invalid_or_expired_link'},401);
  const token=randomBytes(32).toString('base64url');
  await query('delete from auth.share_sessions where expires_at<now()');
  await query("insert into auth.share_sessions(token_hash,share_id,expires_at) values($1,$2,now()+interval '12 hours')",[digest(token),links[0].id]);
  setCookie(c,cookie,token,{httpOnly:true,secure:env.NODE_ENV==='production',sameSite:'Strict',path:'/',maxAge:43200});
  return c.json({ok:true});
});
shared.use('*',async(c,next)=>{
  const token=getCookie(c,cookie)||'';
  const rows=await query('select l.* from auth.share_sessions s join auth.share_links l on l.id=s.share_id where s.token_hash=$1 and s.expires_at>now() and l.expires_at>now() and not l.revoked',[digest(token)]);
  if(!rows.length)return c.json({error:'invalid_or_expired_link'},401);
  c.set('share',rows[0] as ShareScope);await next();
});
shared.get('/me',c=>c.json({name:c.get('share').name,scope:c.get('share').scope,workflow_id:c.get('share').workflow_id}));
shared.get('/feed',async c=>c.json(await getFeed(c.req.query(),false,c.get('share'))));
shared.get('/documents/:id',async c=>c.json(await getDocument(c.req.param('id'),false,c.get('share'))));
shared.post('/logout',async c=>{await query('delete from auth.share_sessions where token_hash=$1',[digest(getCookie(c,cookie)||'')]);deleteCookie(c,cookie,{path:'/'});return c.json({ok:true});});
