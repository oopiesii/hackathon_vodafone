import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { monthlyRollups } from '../apps/api/dist/lib/monthly-rollups.js';

const start='2026-09-01T00:00:00Z';

test('coverage and rollups share one statement; no negative capability cache',async()=>{
 const calls=[];let available=false;
 const query=async(sql,params)=>{
  calls.push({sql,params});
  if(sql.includes('to_regclass'))return [{available}];
  return available?[{incomplete:0,source_id:null}]:[{source_id:'1',count:2}];
 };
 assert.equal((await monthlyRollups(query,'7',start,false))[0].count,2);
 assert.doesNotMatch(calls[1].sql,/dashboard_rollup_state/);
 available=true;
 assert.deepEqual(await monthlyRollups(query,'7',start,false),[]);
 assert.equal(calls.length,5);
 assert.match(calls[4].sql,/dashboard_rollup_state/);
 assert.match(calls[4].sql,/curated_daily_rollups/);
 assert.match(calls[4].sql,/st\.source_id is null or st\.dirty or st\.generated_at is null/);
 assert.deepEqual(calls[4].params,['7',start]);
});

test('migration during the legacy read discards unchecked rows and fails closed',async()=>{
 const calls=[];let probes=0;
 const query=async(sql,params)=>{
  calls.push({sql,params});
  if(sql.includes('to_regclass'))return [{available:++probes>1}];
  return sql.includes('with coverage')?[{incomplete:1,source_id:null}]:[{source_id:'1',count:999}];
 };
 await assert.rejects(monthlyRollups(query,'1',start,false),error=>error.status===503);
 assert.equal(calls.length,4);assert.equal(probes,2);
 assert.match(calls[3].sql,/with coverage/);
});

test('incomplete coverage fails closed, including an empty result',async()=>{
 for(const rows of [[{incomplete:1,source_id:null}],[]]){
  const query=async sql=>sql.includes('to_regclass')?[{available:true}]:rows;
  await assert.rejects(monthlyRollups(query,'1',start,false),error=>error instanceof HTTPException&&error.status===503&&/перераховуються/.test(error.message));
 }
});

test('permission or SQL errors never fall back to unchecked rows',async()=>{
 let calls=0;
 const denied=Object.assign(new Error('Synthetic permission denied'),{code:'42501'});
 const query=async()=>{calls++;if(calls===1)return [{available:true}];throw denied;};
 await assert.rejects(monthlyRollups(query,'1',start,false),error=>error===denied);
 assert.equal(calls,2);
});

test('0031 integration: dirty/absent generations, role scope, HTTP 503 and legacy lookup',{
 skip:!process.env.UFV_TEST_ENV,
},async()=>{
 const cfg=JSON.parse(await readFile(process.env.UFV_TEST_ENV,'utf8'));
 assert.equal(new URL(cfg.DATABASE_URL).pathname,'/ufv_checks','Isolated test database only');
 const db=new pg.Client({connectionString:cfg.DATABASE_URL});
 await db.connect();
 const query=async(sql,params)=>(await db.query(sql,params)).rows;
 const run=async(sql,params)=>db.query(sql,params);
 const asApi=()=>run('set local role ufv_api');
 const asOwner=()=>run('reset role');
 try{
  await run('begin');await run("set local statement_timeout='5s'");await run("set local lock_timeout='1s'");await run('set local jit=off');
  assert.equal((await query("select count(*)::int n from public.schema_migrations where name in ('0030_curated_atomic_rollups.sql','0031_legacy_rss_semantic_scope.sql')"))[0].n,2);
  const [{id:workflow}]=await query("insert into core.workflows(name) values('Synthetic rollback bridge; transaction only') returning id");
  const [{id:other}]=await query("insert into core.workflows(name) values('Synthetic unrelated dirty workflow') returning id");
  const createSource=async(w,key)=>(await query("insert into core.sources(workflow_id,kind,external_id,permission_note) values($1,'telegram',$2,'Synthetic test; transaction rollback only') returning id",[w,key]))[0].id;
  const first=await createSource(workflow,'synthetic-bridge-first');
  const second=await createSource(workflow,'synthetic-bridge-second');
  await createSource(other,'synthetic-bridge-foreign');
  const insertRollup=async(source,decision,count)=>run(`insert into core.daily_rollups
   (day,workflow_id,source_id,source_kind,topic,brand,decision,count,negative_count,negative_reach,views_measured,
    reaction_negative,reaction_ironic,reaction_sad,reaction_positive,reactions_measured,lag_samples,complaints)
   values(current_date,$1,$2,'telegram','network','vodafone',$3,$4,0,0,0,0,0,0,0,0,'{}',0)`,[workflow,source,decision,count]);
  await insertRollup(first,'accepted',2);await insertRollup(second,'review',1);
  const period=new Date(Date.now()-30*86400000).toISOString();
  const load=(review=false)=>monthlyRollups(query,workflow,period,review);
  await asApi();await assert.rejects(load(),error=>error.status===503);
  await asOwner();await run('update core.dashboard_rollup_state set dirty=false,generated_at=now() where source_id=any($1::bigint[])',[[first,second]]);
  await asApi();
  assert.equal((await load()).reduce((n,r)=>n+r.count,0),2);
  assert.equal((await load(true)).reduce((n,r)=>n+r.count,0),3);
  await asOwner();await run('update core.dashboard_rollup_state set dirty=true where source_id=$1',[second]);
  await asApi();
  // A clean accepted source must not hide an incomplete review/empty source.
  const app=new Hono().get('/',async c=>c.json(await load()));
  app.onError((error,c)=>error instanceof HTTPException?c.json({error:error.message},error.status):c.json({error:'internal'},500));
  const response=await app.request('/');assert.equal(response.status,503);
  assert.match((await response.json()).error,/Місячні агрегати перераховуються/);
  await asOwner();await run('update core.dashboard_rollup_state set dirty=false,generated_at=null where source_id=$1',[second]);
  await asApi();await assert.rejects(load(),error=>error.status===503);
  await asOwner();await run('delete from core.dashboard_rollup_state where source_id=$1',[second]);
  await asApi();await assert.rejects(load(),error=>error.status===503);
  await asOwner();await run('insert into core.dashboard_rollup_state(source_id,dirty,generated_at) values($1,false,now())',[second]);
  // Simulate the absent pre-0014 relation name inside a savepoint. Existing view
  // dependencies retain the same table OID; no shared schema change is committed.
  await run('savepoint legacy_capability');
  await run('alter table core.dashboard_rollup_state rename to bridge_test_rollup_state');
  await asApi();assert.equal((await load()).reduce((n,r)=>n+r.count,0),2);
  await run('rollback to savepoint legacy_capability');
  await asOwner();await run('delete from core.daily_rollups where workflow_id=$1',[workflow]);
  await asApi();assert.deepEqual(await load(),[]);
 }finally{
  await db.query('rollback');await db.end();
 }
});
