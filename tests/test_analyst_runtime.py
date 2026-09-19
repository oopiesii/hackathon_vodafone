"""Усі записи лише в ufv_checks; зовнішні LLM замінено локальним HTTP server."""
import asyncio
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import uuid

import httpx
import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict,make_conninfo
import pytest

from test_analyst import mock_llm
from analyst.db import DB,reserve_budget
from analyst.label import analyze_item,pending_ids
from analyst.provider import Config,make_provider
from analyst.runtime import Analyst,consume
from analyst.summary import summarize_window
from deploy.analyst_grants import grant_analyst
from pipeline.processor import process

ROOT=Path(__file__).resolve().parents[1]


class ProtectedConfig(dict):
    def __repr__(self): return '<protected isolated test config>'


@pytest.fixture(scope='module')
def ai_runtime(tmp_path_factory):
    path=Path(os.environ.get('UFV_TEST_ENV','/tmp/ufv-rss-checks-env.json'))
    if not path.exists(): pytest.skip('Isolated integration environment not configured')
    cfg=ProtectedConfig(json.loads(path.read_text()))
    assert conninfo_to_dict(cfg['DATABASE_URL'])['dbname']=='ufv_checks'
    owner=DB(cfg['DATABASE_URL'])
    assert owner.one("select to_regclass('core.analyst_state') exists")['exists'], 'Apply additive migration 0012 to ufv_checks first'
    role='ufv_checks_ai_'+uuid.uuid4().hex[:8]
    password=secrets.token_hex(24)
    with owner.pool.connection() as conn:
        conn.execute(sql.SQL('create role {} login password {}').format(sql.Identifier(role),sql.Literal(password)))
        grant_analyst(conn,role)
    fields=conninfo_to_dict(cfg['DATABASE_URL']);fields.update(user=role,password=password)
    analyst_url=make_conninfo(**fields)
    analyst=DB(analyst_url)
    temp=tmp_path_factory.mktemp('analyst-config')
    port=18205
    api_env={**os.environ,**{k:str(v) for k,v in cfg.items()},'DATABASE_URL':cfg['SERVER_DATABASE_URL'],
             'PORT':str(port),'HOST':'127.0.0.1','PUBLIC_URL':f'http://127.0.0.1:{port}'}
    api=subprocess.Popen(['node','apps/api/dist/index.js'],cwd=ROOT,env=api_env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    admin=httpx.Client(base_url=api_env['PUBLIC_URL'],headers={'Origin':api_env['PUBLIC_URL']})
    for _ in range(100):
        try:
            if admin.get('/api/health').status_code==200: break
        except httpx.ConnectError: pass
        time.sleep(.05)
    owner.execute('truncate auth."rateLimit"')
    assert admin.post('/api/auth/sign-in/email',json={'email':'admin@ufv.test','password':cfg['ADMIN_PASSWORD']}).status_code==200
    yield owner,analyst,admin,ProtectedConfig({**cfg,'ANALYST_URL':analyst_url,'AI_PUBLIC_URL':api_env['PUBLIC_URL'],'TEMP':temp,'ROLE':role})
    admin.close();api.terminate();api.wait(timeout=10);analyst.pool.close()
    with owner.pool.connection() as conn:
        conn.execute(sql.SQL('drop owned by {}').format(sql.Identifier(role)))
        conn.execute(sql.SQL('drop role {}').format(sql.Identifier(role)))
    owner.pool.close()


@pytest.fixture
def allowed_source(ai_runtime):
    owner,analyst,admin,cfg=ai_runtime
    token=uuid.uuid4().hex
    workflow=owner.one("insert into core.workflows(name,enabled) values('Synthetic analyst checks',true) returning id")['id']
    source=owner.one('''insert into core.sources(kind,external_id,title,workflow_id,permission_note,llm_allowed,llm_basis)
        values('rss',%s,'Synthetic allowed RSS',%s,'Synthetic test content only',true,'Synthetic test authorization') returning *''',
        ('https://example.invalid/'+token,workflow))
    owner.execute("insert into core.rss_sources(source_id,rights_status,terms_url,publisher) values(%s,'allowed','https://example.invalid/terms','Synthetic')",(source['id'],))
    owner.execute('delete from core.analyst_budget')
    yield source
    # Delete this fixture only, never truncate another agent's test data.
    owner.execute('delete from core.analysis_labels where run_id in(select id from core.analysis_runs where workflow_id=%s)',(workflow,))
    owner.execute('delete from core.analysis_runs where workflow_id=%s',(workflow,))
    owner.execute('delete from core.analyst_receipts where raw_item_id in(select id from raw.items where source_id=%s)',(source['id'],))
    owner.execute('delete from core.ai_summaries where workflow_id=%s',(workflow,))
    owner.execute('delete from core.analyst_summary_schedule where workflow_id=%s',(workflow,))
    owner.execute('delete from core.review_decisions where mention_id in(select id from core.mentions where source_id in(select id from core.sources where workflow_id=%s))',(workflow,))
    owner.execute('delete from core.mentions where source_id in(select id from core.sources where workflow_id=%s)',(workflow,))
    owner.execute('delete from core.processing_receipts where raw_item_id in(select id from raw.items where source_id in(select id from core.sources where workflow_id=%s))',(workflow,))
    owner.execute('delete from raw.items where source_id in(select id from core.sources where workflow_id=%s)',(workflow,))
    owner.execute('delete from core.rss_sources where source_id in(select id from core.sources where workflow_id=%s)',(workflow,))
    owner.execute('delete from core.sources where workflow_id=%s',(workflow,))
    owner.execute('delete from core.workflows where id=%s',(workflow,))


def add_item(owner,source,text='Vodafone не працює. Пишіть user@example.invalid або +380 67 111 22 33.',parent=None):
    row=owner.one('''insert into raw.items(source_id,source_item_id,parent_item_id,text,content_hash,url,published_at,kind)
        values(%s,%s,%s,%s,%s,'https://example.invalid/evidence',now(),%s) returning id''',
        (source['id'],uuid.uuid4().hex,parent,text,uuid.uuid4().hex,'comment' if parent else 'post'))
    process(owner,row['id'])
    return row['id']


def test_role_allowlist_private_data_and_s1(ai_runtime,allowed_source,mock_llm):
    owner,db,admin,cfg=ai_runtime;state,config=mock_llm
    ident=add_item(owner,allowed_source)
    worker=Analyst(db);worker.heartbeat(config)
    assert analyze_item(db,ident,make_provider(config),config)=='complete'
    assert analyze_item(db,ident,make_provider(config),config)=='already_processed'
    label=owner.one('select label from core.analysis_labels where raw_item_id=%s',(ident,))['label']
    assert label['relevance']=='vodafone'
    payload=json.dumps(state['requests'],ensure_ascii=False)
    assert 'user@example' not in payload and '+380' not in payload and 'example.invalid/evidence' not in payload
    assert not pending_ids(db,config.model) or ident not in [r['id'] for r in pending_ids(db,config.model)]
    for table in ('raw.items','core.telegram_accounts','auth.account','core.sources'):
        with pytest.raises(psycopg.errors.InsufficientPrivilege): db.all('select * from '+table)
    owner.execute('update core.sources set llm_allowed=false where id=%s',(allowed_source['id'],))
    assert analyze_item(db,ident,make_provider(config),config)=='not_allowed'
    assert db.one('select id from core.analyst_items where id=%s',(ident,)) is None


def test_bad_model_output_rejected_budget_persists_and_parent_reanalysis(ai_runtime,allowed_source,mock_llm):
    owner,db,_,_=ai_runtime;state,config=mock_llm
    parent=add_item(owner,allowed_source,'Vodafone не працює у Львові.')
    parent_key=owner.one('select source_item_id from raw.items where id=%s',(parent,))['source_item_id']
    child=add_item(owner,allowed_source,'У мене Vodafone теж не працює.',parent_key)
    state['invalid']='quote'
    assert analyze_item(db,child,make_provider(config),config)=='evidence_validation_failed'
    assert not owner.one('select 1 from core.analysis_labels where raw_item_id=%s',(child,))
    assert db.one('select used from core.analyst_budget order by hour desc limit 1')['used']==1
    assert not reserve_budget(db,1)
    state['invalid']=None
    owner.execute("update core.analyst_receipts set retry_at=now()-interval '1 second' where raw_item_id=%s",(child,))
    assert analyze_item(db,child,make_provider(config),config)=='complete'
    owner.execute("update raw.items set text='Vodafone відновив зв’язок.',version=version+1 where id=%s",(parent,))
    assert child in [r['id'] for r in pending_ids(db,config.model)]
    assert analyze_item(db,child,make_provider(config),config)=='complete'
    assert owner.one('select label from core.analysis_labels where raw_item_id=%s',(child,))['label']['context_versions'][0]['version']==2


def test_s2_validates_evidence_month_is_only_rollups_and_revoke_hides(ai_runtime,allowed_source,mock_llm):
    owner,db,_,cfg=ai_runtime;state,config=mock_llm
    ident=add_item(owner,allowed_source)
    assert summarize_window(db,allowed_source['workflow_id'],'24h',make_provider(config),config)=='ai'
    first=db.one('select * from core.current_ai_summaries where workflow_id=%s',(allowed_source['workflow_id'],))
    assert first['evidence_ids']==[ident]
    state['invalid']='summary'
    with pytest.raises(ValueError,match='unverified_quote'):
        summarize_window(db,allowed_source['workflow_id'],'7d',make_provider(config),config)
    assert owner.one('select count(*) n from core.ai_summaries where workflow_id=%s',(allowed_source['workflow_id'],))['n']==1
    state['invalid']=None
    owner.execute('select core.refresh_dashboard_rollups()')
    with owner.pool.connection() as conn:
        conn.execute(sql.SQL('revoke select on core.analyst_items from {}').format(sql.Identifier(cfg['ROLE'])))
    try:
        assert summarize_window(db,allowed_source['workflow_id'],'30d',make_provider(config),config)=='ai'
    finally:
        with owner.pool.connection() as conn: grant_analyst(conn,cfg['ROLE'])
    month=db.one('select * from core.current_ai_summaries where workflow_id=%s and "window"=\'30d\'',(allowed_source['workflow_id'],))
    assert month['evidence_ids']==[] and month['body']['provenance']['type']=='daily_rollups'
    month_input=json.loads(state['requests'][-1]['messages'][-1]['content'].split('\n',1)[1])
    assert 'items' not in month_input and 'text' not in json.dumps(month_input)
    owner.execute('update core.sources set llm_allowed=false where id=%s',(allowed_source['id'],))
    assert not db.all('select * from core.current_ai_summaries where workflow_id=%s',(allowed_source['workflow_id'],))


def test_api_admin_only_basis_audit_and_rss_rights(ai_runtime,allowed_source):
    owner,_,admin,cfg=ai_runtime
    path=f'/api/admin/ai/sources/{allowed_source["id"]}'
    with httpx.Client(base_url=cfg['AI_PUBLIC_URL']) as anonymous:
        assert anonymous.get('/api/admin/ai/status').status_code==401
    for role in ('viewer','analyst'):
        email=f'ai-{role}-{uuid.uuid4().hex[:8]}@ufv.test';password='Synthetic-check-password!'
        assert admin.post('/api/auth/admin/create-user',json={'email':email,'password':password,'name':'Synthetic AI test','role':role}).status_code==200
        with httpx.Client(base_url=cfg['AI_PUBLIC_URL'],headers={'Origin':cfg['AI_PUBLIC_URL']}) as client:
            assert client.post('/api/auth/sign-in/email',json={'email':email,'password':password}).status_code==200
            assert client.get('/api/admin/ai/status').status_code==403
            assert client.put(path,json={'llm_allowed':False,'llm_basis':''}).status_code==403
    assert admin.put(path,json={'llm_allowed':True,'llm_basis':'short'}).status_code==400
    assert admin.put(path,json={'llm_allowed':False,'llm_basis':'Synthetic revoke basis'}).status_code==200
    assert owner.one("select detail from core.audit where action='llm_revoked' and object_id=%s order by id desc limit 1",(str(allowed_source['id']),))['detail']['llm_basis']=='Synthetic revoke basis'
    owner.execute("update core.rss_sources set rights_status='blocked' where source_id=%s",(allowed_source['id'],))
    assert admin.put(path,json={'llm_allowed':True,'llm_basis':'Synthetic allow basis'}).status_code==409
    status=admin.get('/api/admin/ai/status')
    assert status.status_code==200 and 'synthetic-test-value' not in status.text


def test_summary_invalidation_and_partial_month_are_never_presented_as_complete(ai_runtime,allowed_source,mock_llm):
    owner,db,_,_=ai_runtime;state,config=mock_llm
    ident=add_item(owner,allowed_source)
    owner.execute('select core.refresh_dashboard_rollups()')
    provider=make_provider(config)
    assert summarize_window(db,allowed_source['workflow_id'],'30d',provider,config)=='ai'
    assert summarize_window(db,allowed_source['workflow_id'],'24h',provider,config)=='ai'
    assert len(db.all('select id from core.current_ai_summaries where workflow_id=%s',(allowed_source['workflow_id'],)))==2
    mid=owner.one('select id from core.mentions where raw_item_id=%s',(ident,))['id']
    owner.execute("insert into core.review_decisions(mention_id,decision,raw_version,reviewed_by) values(%s,'rejected',1,'synthetic-analyst-test')",(mid,))
    assert not db.all('select id from core.current_ai_summaries where workflow_id=%s',(allowed_source['workflow_id'],))
    before=len(state['requests'])
    assert summarize_window(db,allowed_source['workflow_id'],'30d',provider,config)=='rollup_pending'
    assert len(state['requests'])==before
    owner.execute('select core.refresh_dashboard_rollups()')
    # Rebuilding must not revive a model narrative generated before the human review.
    assert not db.all('select id from core.current_ai_summaries where workflow_id=%s',(allowed_source['workflow_id'],))
    assert summarize_window(db,allowed_source['workflow_id'],'30d',provider,config)=='ai'
    current=db.one('select body from core.current_ai_summaries where workflow_id=%s',(allowed_source['workflow_id'],))
    assert current['body']['aggregate_facts']['accepted']==0


def test_invalidation_during_model_request_discards_snapshot(ai_runtime,allowed_source,mock_llm):
    owner,db,_,_=ai_runtime;_,config=mock_llm
    ident=add_item(owner,allowed_source)
    owner.execute('select core.refresh_dashboard_rollups()')
    provider=make_provider(config)
    class ChangedDuringRequest:
        def complete_json(self,task,schema,payload):
            output=provider.complete_json(task,schema,payload)
            owner.execute("update raw.items set text='Оновлений синтетичний текст',version=version+1 where id=%s",(ident,))
            owner.execute('select core.refresh_dashboard_rollups()')
            return output
    assert summarize_window(db,allowed_source['workflow_id'],'30d',ChangedDuringRequest(),config)=='input_changed'
    assert not db.all('select id from core.ai_summaries where workflow_id=%s',(allowed_source['workflow_id'],))


def test_live_null_process_has_heartbeat_and_nats(ai_runtime,allowed_source):
    owner,_,_,cfg=ai_runtime
    add_item(owner,allowed_source)
    runtime=cfg['TEMP']/'runtime.env';runtime.write_text('UFV_LLM_PROVIDER=null\n');runtime.chmod(0o600)
    env={**os.environ,'PYTHONPATH':str(ROOT/'services'),'DATABASE_URL':cfg['ANALYST_URL'],
         'NATS_URL':cfg['NATS_URL'],'UFV_NATS_STREAM':cfg['UFV_NATS_STREAM'],
         'UFV_NATS_SUBJECT':cfg['UFV_NATS_SUBJECT'],'UFV_ANALYST_DURABLE':'analyst-checks-'+uuid.uuid4().hex[:8],
         'UFV_LLM_RUNTIME_FILE':str(runtime)}
    started=time.time()
    process_handle=subprocess.Popen([sys.executable,'-m','analyst.runtime'],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        for _ in range(100):
            row=owner.one('select * from core.analyst_state where singleton')
            if row and row['mode']=='waiting_key' and row['heartbeat_at'].timestamp()>started: break
            time.sleep(.1)
        assert process_handle.poll() is None
        assert row['mode']=='waiting_key' and row['heartbeat_at'].timestamp()>started
        time.sleep(1)
        assert owner.one('select count(*) n from core.ai_summaries where workflow_id=%s and mode=\'rules\'',(allowed_source['workflow_id'],))['n']>=1
    finally:
        process_handle.terminate();stdout,stderr=process_handle.communicate(timeout=10)
        assert b'password' not in stderr.lower()


def test_nats_delivery_writes_label(ai_runtime,allowed_source,mock_llm,monkeypatch):
    owner,db,_,cfg=ai_runtime;state,config=mock_llm
    ident=add_item(owner,allowed_source)
    for name in ('NATS_URL','UFV_NATS_STREAM','UFV_NATS_SUBJECT'):monkeypatch.setenv(name,cfg[name])
    monkeypatch.setenv('UFV_ANALYST_DURABLE','analyst-unit-'+uuid.uuid4().hex[:8])
    monkeypatch.setattr('analyst.runtime.load_config',lambda:config)
    async def run():
        from pipeline.bus import connect
        nc,js=await connect()
        task=asyncio.create_task(consume(Analyst(db)))
        try:
            await js.publish(cfg['UFV_NATS_SUBJECT'],json.dumps({'v':1,'raw_item_id':str(ident)}).encode())
            for _ in range(100):
                if owner.one('select 1 from core.analysis_labels where raw_item_id=%s',(ident,)):break
                await asyncio.sleep(.05)
            assert owner.one('select 1 from core.analysis_labels where raw_item_id=%s',(ident,))
        finally:
            task.cancel();await asyncio.gather(task,return_exceptions=True);await nc.close()
    asyncio.run(run())
