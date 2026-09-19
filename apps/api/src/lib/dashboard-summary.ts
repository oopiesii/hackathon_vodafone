import { z } from 'zod';
import type { DashboardSummary, DashboardWindow } from '@ufv/shared/dashboard';
import { query } from '../routes/telegram-admin.js';

const bodySchema=z.object({
 headline:z.string().min(1).max(240),
 observations:z.array(z.object({text:z.string().min(1).max(600),evidence:z.array(z.object({id:z.number().int().positive().safe(),quote:z.string().min(1).max(240)})).min(1).max(3)})).max(5),
 limitations:z.array(z.string().max(300)).max(5),
 provenance:z.object({counts:z.object({total:z.number().int().nonnegative(),accepted:z.number().int().nonnegative()}),evidence_sample:z.number().int().nonnegative().max(20)}),
});
const iso=(value:string|Date)=>new Date(value).toISOString();

/** S2 is a timestamped result, not a claim that the analyst is currently online. */
export async function dashboardSummary(workflow:string,window:DashboardWindow,review:boolean,fallback:DashboardSummary,aggregateComplete=true):Promise<DashboardSummary>{
 // LLM-SEAM(S2-summary): read only validator-approved, permission/current-version scoped results.
 // No text is sent to a model by this endpoint. Unavailable results retain role-scoped rules.
 const [states,rows]=await Promise.all([
  query('select mode,heartbeat_at from core.analyst_state where singleton'),
  aggregateComplete?query(`select a.*${window==='30d'?",'[]'::jsonb evidence":`,e.evidence`} from (
   select * from core.current_ai_summaries where workflow_id=$1 and "window"=$2
    and generated_at>=now()-interval '30 minutes' and window_end>=now()-interval '30 minutes'
    and generated_at<=now() and window_end<=now()
    order by generated_at desc,id desc limit 5
   ) a ${window==='30d'?'':`left join lateral (
    select coalesce(jsonb_agg(jsonb_build_object('id',d.id::text,'raw_item_id',d.raw_item_id::text,'url',d.url,'text',d.quote)),'[]') evidence
    from core.curated_items d where d.workflow_id=a.workflow_id and d.raw_item_id=any(a.evidence_ids)
      and d.decision=any($3::text[])
   ) e on true`} order by a.generated_at desc,a.id desc`,window==='30d'?[workflow,window]:[workflow,window,review?['accepted','review']:['accepted']]):Promise.resolve([]),
 ]);
 const state=states[0];
 const fresh=Boolean(state&&Date.now()-new Date(state.heartbeat_at).getTime()>=-60000&&Date.now()-new Date(state.heartbeat_at).getTime()<300000);
 const status:DashboardSummary['status']=!fresh?'unavailable':state.mode==='waiting_key'?'waiting_key':state.mode==='rate_limited'?'rate_limited':state.mode==='error'?'error':'pending';
 const labels:Record<string,string>={unavailable:'Стан AI-сервісу не підтверджено',waiting_key:'AI очікує ключ',rate_limited:'AI очікує ліміт',error:'AI потребує перевірки',pending:'AI готує зведення'};
 const result:DashboardSummary={...fallback,status,label:labels[status]!,mode:'rules',generated_at:null,model:null,observations:[],limitations:['Показано агрегати доступних матеріалів.']};
 for(const row of rows){
  const parsed=bodySchema.safeParse(row.body);
  if(!parsed.success)continue;
  const body=parsed.data;
  // Existing S2 aggregates include rejected/pending inputs. A viewer may only see
  // the complete body when the entire model input was accepted, never a redacted body.
  if(!review&&(body.provenance.counts.total!==body.provenance.counts.accepted||body.provenance.counts.accepted===0))continue;
  if(window==='30d'&&(body.observations.length||row.evidence_ids.length))continue;
  const evidenceRows=row.evidence as Array<{id:string;raw_item_id:string;url:string;text:string}>;
  const evidenceById=new Map(evidenceRows.map(e=>[e.raw_item_id,e]));
  let valid=true;
  const observations=body.observations.map(observation=>({text:observation.text,evidence:observation.evidence.map(e=>{
   const saved=evidenceById.get(String(e.id));
   if(!saved||!saved.text.includes(e.quote)||!/^https?:\/\//i.test(saved.url)){valid=false;return null;}
   return {id:saved.id,raw_item_id:saved.raw_item_id,quote:e.quote,url:saved.url,
    href:'/feed?'+new URLSearchParams({workflow_id:workflow,ids:saved.id,decision:review?'visible':'accepted'})};
  })}));
  if(!valid)continue;
  const proof='/'+(review?'inbox':'feed')+'?'+new URLSearchParams({workflow_id:workflow,source_ids:row.source_ids.join(',')||'0',
   from:iso(row.window_start),until:iso(row.window_end),...(review?{}:{decision:'accepted'})});
  return {...result,status:row.mode==='ai'&&status==='pending'?'ready':status,
   label:row.mode==='ai'&&status==='pending'?'AI-зведення':row.mode==='rules'&&status==='pending'?'Шаблонне зведення':labels[status]!,
   mode:row.mode,summary:row.mode==='rules'?`Матеріалів за період у джерелах із дозволом на AI: ${body.provenance.counts.total.toLocaleString('uk-UA')}; прийнятих: ${body.provenance.counts.accepted.toLocaleString('uk-UA')}.`:body.headline,href:proof,generated_at:iso(row.generated_at),model:row.model,
   window_start:iso(row.window_start),window_end:iso(row.window_end),observations:observations as DashboardSummary['observations'],
   limitations:row.mode==='rules'?['Шаблонне зведення за підрахунками актуального відбору; модельного висновку немає.']:body.limitations,coverage:{scope:'allowed_sources',evidence_sample:body.provenance.evidence_sample,
    note:'Знімок тільки джерел із чинним дозволом на AI; покриття може відрізнятися від загальних метрик.'}};
 }
 if(review===false&&status==='pending')return {...result,status:'rules',label:'Зведення · лише прийняті матеріали'};
 return result;
}
