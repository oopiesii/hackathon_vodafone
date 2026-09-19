"""Regression acceptance in a private workflow of ufv_checks; never reset other fixtures."""
import json
import os
from pathlib import Path
import uuid
import httpx
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from playwright.sync_api import sync_playwright, expect

cfg=json.loads(Path(os.environ.get('UFV_TEST_ENV','/tmp/ufv-rss-checks-env.json')).read_text())
assert cfg['DATABASE_URL'].endswith('/ufv_checks')
origin=os.environ.get('UFV_CHECK_ORIGIN','http://127.0.0.1:18198')
assert origin.startswith('http://127.0.0.1:')
client=httpx.Client(base_url=origin,headers={'Origin':origin},timeout=30)
assert client.post('/api/auth/sign-in/email',json={'email':'admin@ufv.test','password':cfg['ADMIN_PASSWORD']}).status_code==200
tag=uuid.uuid4().hex[:10]
db=psycopg.connect(cfg['DATABASE_URL'],row_factory=dict_row,autocommit=True)
workflow=db.execute("insert into core.workflows(name,enabled) values(%s,true) returning id",('TEST curated '+tag,)).fetchone()['id']
source=db.execute("insert into core.sources(kind,external_id,title,workflow_id,enabled) values('telegram',%s,'TEST curated source',%s,true) returning id",('test_curated_'+tag,workflow)).fetchone()['id']
run=str(uuid.uuid4())
db.execute("insert into core.analysis_runs(id,workflow_id,cutoff_at,model,prompt_version,scope,status,total,note) values(%s,%s,now(),'TEST','TEST',%s,'complete',0,'SYNTHETIC only')",(run,workflow,Jsonb({'source_ids':[source],'source_kind':'telegram'})))
raw_ids=[];mention_ids=[];users=[];shares=[]

def item(text, decision='relevant', ago=1, brand='vodafone', sentiment='negative', context=None, kind='post'):
    raw=db.execute("insert into raw.items(source_id,source_item_id,url,text,content_hash,published_at,kind) values(%s,%s,%s,%s,%s,now()-%s*interval '1 hour',%s) returning id",
        (source,str(len(raw_ids)),f'https://example.invalid/{tag}/{len(raw_ids)}',text,uuid.uuid4().hex,ago,kind)).fetchone()['id']
    raw_ids.append(raw)
    mid=db.execute("insert into core.mentions(raw_item_id,source_id,url,quote,summary,category,brand,decision,kind,published_at,fetched_at) select id,source_id,url,text,'old dictionary','support','telecom','accepted',kind,published_at,fetched_at from raw.items where id=%s returning id",(raw,)).fetchone()['id']
    mention_ids.append(mid)
    db.execute("insert into core.processing_receipts(raw_item_id,version,processor_revision) values(%s,1,1)",(raw,))
    db.execute("insert into raw.metric_snapshots(item_id,reactions,views) values(%s,'{\"👎\":8,\"🤣\":1,\"👍\":1}',100)",(raw,))
    if decision is not None:
        label={'decision':decision,'relevance':brand if brand=='vodafone' else 'competitor','brands':[brand], 'topic':'outage', 'sentiment':sentiment,
          'summary':'TEST semantic summary','reason':'TEST semantic reason','evidence':[{'id':raw,'quote':text}], 'context_versions':context or [],'aspects':[]}
        db.execute('insert into core.analysis_labels(run_id,raw_item_id,raw_version,label) values(%s,%s,1,%s)',(run,raw,Jsonb(label)))
    return raw,mid

def get(path):
    r=client.get(path);assert r.status_code==200,(path,r.status_code,r.text[:500]);return r.json()

def dashboard(window='24h', *, refresh=True):
    # Publish only our private source; other suites' generations are untouched.
    if window=='30d' and refresh:
        db.execute('select core.refresh_dashboard_rollups(%s)',(source,))
    return get(f'/api/dashboard?workflow_id={workflow}&window={window}')

try:
    trump,tm=item('TEST Trump political news','unrelated')
    pending,pm=item('TEST Trump network mention without semantic label',None)
    vf,vm=item('TEST Vodafone restoring stations',ago=48,sentiment='positive')
    # Model relevance must win over the old dictionary rejecting the same text.
    db.execute("update core.mentions set decision='rejected' where id=%s",(vm,))
    for n in range(3):item(f'TEST Kyivstar service outage {n}',brand='kyivstar')
    a=dashboard()
    assert a['metrics']['mentions']['value']==3,a
    assert a['vodafone_7d']['count']==1
    assert a['counts']['pending']==1 and a['counts']['rejected']==1
    assert a['metrics']['negative_share']['value']==80
    assert a['reactions']['ironic']==3
    assert a['metrics']['negative_share']['attention']==3
    assert a['reaction_freshness']['active_seconds']==300
    assert dashboard('7d')['metrics']['mentions']['value']==4
    partial=dashboard('30d',refresh=False)
    assert not partial['aggregation']['complete']
    assert all(m['value'] is None for m in partial['metrics'].values())
    assert 'vodafone_7d' not in partial
    assert dashboard('30d')['metrics']['mentions']['value']==4
    assert len(get('/api'+a['metrics']['mentions']['href'])['items'])==3
    for src in a['sources']:
        rows=get('/api'+src['href']);assert rows['total']['count']==src['count']
        assert all('Trump' not in i['text'] for i in rows['items'])
    vfrows=get('/api'+a['vodafone_7d']['href'])['items']
    assert len(vfrows)==1 and vfrows[0]['id']==str(vm) and vfrows[0]['classifier']=='semantic'
    assert vfrows[0]['evidence_quote']=='TEST Vodafone restoring stations'
    assert get(f'/api/feed?workflow_id={workflow}&decision=rejected')['items'][0]['id']==str(tm)
    assert get(f'/api/feed?workflow_id={workflow}&decision=pending')['items'][0]['id']==str(pm)
    # Viewer and shares see accepted results, never pending/rejected through a query parameter.
    email=f'curated-viewer-{tag}@ufv.test';password='Synthetic-curated-checks!'
    r=client.post('/api/auth/admin/create-user',json={'name':'TEST curated viewer','email':email,'password':password,'role':'viewer'});assert r.status_code==200
    users.append(r.json()['user']['id'])
    viewer=httpx.Client(base_url=origin,headers={'Origin':origin},timeout=30)
    assert viewer.post('/api/auth/sign-in/email',json={'email':email,'password':password}).status_code==200
    v=viewer.get(f'/api/dashboard?workflow_id={workflow}').json()
    assert 'noise' not in v['metrics'] and 'pending' not in v['analysis_coverage']
    assert viewer.get(f'/api/documents/{tm}').status_code==404
    assert viewer.get(f'/api/feed?workflow_id={workflow}&decision=all').json()['total']['count']==4
    other=httpx.Client(base_url=origin,headers={'Origin':origin},timeout=30)
    share=client.post('/api/admin/shares',json={'workflow_id':workflow,'name':'TEST curated','scope':'posts','channel_ids':[source]}).json();shares.append(share['id'])
    redeemed=other.post('/api/shared/redeem',json={'token':share['url'].split('#')[1]})
    assert redeemed.status_code==200
    other.headers['x-ufv-share-scope']=redeemed.json()['scope_id']
    assert other.get(f'/api/shared/feed?workflow_id={workflow}').json()['total']['count']==4
    assert other.get('/api/shared/feed?workflow_id=1').status_code==403
    # Browser uses real isolated API data, no injected production fixtures.
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        context=browser.new_context();context.add_cookies([{'name':c.name,'value':c.value,'url':origin} for c in client.cookies.jar])
        page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(origin+f'/?workflow_id={workflow}');expect(page.get_by_text('Висока увага',exact=True)).to_be_visible()
        expect(page.locator('.metric-attention-3')).to_have_count(1)
        page.get_by_text('Коли й звідки ці реакції',exact=True).click()
        expect(page.get_by_text('План: активні пости',exact=False)).to_be_visible()
        for theme in ['light','dark']:
            if theme=='dark':
                page.set_viewport_size({'width':1440,'height':1000})
                page.get_by_role('button',name='Темна тема',exact=True).click()
            for width in [1440,768,390,320]:
                page.set_viewport_size({'width':width,'height':1000});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(theme,width)
            page.screenshot(path=f'/tmp/ufv-curated-{theme}.png',full_page=True)
        page.get_by_role('link',name='Vodafone: згадки за 7 днів',exact=False).click()
        expect(page.get_by_text('TEST semantic summary',exact=False)).to_be_visible()
        page.get_by_role('button',name='Контекст і доказ',exact=True).click()
        expect(page.get_by_role('dialog')).to_be_visible()
        assert not errors,errors
        browser.close()
    # Exact-version manual override wins, then a content edit invalidates it.
    db.execute("insert into core.review_decisions(mention_id,raw_version,decision,reviewed_by) values(%s,1,'accepted','TEST')",(tm,))
    assert dashboard()['metrics']['mentions']['value']==4
    db.execute('update raw.items set version=version+1 where id=%s',(trump,))
    assert dashboard()['metrics']['mentions']['value']==3
    # Context edits invalidate both short and monthly views immediately.
    child,cm=item('TEST contextual reference',context=[{'id':vf,'version':1}])
    assert dashboard()['metrics']['mentions']['value']==4
    db.execute('update raw.items set version=version+1 where id=%s',(vf,))
    assert dashboard()['metrics']['mentions']['value']==3
    assert dashboard('30d',refresh=False)['metrics']['mentions']['value'] is None
    assert dashboard('30d')['metrics']['mentions']['value']==3
    # New parent context invalidates a classification that previously lacked it.
    missing,mm=item('TEST missing context')
    db.execute("update core.analysis_labels set label=jsonb_set(label,'{missing_parent_key}','\"late-parent\"') where raw_item_id=%s",(missing,))
    assert dashboard()['metrics']['mentions']['value']==4
    late,lm=item('TEST late parent','unrelated')
    db.execute("update raw.items set source_item_id='late-parent' where id=%s",(late,))
    assert dashboard()['metrics']['mentions']['value']==3
    db.execute('update core.analysis_runs set scope=%s where id=%s',(Jsonb({'source_ids':[source],'source_kind':'telegram','test_source_ids':[source]}),run))
    assert dashboard('30d')['metrics']['mentions']['value']==0
    print('PASS: semantic gating, political-noise exclusion, Vodafone 7d, metric drilldowns, reactions, roles/shares, stale context, manual decisions, monthly data, responsive browser.')
    viewer.close();other.close()
finally:
    # Only this private workflow, never TRUNCATE shared test tables.
    for sid in shares:
        db.execute('delete from auth.share_sessions where share_id=%s',(sid,));db.execute('delete from auth.share_links where id=%s',(sid,))
    for uid in users:db.execute('delete from auth."user" where id=%s',(uid,))
    db.execute('delete from core.analysis_labels where run_id=%s',(run,));db.execute('delete from core.analysis_runs where id=%s',(run,))
    db.execute('delete from core.review_decisions where mention_id=any(%s)',(mention_ids,))
    db.execute('delete from core.processing_receipts where raw_item_id=any(%s)',(raw_ids,))
    db.execute('delete from core.mentions where id=any(%s)',(mention_ids,))
    db.execute('delete from raw.metric_snapshots where item_id=any(%s)',(raw_ids,))
    db.execute('delete from raw.items where id=any(%s)',(raw_ids,))
    db.execute('delete from core.daily_rollups where source_id=%s',(source,))
    db.execute('delete from core.sources where id=%s',(source,));db.execute('delete from core.workflows where id=%s',(workflow,))
    db.close();client.close()
