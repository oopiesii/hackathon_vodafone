"""Isolated ufv_checks acceptance: auth, stale evidence, workflow scope and browser."""
import json
import os
from pathlib import Path
import uuid
import httpx
import psycopg
from psycopg.types.json import Jsonb
from playwright.sync_api import sync_playwright,expect

cfg=json.loads(Path(os.environ['UFV_TEST_ENV']).read_text())
assert cfg['DATABASE_URL'].endswith('/ufv_checks')
origin=os.environ.get('UFV_CHECK_ORIGIN','http://127.0.0.1:18198')
assert origin.startswith('http://127.0.0.1:')
client=httpx.Client(base_url=origin,headers={'Origin':origin},timeout=20)
assert client.get('/api/analysis').status_code==401
assert client.post('/api/auth/sign-in/email',json={'email':'admin@ufv.test','password':cfg['ADMIN_PASSWORD']}).status_code==200
tag=uuid.uuid4().hex[:12]
for role in ['viewer','analyst']:
    email=f'analysis-{role}-{tag}@ufv.test'
    password='Synthetic-analysis-checks!'
    assert client.post('/api/auth/admin/create-user',json={'name':'TEST analysis','email':email,'password':password,'role':role}).status_code==200
    other=httpx.Client(base_url=origin,headers={'Origin':origin})
    assert other.post('/api/auth/sign-in/email',json={'email':email,'password':password}).status_code==200
    assert other.get('/api/analysis').status_code==(403 if role=='viewer' else 200)
    other.close()

with psycopg.connect(cfg['DATABASE_URL']) as conn:
    workflow=conn.execute("insert into core.workflows(name) values(%s) returning id",('TEST analysis '+tag,)).fetchone()[0]
    source=conn.execute("insert into core.sources(kind,external_id,workflow_id,enabled) values('rss',%s,%s,false) returning id",('https://analysis.invalid/'+tag,workflow)).fetchone()[0]
    parent=conn.execute("insert into raw.items(source_id,source_item_id,text,content_hash,url) values(%s,'parent','TEST Vodafone outage','test','https://analysis.invalid/parent') returning id",(source,)).fetchone()[0]
    item=conn.execute("insert into raw.items(source_id,source_item_id,text,content_hash,url,kind,parent_item_id) values(%s,'item','TEST same here','test2','https://analysis.invalid/item','comment','parent') returning id",(source,)).fetchone()[0]
    run=str(uuid.uuid4())
    conn.execute("insert into core.analysis_runs(id,workflow_id,cutoff_at,model,prompt_version,scope,status,total,note) values(%s,%s,now(),'TEST','TEST',jsonb_build_object('source_kind','telegram'),'complete',1,'SYNTHETIC only')",(run,workflow))
    label={'decision':'relevant','relevance':'vodafone','topic':'outage','sentiment':'negative','summary':'TEST synthetic example','reason':'TEST',
        'evidence':[{'id':item,'quote':'TEST same here'},{'id':parent,'quote':'TEST Vodafone outage'}], 'context_versions':[{'id':parent,'version':1}], 'aspects':[{'brand':'vodafone','topic':'outage','sentiment':'negative','cause':'TEST service unavailable','evidence':[{'id':item,'quote':'TEST same here'}]}]}
    conn.execute('insert into core.analysis_labels(run_id,raw_item_id,raw_version,label) values(%s,%s,1,%s)',(run,item,Jsonb(label)))
    conn.execute('insert into core.analysis_briefs(run_id,model,brief) values(%s,%s,%s)',(run,'TEST',Jsonb({'findings':[{'text':'TEST contextual finding','evidence_ids':[item]}],'actions':[],'limitations':['TEST sample only']})))
    conn.execute("insert into core.search_briefs(workflow_id,searched_at,query,url,publisher,title,published_on,summary,evidence_quote,topic,verification) values(%s,now(),'TEST','https://analysis.invalid/news','TEST','TEST search result',current_date,'TEST summary','TEST quote','coverage','Synthetic check')",(workflow,))

def get():
    response=client.get('/api/analysis',params={'workflow_id':workflow});assert response.status_code==200,response.text
    return response.json()

try:
    data=get();assert data['counts']['vodafone']==1
    assert data['items'][0]['label']['evidence'][1]['url']=='https://analysis.invalid/parent'
    assert data['comment_sentiments']=={'negative':1}
    assert data['brand_sentiments']==[{'brand':'vodafone','sentiment':'negative','n':1}]
    assert data['brief']['findings'][0]['evidence'][0]['quotes'][1]['url']=='https://analysis.invalid/parent'
    assert client.get('/api/analysis',params={'workflow_id':workflow,'sentiment':'positive'}).json()['items']==[]
    assert client.get('/api/analysis',params={'workflow_id':workflow,'kind':'post'}).json()['items']==[]
    assert client.get('/api/analysis?kind=invalid').status_code==400
    assert all(r['raw_item_id']!=str(item) for r in client.get('/api/analysis?workflow_id=1').json()['items'])
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        context=browser.new_context()
        # Reuse the authenticated test API session; a fourth rapid password login
        # intentionally hits Better Auth's real shared login rate limiter.
        context.add_cookies([{'name':cookie.name,'value':cookie.value,'url':origin}
                            for cookie in client.cookies.jar])
        page=context.new_page();errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(origin+'/analysis')
        expect(page.get_by_role('heading',name='Vodafone: аналіз і пошук',exact=True)).to_be_visible()
        # Wrapped labels include option text in Chromium's accessible name.
        page.get_by_label('Workflow',exact=False).select_option(str(workflow))
        expect(page.get_by_text('TEST contextual finding',exact=True)).to_be_visible()
        page.get_by_text('Переглянути матеріали пошуку (1)',exact=True).click()
        expect(page.get_by_text('TEST search result',exact=False)).to_be_visible()
        for width in [320,768,1024,1440]:
            page.set_viewport_size({'width':width,'height':1000})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,'overflow')
        page.screenshot(path='/tmp/ufv-analysis-check.png',full_page=True)
        page.get_by_role('button',name='Темна тема',exact=True).click()
        for width in [320,768,1024,1440]:
            page.set_viewport_size({'width':width,'height':1000})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,'dark overflow')
        page.get_by_label('Показати результати',exact=False).select_option('competitor')
        expect(page.get_by_text('За цим фільтром згадок немає',exact=True)).to_be_visible()
        assert not errors,errors
        browser.close()
    with psycopg.connect(cfg['DATABASE_URL']) as conn:
        conn.execute('update raw.items set version=version+1 where id=%s',(parent,))
    data=get();assert data['stale']==1 and data['items']==[] and data['counts']=={} and data['brief'] is None and data['brief_stale']
    with psycopg.connect(cfg['DATABASE_URL']) as conn:
        conn.execute('update raw.items set version=1,deleted=true where id=%s',(parent,))
    assert get()['stale']==1
    with psycopg.connect(cfg['DATABASE_URL']) as conn:
        conn.execute('update raw.items set version=1,deleted=false where id=%s',(parent,))
        conn.execute("update core.analysis_runs set scope=scope||jsonb_build_object('test_source_ids',jsonb_build_array(%s::bigint)) where id=%s",(source,run))
    data=get();assert data['test_records']==1 and data['counts']=={} and data['items'][0]['is_test']
    assert data['brief'] is None and data['comment_sentiments']=={}
    with psycopg.connect(cfg['DATABASE_URL']) as conn:
        conn.execute("update core.analysis_runs set scope=scope-'test_source_ids' where id=%s",(run,))
        for index in range(60):
            extra=conn.execute("insert into raw.items(source_id,source_item_id,text,content_hash,url) values(%s,%s,'TEST competitor','TEST',%s) returning id",(source,'extra-'+str(index),'https://analysis.invalid/extra-'+str(index))).fetchone()[0]
            extra_label={'decision':'relevant','relevance':'competitor','topic':'tariff','sentiment':'neutral','summary':'TEST competitor','reason':'TEST','evidence':[{'id':extra,'quote':'TEST competitor'}],'context_versions':[],'aspects':[]}
            conn.execute('insert into core.analysis_labels(run_id,raw_item_id,raw_version,label) values(%s,%s,1,%s)',(run,extra,Jsonb(extra_label)))
    data=get();assert data['total_matching']==61 and len(data['items'])==50
    assert len(client.get('/api/analysis',params={'workflow_id':workflow,'offset':50}).json()['items'])==11
    data=client.get('/api/analysis',params={'workflow_id':workflow,'relevance':'vodafone','kind':'comment','sentiment':'negative'}).json()
    assert data['total_matching']==1 and data['items'][0]['raw_item_id']==str(item)
    with psycopg.connect(cfg['DATABASE_URL']) as conn:
        conn.execute("update core.analysis_labels set label=jsonb_set(label,'{context_versions}','[]')||jsonb_build_object('missing_parent_key','late') where run_id=%s and raw_item_id=%s",(run,item))
    assert get()['counts']['vodafone']==1
    with psycopg.connect(cfg['DATABASE_URL']) as conn:
        conn.execute("insert into raw.items(source_id,source_item_id,text,content_hash) values(%s,'late','TEST recovered context','test')",(source,))
    assert get()['counts'].get('vodafone',0)==0
    print('PASS: 401/403, admin/analyst, workflow scope, verified evidence URLs, stale/deleted context exclusion, Chromium 320/768/1024/1440, filters, no JS errors.')
finally:
    with psycopg.connect(cfg['DATABASE_URL']) as conn:
        conn.execute('delete from core.analysis_briefs where run_id=%s',(run,))
        conn.execute('delete from core.analysis_labels where run_id=%s',(run,))
        conn.execute('delete from core.analysis_runs where id=%s',(run,))
        conn.execute('delete from core.search_briefs where workflow_id=%s',(workflow,))
        conn.execute('delete from raw.items where source_id=%s',(source,))
        conn.execute('delete from core.sources where id=%s',(source,))
        conn.execute('delete from core.workflows where id=%s',(workflow,))
    client.close()
