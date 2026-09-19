"""Browser verification on ufv_checks; never connects a Telegram account."""
import json,os,sys,atexit
from pathlib import Path
import psycopg
from playwright.sync_api import sync_playwright,expect
from seed_rss import seed
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'services'))
from pipeline.rss_fetch import parse,Response
from pipeline.rss import claim,commit_poll
from pipeline.processor import process
from pipeline.db import DB
cfg=json.loads(Path(os.environ['UFV_TEST_ENV']).read_text());assert cfg['DATABASE_URL'].endswith('/ufv_checks')
with psycopg.connect(cfg['DATABASE_URL']) as conn:seed(conn,False)
db=DB(cfg['DATABASE_URL']);atexit.register(db.pool.close);db.execute('truncate auth."rateLimit"')
# Explicit synthetic feed fixture; HTTP fetching is never started in these UI tests.
db.execute("update core.modules set enabled=true where name='rss'")
db.execute('update core.workflows set enabled=true')
out=Path('artifacts/rss-browser');out.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1440,'height':1000});errors=[];bad=[]
 page.on('pageerror',lambda error:errors.append(str(error)))
 page.on('response',lambda response:bad.append((response.status,response.url)) if '/api/' in response.url and response.status>=400 else None)
 page.goto(cfg['PUBLIC_URL']);page.get_by_label('Пошта',exact=True).fill('admin@ufv.test');page.get_by_label('Пароль',exact=True).fill(cfg['ADMIN_PASSWORD']);page.get_by_role('button',name='Увійти',exact=True).click()
 page.wait_for_url(cfg['PUBLIC_URL']+'/')
 for theme in ['light','dark']:
  for width in [320,768,1024,1440]:
   page.set_viewport_size({'width':width,'height':1000});page.goto(cfg['PUBLIC_URL']+'/sources/rss');page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
   expect(page.get_by_role('heading',name='RSS-джерела',exact=True)).to_be_visible()
   expect(page.get_by_role('switch',name='Збір Укрінформ — Технології',exact=True)).to_be_visible()
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(theme,width,'overflow')
   expect(page.get_by_role('switch',name='Збір ITC',exact=True)).to_be_disabled()
   page.screenshot(path=str(out/f'{theme}-{width}.png'))
 toggle=page.get_by_role('switch',name='Збір RSS',exact=True);toggle.click();expect(toggle).to_have_attribute('aria-checked','false');toggle.click();expect(toggle).to_have_attribute('aria-checked','true')
 source=page.get_by_role('switch',name='Збір Укрінформ — Технології',exact=True);source.click();expect(source).to_have_attribute('aria-checked','true');source.click();expect(source).to_have_attribute('aria-checked','false')
 page.get_by_label('RSS / Atom URL',exact=True).fill('https://rss-fixture.example.org/feed')
 page.get_by_label('Посилання на умови використання',exact=True).fill('https://rss-fixture.example.org/terms')
 page.get_by_label('Підстава для регулярного збору й показу анонсів',exact=False).fill('SYNTHETIC browser fixture, no real publisher, no network request')
 page.get_by_role('button',name='Додати та ввімкнути',exact=True).click();expect(page.get_by_text('Додано: 1. Уже існували: 0.',exact=True)).to_be_visible()
 source=claim(db);assert source
 data=b'<?xml version="1.0"?><rss version="2.0"><channel><title>TEST</title><link>https://rss-fixture.example.org</link><description>TEST</description><item><title>TEST Vodafone internet outage</title><link>https://rss-fixture.example.org/1</link><description>Synthetic verification only</description></item></channel></rss>'
 commit_poll(db,source,Response(200,data,source['external_id'],None,None),*parse(data,source['external_id']))
 ident=db.one('select id from raw.items where source_id=%s',(source['id'],))['id'];process(db,ident)
 page.goto(cfg['PUBLIC_URL']+'/inbox');expect(page.get_by_text('RSS-анонс',exact=True).first).to_be_visible();page.get_by_role('button',name='Анонс і джерело',exact=True).first.click();expect(page.get_by_text('Заголовок і анонс RSS; повний текст не отримано.',exact=True)).to_be_visible()
 page.goto(cfg['PUBLIC_URL']+'/');expect(page.get_by_text('RSS-анонс',exact=True).first).to_be_visible()
 assert not errors,errors;assert not bad,bad
 browser.close()
db.pool.close();print('PASS: RSS at 320/768/1024/1440 light/dark; module/source toggles; blocked rights; bulk add; inbox and feed; no JS/HTTP errors.')
