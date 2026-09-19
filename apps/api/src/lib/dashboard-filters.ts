import { HTTPException } from 'hono/http-exception';
/** All fragments are fixed SQL. Request values only travel through bound parameters. */
export function dashboardFilters(params:Record<string,string>,add:(value:unknown)=>string,alias='d') {
 const filters:string[]=[];
 const field=(name:string)=>alias+'.'+name;
 for(const key of ['from','until'])if(params[key]){
  if(!/^\d{4}-\d\d-\d\dT/.test(params[key]!)||!Number.isFinite(Date.parse(params[key]!)))throw new HTTPException(400);
  filters.push(field('event_at')+(key==='from'?'>=':'<=')+add(new Date(params[key]!).toISOString())+'::timestamptz');
 }
 if(params.day){if(!/^\d{4}-\d\d-\d\d$/.test(params.day))throw new HTTPException(400);filters.push(`(${field('event_at')} at time zone 'Europe/Kyiv')::date=`+add(params.day)+'::date');}
 if(params.source_id){if(!/^[1-9]\d{0,14}$/.test(params.source_id))throw new HTTPException(400);filters.push(field('source_id')+'='+add(params.source_id));}
 if(params.source_kind){if(!['rss','telegram'].includes(params.source_kind))throw new HTTPException(400);filters.push(field('source_kind')+'='+add(params.source_kind));}
 if(params.brand){if(!['vodafone','kyivstar','lifecell','telecom'].includes(params.brand))throw new HTTPException(400);filters.push(field('brand')+'='+add(params.brand));}
 if(params.ids){const ids=params.ids.split(',');if(ids.length>1000||ids.some(id=>!/^\d{1,15}$/.test(id)))throw new HTTPException(400);filters.push(field('id')+'=any('+add(ids)+'::bigint[])');}
 if(params.negative==='1')filters.push(field('negative')+'=true');
 if(params.has_views==='1')filters.push(field('views')+' is not null');
 if(params.has_reactions==='1')filters.push(`jsonb_typeof(${field('reactions')})='object'`);
 if(params.lag==='1')filters.push(field('lag_seconds')+' is not null');
 if(params.window){
  if(!['24h','7d','30d'].includes(params.window))throw new HTTPException(400);
  const end=params.until||new Date().toISOString();
  filters.push(`(${field('kind')}<>'comment' or (${field('watch_active')} and ${field('event_at')}>=${add(end)}::timestamptz-interval '7 days'))`);
 }
 return filters;
}
