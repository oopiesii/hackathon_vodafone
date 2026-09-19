// Локальний рендер production bundle + CSP з явно синтетичним API.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, resolve, join } from 'node:path';
import { dashboard } from '../tests/fixtures/dashboard.mjs';
const require = createRequire('/opt/ufv/.codex/skills/design-check/');
const { chromium } = require('playwright-core');
const root = resolve('apps/web/dist'), out = resolve(process.env.UFV_SHOTS || 'artifacts/night-dashboard');
await mkdir(out, {recursive:true});
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";
const mime = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.woff2':'font/woff2'};
const adminUser = {id:'test',email:'demo@example.test',name:'Тестова демонстрація',role:'admin'};
const server = createServer(async (req,res) => {
 const url=new URL(req.url,'http://localhost'), path=url.pathname, scenario=req.headers['x-scenario']||'populated';
 if(path.startsWith('/api/')) {
  let data;
  const user={...adminUser,role:scenario==='viewer'?'viewer':'admin'};
  if(path==='/api/auth/get-session') data={session:{id:'synthetic',userId:'test',expiresAt:'2099-01-01T00:00:00Z'},user};
  if(path==='/api/me') data={user,permissions:scenario==='viewer'?{incident:['view']}:{incident:['view','edit'],collector:['read','manage'],user:['list','create']}};
  if(path==='/api/admin/refresh') data={requests:['refresh','stale-refresh'].includes(scenario)?[{id:'1',workflow_id:'1',service:'telegram',status:'running',stale:scenario==='stale-refresh',collector_online:scenario!=='stale-refresh',requested_at:dashboard.end,started_at:dashboard.end,completed_at:null,detail:scenario==='stale-refresh'?'Немає свіжого сигналу збирача. Запит залишається в черзі; оновлення не підтверджено.':'Синтетична перевірка: збирач прийняв запит.'},{id:'2',workflow_id:'1',service:'rss',status:'deferred',requested_at:dashboard.end,started_at:dashboard.end,completed_at:dashboard.end,detail:'Очікування лімітів джерела збережено.'}]:[]};
  if(path==='/api/admin/state') data={telegram_enabled:true,accounts:[{id:1,label:'Демо',credentials_ready:false,status:'waiting'}],channels:[],services:[],threads:[{id:1,channel_id:1,post_id:1,comment_cursor:0,status:'resolve',last_error:null,last_polled_at:null}],audit:[],memberships:[],shares:[{id:1,workflow_id:1,name:'Синтетичне прострочене посилання',scope:'posts',channel_ids:'[]',topics:'["network"]',expires_at:1,revoked:false}],workflows:[{id:1,name:'Синтетичний workflow',enabled:true,comments_enabled:true,filter_spam:true,poll_seconds:30,history_days:7}]};
  if(path==='/api/admin/rss') data={enabled:true,items:[],service:null,workflows:[{id:'1',name:'Демонстрація',enabled:true}]};
  if(path==='/api/admin/ai/status') data={heartbeat_at:scenario==='stale-ai'?'2020-01-01T00:00:00Z':new Date().toISOString(),mode:scenario==='stale-ai'?'active':'waiting_key',model:null,last_error:null,limit_per_hour:60,items_last_hour:0,sources:[{id:'1',kind:'telegram',title:'Синтетичний Telegram',llm_allowed:false,llm_basis:null,rights_status:null},{id:'2',kind:'rss',title:'Дозволений RSS',llm_allowed:true,llm_basis:'Синтетична підстава',rights_status:'allowed'},{id:'3',kind:'rss',title:'Заблокований RSS',llm_allowed:false,llm_basis:null,rights_status:'blocked'}]};
  if(path==='/api/workflows') data={items:[{id:'1',name:'Vodafone та український телеком'}]};
  const item={id:'1',source_kind:'telegram',text:'Синтетичний приклад: перевірка матеріалу Vodafone.',summary:'',source_url:'https://example.test/evidence',published_at:dashboard.end,fetched_at:dashboard.end,processed_at:dashboard.end,edited_at:null,kind:'post',topic:'network',channel_title:'Синтетичне джерело',reason:'Тестовий матеріал',duplicate_of:null,context_id:null,manual_decision:null};
  if(path==='/api/feed') data={items:[item],total:{count:1,last_processed_at:dashboard.end},kinds:[{kind:'post',count:1}],topics:[{topic:'network',count:1}],next_before:null,summary_only:false,telegram_enabled:true};
  if(path==='/api/documents/1') data={document:item,context:null};
  if(path==='/api/inbox') data={items:[],counts:[],sources:[],next_before:null};
  if(path==='/api/dashboard') {
   if(url.searchParams.get('window')==='7d'&&process.argv.includes('--flow'))await new Promise(r=>setTimeout(r,750));
   if(scenario==='error'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'unavailable'}));return;}
   if(scenario==='loading'){await new Promise(r=>setTimeout(r,5000));}
   data=structuredClone(dashboard);
   if(scenario==='empty'){data.signals=[];data.sources=[];data.spread=[];data.competitors=[];data.counts={accepted:0,review:0,collected:85,rejected:85,pending:0};for(const m of Object.values(data.metrics)){m.value=m.unit==='матеріалів'?0:null;m.series=[];m.measured=0;}data.reactions={...data.reactions,negative:0,ironic:0,sad:0,positive:0,total:0,observed_items:0};data.hourly=data.hourly.map(h=>({...h,count:0,topics:{}}));data.ai.summary="За правилами: тематичних матеріалів немає; зібрано 85, відсіяно 85.";data.brand_status={...data.brand_status,level:'unknown',title:'Недостатньо тематичних матеріалів'};}
   if(scenario==='calculating'){data.aggregation={complete:false,generated_at:null,note:'Перераховуємо агрегати після оновлення матеріалів. Неповні лічильники приховано.'};data.aggregated=true;data.signals=[];for(const m of Object.values(data.metrics)){m.value=null;m.series=[];}data.brand_status.level='unknown';data.brand_status.reason='Очікуємо повного зрізу';data.ai.summary='Перерахунок агрегатів триває.';}
   if(scenario==='ai'){data.ai={...data.ai,status:'ready',mode:'ai',label:'AI · синтетичний приклад',model:'test-model',generated_at:dashboard.end,summary:'Синтетичне зведення: матеріали повідомляють про перебої зв’язку. Це приклад для перевірки інтерфейсу.',observations:[{text:'У тестовому повідомленні згадано перебої мобільного інтернету. Причину не встановлено.',evidence:[{id:'1',raw_item_id:'1',quote:'Синтетичний приклад: перевірка матеріалу Vodafone.',url:'https://example.test/evidence',href:'/feed?workflow_id=1&ids=1'}]}],coverage:{scope:'allowed_sources',evidence_sample:1,note:'Лише один синтетичний доказ; повнота покриття не оцінюється.'},limitations:['Це синтетичний приклад, не реальне зведення.']};}
   if(scenario==='long'){data.brand_status.title='Надзвичайно довга назва питання для перевірки перенесення рядків та збереження всіх змістовних слів у вузькій картці';data.sources[0].title='Надзвичайнодовганазваджерелабезпробілів'.repeat(4);data.signals[0].title=data.brand_status.title;data.metrics.mentions.value=10000;data.metrics.negative_reach.value=1258901234;}
   if(scenario==='disabled') data.freshness.forEach(s=>s.enabled=false);
   if(scenario==='viewer'){data.visibility='accepted';delete data.metrics.noise;data.counts={accepted:96};}
   if(url.searchParams.get('window')==='30d'){data.window='30d';data.aggregated=true;data.signals=[];}
  }
  res.writeHead(data===undefined?404:200,{'content-type':'application/json'});res.end(JSON.stringify(data??{error:'not_found'}));return;
 }
 try {const file=extname(path)?join(root,path):join(root,'index.html');res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream','content-security-policy':csp});res.end(await readFile(file));}
 catch{res.writeHead(404);res.end();}
}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const browser = await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const reports=[];
const scenarios=process.env.UFV_SCENARIO?[process.env.UFV_SCENARIO]:process.argv.includes('--states')?['empty','error','loading','long','disabled','viewer','calculating','refresh']:['populated'];
for(const scenario of scenarios) for(const width of [1440,768,390]) for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,locale:'uk-UA',timezoneId:'Europe/Kyiv',extraHTTPHeaders:{'x-scenario':scenario}});
 const page=await context.newPage(), errors=[];
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error'&&scenario!=='error')errors.push(m.text());});
 await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
 if(scenario==='loading') await page.getByText('Збираємо показники').waitFor(); else if(scenario==='error') await page.getByText('Не вдалося оновити дашборд.').waitFor(); else await page.getByRole('link',{name:/Перевірити докази/}).waitFor();
 await page.evaluate(()=>document.fonts.ready);
 if(['refresh','stale-refresh'].includes(scenario)) await page.getByText('Перебіг збору',{exact:true}).click();
 const issues=await page.evaluate(()=>{
  const result=[], styles=getComputedStyle(document.documentElement), scale=new Set(['xs','sm','base','md','lg','xl','2xl'].map(s=>parseFloat(styles.getPropertyValue('--f-'+s))));
  const vw=document.documentElement.clientWidth;
  if(document.documentElement.scrollWidth>vw+1)result.push('document overflow');
  for(const el of document.querySelectorAll('.dashboard *')){
   const r=el.getBoundingClientRect(),s=getComputedStyle(el);if(!r.width||!r.height||s.visibility==='hidden'||el.closest('details:not([open])')&&!el.closest('summary')||el.closest('svg'))continue;
   const label=el.tagName+'.'+el.className;
   if(r.left<-1||r.right>vw+1)result.push('overflow '+label);
   if([...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&!scale.has(parseFloat(s.fontSize)))result.push('off-scale '+label+' '+s.fontSize);
   if(el.matches('a,button,select,summary,input')&&r.height<32)result.push('tap-target '+label+' '+r.height);
   if(el.scrollWidth>el.clientWidth+1&&s.overflow!=='visible'&&s.textOverflow!=='ellipsis'&&!el.closest('.tablewrap')&&!el.matches('input,select'))result.push('clipped '+label);
  }return [...new Set(result)];
 });
 await page.screenshot({path:join(out,`${scenario}-${width}-${theme}.png`),fullPage:true});
 if(scenario==='populated'&&process.argv.includes('--slots')) {
  await page.getByRole('button',{name:'Розрахувати сценарій'}).click();
  await page.getByLabel('Тривалість, год',{exact:true}).fill('2');
  await page.getByLabel('Частка абонентів, %',{exact:true}).fill('50');
  if(!(await page.locator('.impact-result output').textContent()).replace(/\s/g,'').includes('3430018')) issues.push('calculator arithmetic');
  await page.screenshot({path:join(out,`impact-${width}-${theme}.png`),fullPage:false});
  await page.getByLabel('Тривалість, год',{exact:true}).fill('');
  if(!(await page.locator('.impact-result output').textContent()).includes('Вкажіть')) issues.push('calculator invalid input');
  await page.getByRole('button',{name:'Закрити',exact:true}).click();
  await page.getByRole('button',{name:'Регіони та вишки'}).click();
  await page.locator('dialog[open] .slot-row').first().click();
  await page.locator('dialog[open] .slot-row').first().click();
  await page.getByRole('heading',{name:/Демо · DEMO/}).waitFor();
  await page.screenshot({path:join(out,`network-${width}-${theme}.png`),fullPage:false});
  await page.getByRole('button',{name:'До вишок регіону'}).click();
  await page.getByRole('button',{name:'До регіонів'}).click();
  if(await page.locator('dialog[open] .slot-row').count()!==3)issues.push('network back lost');
  await page.getByRole('button',{name:'Закрити',exact:true}).click();
 }
 if(scenario==='populated'&&process.argv.includes('--flow')) {
  const switched=page.waitForResponse(r=>r.url().includes('/api/dashboard?')&&r.url().includes('window=7d'));
  await page.getByRole('button',{name:'7 днів',exact:true}).click();
  await page.getByText('Збираємо показники').waitFor();
  if(await page.locator('.metric-tile').count())issues.push('previous window remains under new filter');
  await switched;
  const request=page.waitForRequest(r=>r.url().includes('/api/feed?'));
  await page.locator('.metric-tile').first().click();
  const url=new URL((await request).url());
  if(!url.searchParams.has('from')||!url.searchParams.has('until')||url.searchParams.get('decision')!=='visible')issues.push('drilldown slice lost');
  await page.getByRole('heading',{name:'Стрічка',exact:true}).waitFor();
  await page.getByRole('button',{name:'Контекст і доказ'}).click();
  await page.locator('dialog[open]').waitFor();
  await page.screenshot({path:join(out,`evidence-${width}-${theme}.png`),fullPage:false});
  await page.getByRole('button',{name:'Закрити',exact:true}).click();
  await page.goBack();
  await page.getByRole('heading',{name:'Сьогодні',exact:true}).waitFor();
  if(new URL(page.url()).searchParams.get('window')!=='7d')issues.push('back window lost');
 }

 if((scenario==='populated'&&process.argv.includes('--slots'))||scenario==='stale-ai') {
  await page.goto(`http://127.0.0.1:${server.address().port}/sources`);
  await page.getByRole('heading',{name:'AI-аналітик',exact:true}).waitFor();
  if(scenario==='stale-ai'){await page.getByText('Немає свіжого сигналу',{exact:true}).waitFor();if(await page.locator('.badge.success').filter({hasText:'AI працює'}).count())issues.push('stale heartbeat shown active');}
  await page.getByText('Дозволи джерел · 1 увімкнено').click();
  if(!await page.getByRole('switch',{name:'AI: Заблокований RSS',exact:true}).isDisabled())issues.push('blocked source enabled in UI');
  await page.getByRole('switch',{name:'AI: Синтетичний Telegram',exact:true}).click();
  if(!await page.getByRole('button',{name:'Зберегти дозвіл',exact:true}).isDisabled())issues.push('AI basis not required');
  await page.getByRole('button',{name:'Закрити',exact:true}).click();
  if(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1))issues.push('sources overflow');
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:join(out,`sources-${width}-${theme}.png`),fullPage:true});
 }
 if(scenario==='populated'&&process.argv.includes('--tabs')){
  await page.goto(`http://127.0.0.1:${server.address().port}/sources/telegram?tab=workflows`);
  await page.getByRole('heading',{name:'Параметри поточного workflow'}).waitFor();
  const hidden=await page.locator('.tabs').evaluate(el=>{const a=el.getBoundingClientRect(),b=el.querySelector('[aria-pressed="true"]').getBoundingClientRect();return b.left<a.left-1||b.right>a.right+1;});
  if(hidden)issues.push('selected mobile tab offscreen');
  await page.screenshot({path:join(out,`tabs-${width}-${theme}.png`),fullPage:true});
  await page.getByRole('button',{name:'Доступи',exact:true}).click();
  await page.getByText('Строк минув',{exact:true}).waitFor();
  if(await page.getByRole('button',{name:'Відкликати доступ',exact:true}).count())issues.push('expired share has active revoke control');
  if(!(await page.locator('.list-row').textContent()).includes('Канали: Усі · Теми: Мережа й покриття'))issues.push('share scope raw values');
  await page.screenshot({path:join(out,`shares-${width}-${theme}.png`),fullPage:true});
  await page.getByRole('button',{name:'Стан',exact:true}).click();
  await page.getByText('Пошук обговорення',{exact:true}).waitFor();
  await page.screenshot({path:join(out,`operations-${width}-${theme}.png`),fullPage:true});
 }
 if(scenario==='stale-refresh' && !await page.getByRole('button',{name:'Перевірити оновлення',exact:true}).isEnabled())issues.push('stale refresh locks control');
 reports.push({scenario,width,theme,issues:[...issues,...errors]});
 console.log(scenario,width,theme,JSON.stringify([...issues,...errors]));
 await context.close();
}
await browser.close();server.close();await writeFile(join(out,`report-${process.env.UFV_SCENARIO || (process.argv.includes('--states')?'states':process.argv.includes('--slots')?'slots':'base')}.json`),JSON.stringify(reports,null,2));
if(reports.some(r=>r.issues.length)) process.exitCode=1;
