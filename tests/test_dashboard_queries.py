"""Dashboard query regressions: current semantic decisions, exact scope and metric boundaries."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re

import psycopg
from psycopg.rows import dict_row

from test_runtime import runtime, prepared
from test_dashboard import role_client
from test_curated_rollups import item, label, run, source, workflow


def sql_query(name):
    text=(Path(__file__).resolve().parents[1]/'apps/api/src/lib/dashboard-queries.ts').read_text()
    query=re.search(r'export const '+name+r' = `([^`]+)`;',text).group(1)
    return re.sub(r'\$(\d+)',r'%(p\1)s',query)


def execute_query(sql,name,args):
    with sql.transaction():
        sql.execute('set local role ufv_api')
        return sql.execute(sql_query(name),{f'p{i+1}':arg for i,arg in enumerate(args)}).fetchall()


def test_operator_counts_effective_decisions_windows_and_roles(prepared):
    _,admin,cfg,s,_=prepared
    assert cfg['DATABASE_URL'].endswith('/ufv_checks')
    with psycopg.connect(cfg['DATABASE_URL'],autocommit=True,row_factory=dict_row) as sql:
        anchor=datetime.now(timezone.utc)-timedelta(hours=1)
        rss=source(sql,1,'rss')
        runs={s['id']:run(sql,1,[s['id']]),rss:run(sql,1,[rss],kind='rss')}
        def add(key,decision=None,sid=s['id'],at=anchor):
            raw,mention=item(sql,sid,key)
            sql.execute('update raw.items set published_at=%s,fetched_at=%s where id=%s',(at,at+timedelta(minutes=10),raw))
            if decision:label(sql,runs[sid],raw,decision)
            return raw,mention
        add('accepted','relevant');add('rejected','unrelated');add('review','review');add('pending')
        stale,_=add('stale','relevant')
        sql.execute('update raw.items set version=2 where id=%s',(stale,))
        parent,_=add('parent',at=anchor-timedelta(days=10))
        child,_=add('child')
        label(sql,runs[s['id']],child,parents=[{'id':parent,'version':1}])
        sql.execute('update raw.items set version=2 where id=%s',(parent,))
        deleted,_=add('deleted','relevant')
        sql.execute('update raw.items set deleted=true where id=%s',(deleted,))
        for key,ai,human in [('human-accepted','unrelated','accepted'),('human-rejected','relevant','rejected'),('old-human','unrelated','accepted')]:
            raw,mention=add(key,ai)
            sql.execute("insert into core.review_decisions values(%s,%s,1,'synthetic',now())",(mention,human))
            if key=='old-human':sql.execute('update raw.items set version=2 where id=%s',(raw,))
        undated,_=add('undated','relevant')
        sql.execute('update raw.items set published_at=null where id=%s',(undated,))
        invalid_lag,_=add('invalid-lag','relevant')
        sql.execute("update raw.items set fetched_at=published_at-interval '1 minute' where id=%s",(invalid_lag,))
        add('rss-review','review',rss)
        add('week-only','relevant',at=anchor-timedelta(days=3))
        add('too-old','relevant',at=anchor-timedelta(days=8))
        add('future','relevant',at=anchor+timedelta(days=2))
        other=workflow(sql);item(sql,source(sql,other),'other-workflow')
        viewer=role_client(admin,cfg,'viewer')
        try:
            for window,accepted in [('24h',4),('7d',5)]:
                response=admin.get('/api/dashboard',params={'window':window})
                assert response.status_code==200,response.text
                data=response.json()
                assert data['counts']=={'accepted':accepted,'review':2,'collected':accepted+8,'rejected':2,'pending':4}
                assert data['metrics']['mentions']['value']==accepted
                assert data['metrics']['collection_lag']['value']==600
                assert data['metrics']['collection_lag']['measured']==accepted+6
                assert {v['service']:v['median_seconds'] for v in data['lag_by_service']}=={'telegram':600,'rss':600}
                # The optimized runtime-role SQL must equal the canonical curated view in this exact API window.
                actual=execute_query(sql,'operatorCountsSql',[1,data['start'],data['end']])
                expected=sql.execute("""select source_kind,decision,count(*)::int count,
                    coalesce(array_agg(lag_seconds) filter(where lag_seconds is not null),'{}') lag_samples
                    from core.curated_items where workflow_id=1 and event_at>=%s and event_at<=%s and decision<>'deleted'
                    group by source_kind,decision""",(data['start'],data['end'])).fetchall()
                normalize=lambda rows:sorted((r['source_kind'],r['decision'],r['count'],sorted(r['lag_samples'])) for r in rows)
                assert normalize(actual)==normalize(expected)
                v=viewer.get('/api/dashboard',params={'window':window}).json()
                assert v['counts']=={'accepted':accepted} and 'noise' not in v['metrics']
                assert v['metrics']['mentions']['value']==accepted
        finally:viewer.close()


def test_growth_exact_observations_and_current_visibility(prepared):
    _,admin,cfg,s,_=prepared
    assert cfg['DATABASE_URL'].endswith('/ufv_checks')
    with psycopg.connect(cfg['DATABASE_URL'],autocommit=True,row_factory=dict_row) as sql:
        anchor=datetime.now(timezone.utc)-timedelta(hours=3)
        run_id=run(sql,1,[s['id']])
        def add(key,decision='relevant',at=anchor):
            raw,mention=item(sql,s['id'],key)
            sql.execute('update raw.items set published_at=%s where id=%s',(at,raw))
            if decision:label(sql,run_id,raw,decision)
            return raw,mention
        def metric(raw,seconds,views):
            sql.execute('insert into raw.metric_snapshots(item_id,observed_at,views) values(%s,%s,%s)',(raw,anchor+timedelta(seconds=seconds),views))
        raw,mention=add('growth')
        for sec,views in [(-1,9000),(0,10),(1800,20),(1800.000001,25),(7200,130),(7200.000001,99000)]:metric(raw,sec,views)
        single,_=add('single');metric(single,0,1);metric(single,60,None)
        declining,_=add('declining');metric(declining,0,50);metric(declining,3600,25)
        undated,_=add('undated');metric(undated,0,1);metric(undated,3600,500)
        sql.execute('update raw.items set published_at=null where id=%s',(undated,))
        for key,decision in [('rejected','unrelated'),('review','review'),('pending',None)]:
            excluded,_=add(key,decision);metric(excluded,0,1);metric(excluded,3600,500)
        other=workflow(sql);foreign,_=item(sql,source(sql,other),'foreign')
        sql.execute('update raw.items set published_at=%s where id=%s',(anchor,foreign))
        metric(foreign,0,1);metric(foreign,3600,500)
        for window in ['24h','7d']:
            response=admin.get('/api/dashboard',params={'window':window})
            assert response.status_code==200,response.text
            growth=response.json()['growth']
            assert len(growth)==1 and growth[0]['id']==str(mention)
            assert growth[0]['observations']==4 and growth[0]['views_per_hour']==60
            assert admin.get('/api'+growth[0]['href']).json()['total']['count']==1
        end=datetime.now(timezone.utc);start=end-timedelta(days=7)
        args=[[raw,foreign],1,['accepted'],start,end]
        assert [r['item_id'] for r in execute_query(sql,'growthSql',args)]==[raw]
        # IDs from an earlier response cannot bypass a later human decision or source transfer.
        sql.execute("insert into core.review_decisions values(%s,'rejected',1,'synthetic',now())",(mention,))
        assert execute_query(sql,'growthSql',args)==[]
        sql.execute("update core.review_decisions set decision='accepted' where mention_id=%s",(mention,))
        assert len(execute_query(sql,'growthSql',args))==1
        sql.execute('update core.sources set workflow_id=%s where id=%s',(other,s['id']))
        assert execute_query(sql,'growthSql',args)==[]


def test_operator_includes_exact_timestamp_boundaries(prepared):
    _,_,cfg,s,_=prepared
    with psycopg.connect(cfg['DATABASE_URL'],autocommit=True,row_factory=dict_row) as sql:
        end=datetime.now(timezone.utc);start=end-timedelta(days=1)
        for key,at in [('before',start-timedelta(microseconds=1)),('start',start),('end',end),('after',end+timedelta(microseconds=1))]:
            raw,_=item(sql,s['id'],key)
            sql.execute('update raw.items set published_at=%s,fetched_at=%s where id=%s',(at,at,raw))
        rows=execute_query(sql,'operatorCountsSql',[1,start,end])
        assert rows==[{'source_kind':'telegram','decision':'accepted','count':2,'lag_samples':[0.0,0.0]}]
