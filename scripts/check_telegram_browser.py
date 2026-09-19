"""Run against the isolated UFV_TEST_ENV after integration tests; no Telegram RPCs.

Requires Playwright and Chromium. Screenshots go to ignored artifacts/.
"""
import json
import atexit
import os
from pathlib import Path
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'services'))
from pipeline.db import DB
from pipeline.raw import save_item
from pipeline.metrics import save_snapshot
from pipeline.processor import process

cfg=json.loads(Path(os.environ['UFV_TEST_ENV']).read_text())
assert cfg['DATABASE_URL'].endswith('/ufv_checks')
db=DB(cfg['DATABASE_URL'])
atexit.register(db.pool.close)
db.execute('truncate auth."rateLimit"')
db.execute("update core.modules set enabled=false where name='telegram'")
source=db.one('select s.*,r.peer_id from core.sources s join raw.source_state r on r.source_id=s.id order by s.id limit 1')
message=SimpleNamespace(id=int(datetime.now(timezone.utc).timestamp()),message='ТЕСТ: Vodafone — збій інтернету. Синтетична перевірка інтерфейсу.',
    date=datetime.now(timezone.utc),views=10,replies=SimpleNamespace(replies=2),reactions=None)
ident=save_item(db,source,message,source['peer_id'])
save_snapshot(db,ident,message,datetime.now(timezone.utc)-timedelta(minutes=5),force=True)
message.views=35
save_snapshot(db,ident,message,force=True)
process(db,ident)
output=Path('artifacts/telegram-browser');output.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':1000})
    page.goto(cfg['PUBLIC_URL'])
    page.get_by_label('Пошта',exact=True).fill('admin@ufv.test')
    page.get_by_label('Пароль',exact=True).fill(cfg['ADMIN_PASSWORD'])
    page.get_by_role('button',name='Увійти',exact=True).click()
    expect(page.get_by_role('heading',level=1)).to_be_visible()
    errors=[];failures=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('console',lambda e:errors.append(e.text) if e.type in ('warning','error') else None)
    page.on('response',lambda r:failures.append(f'{r.status} {r.url.split("?")[0]}') if r.status>=400 else None)
    paths=['/sources','/sources/telegram?tab=bulk','/sources/telegram?tab=watch','/sources/telegram?tab=channels','/inbox','/']
    for width in [1440,768,320]:
        page.set_viewport_size({'width':width,'height':1000})
        for index,path in enumerate(paths):
            page.goto(cfg['PUBLIC_URL']+path)
            expect(page.get_by_role('heading',level=1)).to_be_visible()
            page.wait_for_timeout(250)
            assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),f'Overflow {width} {path}'
            page.screenshot(path=str(output/f'{width}-{index}.png'),full_page=True)
    page.set_viewport_size({'width':1440,'height':1000})
    page.goto(cfg['PUBLIC_URL']+'/sources/telegram?tab=bulk')
    page.get_by_label('Джерела: @username або t.me-посилання').fill('@synthetic_group\nhttps://t.me/synthetic_group\nhttps://t.me/+private')
    page.get_by_role('button',name='Перевірити список',exact=True).click()
    expect(page.get_by_text('Повтор у списку',exact=True)).to_be_visible()
    page.set_viewport_size({'width':320,'height':1000})
    assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),'Bulk preview overflow'
    page.screenshot(path=str(output/'bulk-preview-320.png'),full_page=True)
    page.set_viewport_size({'width':1440,'height':1000})
    page.get_by_label('Підстава використання матеріалів').fill('Синтетична перевірка, без звернень до Telegram')
    page.get_by_role('button',name='Перевірити доступ у Telegram',exact=True).click()
    expect(page.get_by_text('У черзі',exact=True)).to_be_visible()
    page.get_by_role('button',name='Пауза',exact=True).click()
    expect(page.get_by_text('Призупинено',exact=True)).to_be_visible()
    page.get_by_role('button',name='Продовжити',exact=True).click()
    expect(page.get_by_text('У черзі',exact=True)).to_be_visible()
    page.goto(cfg['PUBLIC_URL']+'/sources/telegram?tab=watch')
    page.get_by_role('button',name='Зберегти стеження',exact=True).click()
    expect(page.get_by_text('Збережено.',exact=True)).to_be_visible()
    page.get_by_role('button',name='Стежити далі',exact=True).first.click()
    expect(page.get_by_text('Закріплено',exact=True).first).to_be_visible()
    page.goto(cfg['PUBLIC_URL']+'/inbox')
    page.get_by_role('button',name='Повний текст і контекст',exact=True).first.click()
    expect(page.get_by_role('dialog')).to_be_visible()
    expect(page.get_by_text('Динаміка Telegram',exact=True)).to_be_visible()
    expect(page.get_by_text('Зміна переглядів між двома останніми знімками: 25.',exact=False)).to_be_visible()
    for width in [1440,320]:
        page.set_viewport_size({'width':width,'height':1000})
        page.screenshot(path=str(output/f'dialog-{width}.png'),full_page=True)
        assert page.get_by_role('dialog').evaluate('(el)=>el.scrollWidth<=el.clientWidth'),f'Dialog overflow at {width}'
    page.get_by_role('button',name='Закрити',exact=True).click()
    page.set_viewport_size({'width':1440,'height':1000})
    page.get_by_role('button',name='Темна тема',exact=True).click()
    for width in [1440,320]:
        page.set_viewport_size({'width':width,'height':1000})
        for index,path in enumerate(['/sources/telegram?tab=bulk','/sources/telegram?tab=watch','/inbox']):
            page.goto(cfg['PUBLIC_URL']+path)
            expect(page.get_by_role('heading',level=1)).to_be_visible()
            page.wait_for_timeout(200)
            assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),f'Dark overflow {width} {path}'
            page.screenshot(path=str(output/f'dark-{width}-{index}.png'),full_page=True)
    assert not errors,errors
    assert not failures,failures
    browser.close()
db.pool.close()
print('PASS: 24 responsive light/dark pages; bulk preview/queue/pause/resume; policy/pin; metrics dialog; no console/network errors.')
