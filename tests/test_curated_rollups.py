"""Candidate SQL checks: ufv_checks only, each schema/data change rolls back.

Existing external snapshots must match the files. 0030 is deliberately applied
inside each test transaction until the parent merges the integration candidate.
No running API or production fixture is used.
"""
import hashlib
import json
import os
from pathlib import Path
import uuid

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest

ROOT=Path(__file__).resolve().parents[1]


@pytest.fixture
def db():
    path=Path(os.getenv('UFV_TEST_ENV','/tmp/ufv-rss-checks-env.json'))
    if not path.exists():pytest.skip('Protected ufv_checks configuration is missing')
    cfg=json.loads(path.read_text())
    assert cfg['DATABASE_URL'].endswith('/ufv_checks'), 'Never use a production database'
    with psycopg.connect(cfg['DATABASE_URL'],row_factory=dict_row) as conn:
        conn.execute("set lock_timeout='3s'")
        for name in ['0020_curated_dashboard.sql','0021_curated_visible_items.sql','0022_curated_candidate_lookup.sql']:
            saved=conn.execute('select checksum from public.schema_migrations where name=%s',(name,)).fetchone()
            assert saved and saved['checksum']==hashlib.sha256((ROOT/'db/migrations'/name).read_bytes()).hexdigest()
        for name in ['0030_curated_atomic_rollups.sql','0031_legacy_rss_semantic_scope.sql']:
            applied=conn.execute('select checksum from public.schema_migrations where name=%s',(name,)).fetchone()
            if applied:
                assert applied['checksum']==hashlib.sha256((ROOT/'db/migrations'/name).read_bytes()).hexdigest()
            else:
                conn.execute((ROOT/'db/migrations'/name).read_text())
        try:yield conn
        finally:conn.rollback()


def one(db,sql,args=()):return db.execute(sql,args).fetchone()


def workflow(db):return one(db,"insert into core.workflows(name,enabled) values('Synthetic curated verification',true) returning id")['id']


def source(db,w,kind='telegram',allowed=False):
    s=one(db,"""insert into core.sources(workflow_id,kind,external_id,permission_note,llm_allowed,llm_basis)
        values(%s,%s,%s,'Synthetic isolated test only',%s,'Synthetic test permission only') returning id""",
        (w,kind,'synthetic-'+uuid.uuid4().hex,allowed))['id']
    if kind=='rss':db.execute("insert into core.rss_sources(source_id,rights_status,terms_url,publisher) values(%s,'allowed','https://example.test/terms','Synthetic')",(s,))
    return s


def item(db,s,key='post',decision='accepted'):
    r=one(db,"""insert into raw.items(source_id,source_item_id,url,published_at,text,content_hash)
        values(%s,%s,'https://example.test/synthetic',now()-interval '1 hour','Vodafone тестовий текст',%s) returning id""",
        (s,key,uuid.uuid4().hex))['id']
    m=one(db,"""insert into core.mentions(raw_item_id,source_id,category,summary,quote,decision,brand,raw_version)
        values(%s,%s,'network','Synthetic','Vodafone тестовий текст',%s,'vodafone',1) returning id""",(r,s,decision))['id']
    db.execute('insert into core.processing_receipts(raw_item_id,version,processor_revision) select %s,1,w.processor_revision from core.sources s join core.workflows w on w.id=s.workflow_id where s.id=%s',(r,s))
    return r,m


def run(db,w,sources,*,mode='once',status='complete',kind='telegram',test_sources=None):
    ident=uuid.uuid4()
    scope={'source_kind':kind,'source_ids':sources,'test_source_ids':test_sources or []} if mode=='once' else {'mode':'continuous'}
    db.execute("""insert into core.analysis_runs(id,workflow_id,cutoff_at,model,prompt_version,scope,status,total,note)
        values(%s,%s,now(),'synthetic-model','synthetic-v1',%s,%s,0,'Synthetic only')""",(ident,w,Jsonb(scope),status))
    return ident


def label(db,run_id,raw,decision='relevant',*,parents=None,missing=None,continuous=False):
    body={'decision':decision,'topic':'outage','brands':['vodafone'],'sentiment':'negative','aspects':[],
          'summary':'Синтетичний факт','reason':'Synthetic','context_versions':parents or [],
          'evidence':[{'id':raw,'quote':'Vodafone тестовий текст'}]}
    if missing:body['missing_parent_key']=missing
    version=one(db,'select version from raw.items where id=%s',(raw,))['version']
    db.execute('''insert into core.analysis_labels(run_id,raw_item_id,raw_version,label) values(%s,%s,%s,%s)
        on conflict(run_id,raw_item_id) do update set label=excluded.label,raw_version=excluded.raw_version,analyzed_at=clock_timestamp()''',
        (run_id,raw,version,Jsonb(body)))
    if continuous:
        db.execute("""insert into core.analyst_receipts(raw_item_id,raw_version,model,prompt_version,status,attempts)
            values(%s,%s,'synthetic-model','synthetic-v1','complete',1) on conflict(raw_item_id) do update set
            raw_version=excluded.raw_version,status='complete',model=excluded.model,prompt_version=excluded.prompt_version""",(raw,version))


def decision(db,r):return one(db,'select decision from core.curated_items where raw_item_id=%s',(r,))['decision']
def refresh(db):db.execute('select core.refresh_dashboard_rollups()')
def state(db,s):return one(db,'select * from core.dashboard_rollup_state where source_id=%s',(s,))
def count(db,w):return one(db,"select coalesce(sum(count),0)::int n from core.curated_daily_rollups where workflow_id=%s and decision='accepted'",(w,))['n']


def test_one_shot_source_scope_new_stale_and_exact_human_override(db):
    w=workflow(db);tg=source(db,w);rss=source(db,w,'rss');other=source(db,w)
    a,m=item(db,tg);b,_=item(db,rss);c,_=item(db,other)
    run_id=run(db,w,[tg],test_sources=[tg])
    assert decision(db,a)=='pending' and decision(db,b)=='pending' and decision(db,c)=='pending'
    label(db,run_id,a)
    assert decision(db,a)=='rejected'  # Explicit synthetic quarantine is retained.
    db.execute("insert into core.review_decisions values(%s,'accepted',1,'synthetic',now())",(m,))
    assert decision(db,a)=='rejected'  # Human cannot turn a quarantined fixture into a real metric.
    db.execute("update core.analysis_runs set scope=jsonb_set(scope,'{test_source_ids}','[]') where id=%s",(run_id,))
    assert decision(db,a)=='accepted'
    db.execute('update core.workflows set processor_revision=processor_revision+1 where id=%s',(w,))
    assert decision(db,a)=='accepted'
    db.execute('update raw.items set version=2 where id=%s',(a,))
    assert decision(db,a)=='pending'
    newer,_=item(db,tg,'new-item')
    assert decision(db,newer)=='pending'


def test_continuous_running_requires_receipt_and_current_rights(db):
    w=workflow(db);s=source(db,w,'rss',True);r,_=item(db,s)
    run_id=run(db,w,[],mode='continuous',status='running')
    label(db,run_id,r)
    assert decision(db,r)=='pending'
    label(db,run_id,r,continuous=True)
    assert decision(db,r)=='accepted'
    assert one(db,'select classifier from core.curated_visible_items where raw_item_id=%s',(r,))['classifier']=='semantic'
    refresh(db);before=state(db,s)['invalidated_at']
    db.execute("update core.rss_sources set rights_status='blocked' where source_id=%s",(s,))
    assert state(db,s)['dirty'] and state(db,s)['invalidated_at']>before
    assert one(db,'select classifier from core.curated_items where raw_item_id=%s',(r,))['classifier']=='rules'
    assert not one(db,'select id from core.analyst_items where id=%s',(r,))
    assert not one(db,'select * from core.analyst_rollups where source_id=%s',(s,))


@pytest.mark.parametrize('change',['version','deleted','move'])
def test_cross_source_parent_change_invalidates_child_generation(db,change):
    w=workflow(db);s=source(db,w);p=source(db,w);raw,_=item(db,s);parent,_=item(db,p)
    run_id=run(db,w,[s,p]);label(db,run_id,raw,parents=[{'id':parent,'version':1}])
    refresh(db);assert count(db,w)==1
    if change=='move':db.execute('update core.sources set workflow_id=%s where id=%s',(workflow(db),p))
    else:db.execute(f'update raw.items set {change}=%s where id=%s',(2 if change=='version' else True,parent))
    assert state(db,s)['dirty']
    assert decision(db,raw)=='pending' and count(db,w)==0
    refresh(db);assert count(db,w)==0


def test_missing_parent_arrival_marks_generation_before_recompute(db):
    w=workflow(db);s=source(db,w);raw,_=item(db,s)
    run_id=run(db,w,[s]);label(db,run_id,raw,missing='missing-parent')
    refresh(db);assert count(db,w)==1
    item(db,s,'missing-parent')
    assert state(db,s)['dirty'] and decision(db,raw)=='pending' and count(db,w)==0
    refresh(db);assert count(db,w)==0


def test_run_activation_scope_change_retraction_and_label_delete(db):
    w=workflow(db);s=source(db,w);r,_=item(db,s)
    run_id=run(db,w,[s],status='running');refresh(db);assert count(db,w)==1
    db.execute("update core.analysis_runs set status='complete' where id=%s",(run_id,))
    assert state(db,s)['dirty'] and decision(db,r)=='pending'
    label(db,run_id,r);refresh(db);assert count(db,w)==1
    db.execute('delete from core.analysis_labels where run_id=%s',(run_id,))
    assert state(db,s)['dirty'] and decision(db,r)=='pending'
    db.execute("update core.analysis_runs set scope=jsonb_set(scope,'{source_ids}','[]') where id=%s",(run_id,))
    assert decision(db,r)=='pending'  # Global semantic policy persists outside this run's scope.
    db.execute("update core.analysis_runs set scope=jsonb_set(scope,'{source_ids}',%s) where id=%s",(Jsonb([s]),run_id))
    assert decision(db,r)=='pending'
    db.execute("update core.analysis_runs set status='failed' where id=%s",(run_id,))
    assert decision(db,r)=='accepted'


def test_physical_month_generation_and_query_has_no_raw_relations(db):
    w=workflow(db);s=source(db,w);r,_=item(db,s);run_id=run(db,w,[s]);label(db,run_id,r)
    db.execute("insert into raw.metric_snapshots(item_id,views,reactions) values(%s,42,%s)",(r,Jsonb({'👎':3,'🤣':3,'😢':8,'👍':16})))
    refresh(db)
    row=one(db,'select * from core.curated_daily_rollups where source_id=%s',(s,))
    assert row['count']==1 and row['reaction_negative']==3 and row['reaction_ironic']==3
    assert row['reaction_sad']==8 and row['reaction_positive']==16
    assert row['metrics_oldest_at'] and row['metrics_newest_at']
    assert row['rolling_7d_count']==1
    generated=row['generated_at']
    db.execute('revoke select on core.dashboard_items,core.curated_items,core.curated_visible_items from ufv_api')
    db.execute('set local role ufv_api')
    assert count(db,w)==1
    plan=one(db,'explain (format json) select * from core.curated_daily_rollups where workflow_id=%s',(w,))['QUERY PLAN']
    db.execute('reset role')
    relations=[]
    def visit(node):
        if isinstance(node,dict):
            if 'Relation Name' in node:relations.append(node['Relation Name'])
            for child in node.values():visit(child)
        elif isinstance(node,list):
            for child in node:visit(child)
    visit(plan)
    assert set(relations)<= {'daily_rollups','sources','dashboard_rollup_state'},relations
    assert one(db,'select generated_at from core.curated_daily_rollups where source_id=%s',(s,))['generated_at']==generated
    label(db,run_id,r,'irrelevant')
    assert count(db,w)==0 and state(db,s)['dirty']
    refresh(db);assert count(db,w)==0
    assert one(db,"select count from core.daily_rollups where source_id=%s and decision='rejected'",(s,))['count']==1


def test_source_move_removes_old_scope_and_rebuilds_new(db):
    old=workflow(db);new=workflow(db);s=source(db,old);r,_=item(db,s)
    run_id=run(db,old,[s]);label(db,run_id,r);refresh(db)
    assert count(db,old)==1
    db.execute('update core.sources set workflow_id=%s where id=%s',(new,s))
    assert count(db,old)==0 and count(db,new)==0 and state(db,s)['dirty']
    refresh(db);assert count(db,old)==0 and count(db,new)==1


def test_semantic_flip_retires_s2_even_after_recompute(db):
    w=workflow(db);s=source(db,w,'rss',True);r,_=item(db,s)
    run_id=run(db,w,[],mode='continuous',status='running');label(db,run_id,r,continuous=True);refresh(db)
    st=state(db,s)
    body={'headline':'Synthetic','observations':[],'limitations':[],
          'provenance':{'source_states':[{'source_id':s,'invalidated_at':st['invalidated_at'].isoformat()}]}}
    a=one(db,"""insert into core.ai_summaries(workflow_id,"window",window_start,window_end,model,mode,body,input_versions,source_ids)
        values(%s,'30d',now()-interval '30 days',now(),'synthetic','rules',%s,%s,%s) returning id""",
        (w,Jsonb(body),Jsonb([{'id':r,'version':1,'rule_decision':'accepted'}]),[s]))['id']
    assert one(db,'select id from core.current_ai_summaries where id=%s',(a,))
    label(db,run_id,r,'irrelevant',continuous=True)
    assert one(db,'select rule_decision from core.analyst_items where id=%s',(r,))['rule_decision']=='rejected'
    assert not one(db,'select id from core.current_ai_summaries where id=%s',(a,))
    refresh(db)
    assert not one(db,'select id from core.current_ai_summaries where id=%s',(a,))


def test_continuous_parent_revocation_retires_child_label(db):
    w=workflow(db);s=source(db,w,'rss',True);p=source(db,w,'rss',True)
    raw,_=item(db,s);parent,_=item(db,p)
    run_id=run(db,w,[],mode='continuous',status='running')
    label(db,run_id,raw,parents=[{'id':parent,'version':1}],continuous=True)
    refresh(db);assert decision(db,raw)=='accepted'
    db.execute('update core.sources set llm_allowed=false where id=%s',(p,))
    assert state(db,s)['dirty'] and decision(db,raw)=='pending'
    assert not one(db,'select raw_item_id from core.curated_visible_items where raw_item_id=%s',(raw,))


def test_runtime_roles_cannot_invalidate_arbitrary_sources(db):
    roles=[row['rolname'] for row in db.execute("select rolname from pg_roles where rolname in ('ufv_api','ufv_collector','ufv_analyst')")]
    assert 'ufv_api' in roles and 'ufv_collector' in roles
    for role in roles:
        assert one(db,"select has_function_privilege(%s,'core.mark_curated_sources_dirty(bigint[])','EXECUTE') allowed",(role,))['allowed'] is False
    assert one(db,"select has_function_privilege('ufv_processor','core.refresh_dashboard_rollups()','EXECUTE') allowed")['allowed'] is True


def test_rolling_seven_day_count_is_not_calendar_bucket_sum(db):
    w=workflow(db);s=source(db,w);recent,_=item(db,s,'recent');older,_=item(db,s,'older')
    db.execute("update raw.items set published_at=now()-interval '7 days 1 minute' where id=%s",(older,))
    run_id=run(db,w,[s]);label(db,run_id,recent);label(db,run_id,older)
    refresh(db)
    row=one(db,'select sum(count) total,sum(rolling_7d_count) week from core.curated_daily_rollups where workflow_id=%s',(w,))
    assert row['total']==2 and row['week']==1


def test_single_source_generations_complete_fifty_source_warmup(db):
    w=workflow(db);sources=[source(db,w) for _ in range(50)]
    for n,s in enumerate(sources):item(db,s,str(n))
    assert one(db,'select dirty_sources from core.dashboard_rollup_coverage where workflow_id=%s',(w,))['dirty_sources']==50
    for s in sources:db.execute('select core.refresh_dashboard_rollups(%s)',(s,))
    assert one(db,'select dirty_sources from core.dashboard_rollup_coverage where workflow_id=%s',(w,))['dirty_sources']==0
    assert count(db,w)==50
    original=state(db,sources[0])
    item(db,sources[0],'new-pending-input')
    assert state(db,sources[0])['dirty'] is False
    assert state(db,sources[0])['generated_at']==original['generated_at']
    assert count(db,w)==50  # The timestamped snapshot remains valid until timed rebuild.
    db.execute("update core.dashboard_rollup_state set generated_at=now()-interval '61 seconds' where source_id=%s",(sources[0],))
    db.execute('select core.refresh_dashboard_rollups(%s)',(sources[0],))
    assert count(db,w)==51


def test_normal_processor_new_and_late_context_retry_stay_pending_without_dirty_loop(db):
    from contextlib import contextmanager
    from types import SimpleNamespace
    import sys
    sys.path.insert(0,str(ROOT/'services'))
    from pipeline.processor import process
    @contextmanager
    def connection():yield db
    adapter=SimpleNamespace(pool=SimpleNamespace(connection=connection))
    w=workflow(db);s=source(db,w);run(db,w,[s]);refresh(db)
    raw=one(db,"""insert into raw.items(source_id,source_item_id,parent_item_id,kind,text,content_hash)
        values(%s,'reply','parent','comment','У мене теж не працює','synthetic') returning id""",(s,))['id']
    process(adapter,raw)
    assert decision(db,raw)=='pending' and state(db,s)['dirty'] is False
    # A duplicate delivery executes UPDATE, but the effective semantic decision stays pending.
    process(adapter,raw)
    assert state(db,s)['dirty'] is False
    parent=one(db,"""insert into raw.items(source_id,source_item_id,text,content_hash)
        values(%s,'parent','Vodafone не працює інтернет','synthetic-parent') returning id""",(s,))['id']
    process(adapter,parent);process(adapter,raw)
    assert one(db,'select decision from core.mentions where raw_item_id=%s',(raw,))['decision']=='accepted'
    assert decision(db,raw)=='pending' and state(db,s)['dirty'] is False
    db.execute('update raw.items set version=2 where id=%s',(raw,))
    assert state(db,s)['dirty'] is True
    process(adapter,raw)
    assert state(db,s)['dirty'] is True


def test_legacy_rss_scope_requires_current_rights_and_excludes_telegram(db):
    w=workflow(db);rss=source(db,w,'rss');blocked=source(db,w,'rss');tg=source(db,w)
    accepted,_=item(db,rss,'accepted');noise,_=item(db,rss,'noise');blocked_raw,_=item(db,blocked);telegram,_=item(db,tg)
    db.execute("update core.rss_sources set rights_status='blocked' where source_id=%s",(blocked,))
    run_id=run(db,w,[])
    legacy={'rss':'allowed','excluded_telegram':29622,'telegram_source_ids':[],'telegram_rights_basis':''}
    db.execute('update core.analysis_runs set scope=%s where id=%s',(Jsonb(legacy),run_id))
    label(db,run_id,accepted);label(db,run_id,noise,'unrelated');label(db,run_id,blocked_raw);label(db,run_id,telegram)
    assert decision(db,accepted)=='accepted' and decision(db,noise)=='rejected'
    assert decision(db,blocked_raw)=='pending' and decision(db,telegram)=='pending'
    refresh(db);assert count(db,w)==1
    db.execute("update core.rss_sources set rights_status='blocked' where source_id=%s",(rss,))
    assert state(db,rss)['dirty'] and decision(db,accepted)=='pending' and count(db,w)==0
    refresh(db);assert count(db,w)==0


def test_legacy_rss_is_not_a_blanket_empty_or_explicitly_excluded_scope(db):
    w=workflow(db);s=source(db,w,'rss');raw,_=item(db,s);run_id=run(db,w,[])
    label(db,run_id,raw)
    for scope in [{},{'rss':'blocked'},{'rss':'allowed','source_ids':[]},{'rss':'allowed','source_ids':None},
                  {'rss':'allowed','source_kind':'telegram'}]:
        db.execute('update core.analysis_runs set scope=%s where id=%s',(Jsonb(scope),run_id))
        assert decision(db,raw)=='pending'
