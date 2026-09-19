"""Dashboard integration gates. Uses only the guarded ufv_checks fixture."""
from datetime import datetime, timedelta, timezone
import json
import uuid
from urllib.parse import urlsplit

import httpx
import pytest
from test_runtime import runtime, prepared, msg
from pipeline.raw import save_item
from pipeline.processor import process


def post(db, source, number, text, *, ago=30, views=None, reactions=None):
    message=msg(number,text)
    message.date=datetime.now(timezone.utc)-timedelta(minutes=ago)
    ident=save_item(db,source,message,-100100)
    process(db,ident)
    if views is not None or reactions is not None:
        db.execute('insert into raw.metric_snapshots(item_id,views,reactions) values(%s,%s,%s)',
                   (ident,views,json.dumps(reactions)))
    return db.one('select id from core.mentions where raw_item_id=%s',(ident,))['id']


def role_client(admin,cfg,role):
    email=f'{role}-{uuid.uuid4().hex[:12]}@ufv.test'
    password='Synthetic-dashboard-password!'
    result=admin.post('/api/auth/admin/create-user',json={'name':'Synthetic dashboard role','email':email,'password':password,'role':role})
    assert result.status_code==200,result.text
    client=httpx.Client(base_url=cfg['PUBLIC_URL'],headers={'Origin':cfg['PUBLIC_URL']})
    assert client.post('/api/auth/sign-in/email',json={'email':email,'password':password}).status_code==200
    return client


def test_dashboard_metrics_roles_and_drilldown(prepared):
    db,admin,cfg,s,_=prepared
    post(db,s,10,'Vodafone не працює інтернет',views=120,reactions={'👎':2,'🤣':1,'😢':5,'👍':2})
    post(db,s,11,'Vodafone відновив інтернет',views=50,reactions={'😡':1,'💔':2,'❤':7})
    post(db,s,12,'Vodafone інтернет доступний',views=30,reactions={'😁':2,'😭':1,'🔥':7})
    post(db,s,13,'Казино Vodafone бонус')
    post(db,s,14,'Купуй Vodafone інтернет')
    analyst=role_client(admin,cfg,'analyst');viewer=role_client(admin,cfg,'viewer')
    with httpx.Client(base_url=cfg['PUBLIC_URL']) as anonymous:
        assert anonymous.get('/api/dashboard').status_code==401
    try:
        a=admin.get('/api/dashboard').json()
        assert a['metrics']['mentions']['value']==4,a
        assert a['metrics']['noise']['value']==1
        assert a['reactions']['total']==30
        assert a['reactions']['negative']==3 and a['reactions']['ironic']==3 and a['reactions']['sad']==8
        assert a['metrics']['negative_share']['value']==20
        assert a['metrics']['negative_reach']['value']==120
        assert 1790<a['metrics']['collection_lag']['value']<1810
        assert analyst.get('/api/dashboard').json()['metrics']['mentions']['value']==4
        v=viewer.get('/api/dashboard?decision=all').json()
        assert v['metrics']['mentions']['value']==3
        assert 'noise' not in v['metrics']
        assert set(v['counts'])=={'accepted'}
        assert 'Казино' not in json.dumps(v,ensure_ascii=False)
        for key in ['mentions','negative_reach','negative_share','noise','collection_lag']:
            metric=a['metrics'][key]
            r=admin.get('/api'+metric['href'])
            assert r.status_code==200,(key,r.text)
            if key=='mentions':assert r.json()['total']['count']==4
            if key=='negative_reach':assert len(r.json()['items'])==1
            if key=='noise':assert len(r.json()['items'])==1
        assert admin.get('/api/dashboard?workflow_id=1%20OR%20TRUE').status_code==400
        assert admin.get('/api/dashboard?window=all').status_code==400
        assert admin.get('/api/dashboard?workflow_id=999999').status_code==404
        assert admin.get('/api/feed?window=24h&from=broken').status_code==400
    finally:
        analyst.close();viewer.close()


def test_dashboard_manual_current_version_scope_and_rollups(prepared):
    db,admin,cfg,s,_=prepared
    mid=post(db,s,10,'Vodafone не працює інтернет',views=100,reactions={'👎':1,'👍':3})
    other=db.one("insert into core.workflows(name) values('Other synthetic workflow') returning id")['id']
    sid=db.one("insert into core.sources(kind,external_id,workflow_id,permission_note) values('rss','https://example.test/isolated',%s,'Synthetic tests only') returning id",(other,))['id']
    other_source={**s,'id':sid,'workflow_id':other}
    post(db,other_source,11,'Vodafone інтернет інший workflow',views=900,reactions={'👎':500})
    # A same-version human override survives the API's intentional workflow invalidation.
    assert admin.post(f'/api/admin/documents/{mid}/review',json={'decision':'accepted'}).status_code==200
    assert admin.get('/api/dashboard').json()['metrics']['mentions']['value']==1
    db.execute('select core.refresh_dashboard_rollups()')
    # Month succeeds without permission to read the raw dashboard view at all.
    db.execute('revoke select on core.dashboard_items from ufv_api')
    try:
        response=admin.get('/api/dashboard?window=30d')
        assert response.status_code==200,response.text
        month=response.json()
        assert month['aggregated'] and month['metrics']['mentions']['value']==1
        assert month['reactions']['total']==4
        assert month['signals']==[] and month['growth']==[]
    finally:
        db.execute('grant select on core.dashboard_items to ufv_api')
    assert admin.post(f'/api/admin/documents/{mid}/review',json={'decision':'rejected'}).status_code==200
    assert admin.get('/api/dashboard').json()['metrics']['mentions']['value']==0
    viewer=role_client(admin,cfg,'viewer')
    try:
        assert viewer.get('/api/dashboard').json()['metrics']['mentions']['value']==0
        pending=viewer.get('/api/dashboard?window=30d').json()
        assert pending['metrics']['mentions']['value'] is None
        assert pending['aggregation']['complete'] is False
        assert 'dirty_sources' not in pending['aggregation']
        db.execute('select core.refresh_dashboard_rollups()')
        complete=viewer.get('/api/dashboard?window=30d').json()
        assert complete['metrics']['mentions']['value']==0
        assert complete['aggregation']['complete'] is True
        # A new raw version invalidates that decision. No stale text/counters in viewer response.
        row=db.one('select raw_item_id from core.mentions where id=%s',(mid,))
        unrelated_generation=db.one('select generated_at from core.dashboard_rollup_state where source_id=%s',(sid,))['generated_at']
        db.execute('update raw.items set version=version+1 where id=%s',(row['raw_item_id'],))
        assert db.one('select dirty from core.dashboard_rollup_state where source_id=%s',(s['id'],))['dirty'] is True
        db.execute('select core.refresh_dashboard_rollups()')
        assert db.one('select generated_at from core.dashboard_rollup_state where source_id=%s',(sid,))['generated_at']==unrelated_generation
        v=viewer.get('/api/dashboard').json()
        assert v['metrics']['mentions']['value']==0
        assert not v['sources']
    finally:viewer.close()


def test_dashboard_watch_latency_unknown_dates_and_spread(prepared):
    db,admin,cfg,s,_=prepared
    text='Vodafone не працює інтернет. '+'Повідомлення про доступність послуги у відкритому тесті. '*3
    ids=[post(db,s,10+n,text,ago=90-n*15,views=100) for n in range(4)]
    first_raw=db.one('select raw_item_id from core.mentions where id=%s',(ids[0],))['raw_item_id']
    db.execute("insert into raw.metric_snapshots(item_id,observed_at,views) select id,published_at+interval '10 minutes',10 from raw.items where id=%s",(first_raw,))
    db.execute("insert into raw.metric_snapshots(item_id,observed_at,views) select id,published_at+interval '40 minutes',70 from raw.items where id=%s",(first_raw,))
    c=msg(99,'Vodafone інтернет не працює');c.date=datetime.now(timezone.utc)-timedelta(minutes=20)
    comment=save_item(db,s,c,-100200,'comment',10,50);process(db,comment)
    db.execute("update raw.watch_state set state='paused' where item_id=%s",(first_raw,))
    r=admin.get('/api/dashboard').json()
    assert r['complaints']['count']==0
    db.execute("insert into raw.watch_state(item_id,state) values(%s,'active') on conflict(item_id) do update set state='active'",(first_raw,))
    r=admin.get('/api/dashboard').json()
    assert r['complaints']['count']==1
    assert r['spread'][0]['count']==3
    assert abs(r['spread'][0]['third_repost_seconds']-2700)<2
    assert r['growth'] and r['growth'][0]['views_per_hour']>0
    assert len(admin.get('/api'+r['spread'][0]['href']).json()['items'])==4
    # Missing dates are visible in the count but excluded from measured latency.
    db.execute('update raw.items set published_at=null where id=%s',(comment,))
    data=admin.get('/api/dashboard').json()
    assert data['metrics']['mentions']['value']==5
    assert data['metrics']['collection_lag']['measured']==4
