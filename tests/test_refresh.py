"""Admin refresh is durable, idempotent and respects collector backoff."""
from datetime import datetime, timedelta, timezone
import asyncio
import pytest
from test_runtime import runtime, prepared
from test_dashboard import role_client
from pipeline.refresh import apply_refresh_requests
from pipeline.rss import claim
from pipeline.db import DB


def test_refresh_auth_idempotency_disabled_and_audit(prepared):
    db,admin,cfg,source,_=prepared
    viewer=role_client(admin,cfg,'viewer');analyst=role_client(admin,cfg,'analyst')
    try:
        for client in (viewer,analyst):
            assert client.post('/api/admin/refresh',json={'workflow_id':1}).status_code==403
            assert client.get('/api/admin/refresh').status_code==403
        assert admin.post('/api/admin/refresh',json={'workflow_id':'broken'}).status_code==422
        result=admin.post('/api/admin/refresh',json={'workflow_id':1})
        assert result.status_code==202,result.text
        ids=[r['id'] for r in result.json()['requests']]
        repeated=admin.post('/api/admin/refresh',json={'workflow_id':1}).json()
        assert [r['id'] for r in repeated['requests']]==ids
        assert db.one("select count(*) n from core.audit where action='refresh_requested'")['n']==2
        apply_refresh_requests(db,'telegram');apply_refresh_requests(db,'rss')
        rows=admin.get('/api/admin/refresh').json()['requests']
        assert all(r['status']=='disabled' for r in rows)
        assert all('requested_by' not in r and 'target_ids' not in r for r in rows)
    finally:viewer.close();analyst.close()


@pytest.mark.asyncio
async def test_telegram_refresh_pickup_observation_and_floodwait(prepared):
    db,admin,cfg,source,_=prepared
    db.execute("update core.modules set enabled=true where name='telegram'")
    db.execute('update core.workflows set enabled=true')
    db.execute('update core.sources set enabled=true')
    db.execute('update core.telegram_accounts set enabled=true')
    db.execute('update raw.source_state set last_polled_at=now(),last_success_at=now()')
    old=db.one('select last_success_at from raw.source_state')['last_success_at']
    rid=db.one("insert into core.refresh_requests(workflow_id,service,requested_by) values(1,'telegram','test') returning id")['id']
    # Exercise the actual production DB role and 2-second polling cadence, without a Telegram connection.
    collector=DB(cfg['COLLECTOR_DATABASE_URL'])
    try:
        async def poll_once():
            await asyncio.sleep(2)
            apply_refresh_requests(collector,'telegram')
        start=datetime.now(timezone.utc)
        await asyncio.wait_for(poll_once(),5)
        row=db.one('select * from core.refresh_requests where id=%s',(rid,))
        assert row['status']=='running' and (row['started_at']-start).total_seconds()<5
        state=db.one('select last_polled_at,last_success_at from raw.source_state')
        assert state['last_polled_at'] is None and state['last_success_at']==old
        db.execute('update raw.source_state set last_polled_at=now(),last_success_at=now()')
        apply_refresh_requests(collector,'telegram')
        assert db.one('select status from core.refresh_requests where id=%s',(rid,))['status']=='completed'
        until=datetime.now(timezone.utc)+timedelta(minutes=2)
        db.execute("insert into raw.account_status(account_id,status,cooldown_until) values(%s,'flood_wait',%s)",(source['account_id'],until))
        db.execute("insert into core.refresh_requests(workflow_id,service,requested_by) values(1,'telegram','test')")
        apply_refresh_requests(collector,'telegram')
        assert db.one('select status from core.refresh_requests order by id desc limit 1')['status']=='deferred'
        assert db.one('select cooldown_until from raw.account_status')['cooldown_until']==until
    finally:collector.pool.close()


def test_rss_refresh_preserves_retry_after_and_claims_ready_sources(prepared):
    db,admin,cfg,source,_=prepared
    db.execute("insert into core.modules values('rss',true)")
    db.execute('update core.workflows set enabled=true')
    sid=db.one("insert into core.sources(kind,external_id,workflow_id,enabled,permission_note) values('rss','https://example.test/rss',1,true,'Synthetic RSS only') returning id")['id']
    db.execute("insert into core.rss_sources(source_id,rights_status,terms_url,publisher) values(%s,'allowed','https://example.test/terms','test')",(sid,))
    db.execute("insert into raw.rss_state(source_id,status,next_poll_at,observed_revision) values(%s,'ok',now()+interval '1 hour',1)",(sid,))
    rid=db.one("insert into core.refresh_requests(workflow_id,service,requested_by) values(1,'rss','test') returning id")['id']
    collector=DB(cfg['COLLECTOR_DATABASE_URL'])
    try:
        apply_refresh_requests(collector,'rss')
        result=claim(collector)
        assert result and result['id']==sid
        assert db.one('select status from core.refresh_requests where id=%s',(rid,))['status']=='running'
        # An in-flight attempt alone is not success.
        apply_refresh_requests(collector,'rss')
        assert db.one('select status from core.refresh_requests where id=%s',(rid,))['status']=='running'
        until=datetime.now(timezone.utc)+timedelta(minutes=10)
        db.execute("update raw.rss_state set status='error',next_poll_at=%s,lease_until=null where source_id=%s",(until,sid))
        apply_refresh_requests(collector,'rss')
        assert db.one('select status from core.refresh_requests where id=%s',(rid,))['status']=='deferred'
        db.execute("insert into core.refresh_requests(workflow_id,service,requested_by) values(1,'rss','test')")
        apply_refresh_requests(collector,'rss')
        assert db.one('select next_poll_at from raw.rss_state where source_id=%s',(sid,))['next_poll_at']==until
        assert claim(collector) is None
        assert db.one('select status from core.refresh_requests order by id desc limit 1')['status']=='deferred'
    finally:collector.pool.close()


def test_telegram_refresh_preserves_blocked_watch_deadline(prepared):
    from test_runtime import msg
    from pipeline.raw import save_item
    from pipeline.watch import fail
    db,_,cfg,source,_=prepared
    db.execute("update core.modules set enabled=true where name='telegram'")
    db.execute('update core.workflows set enabled=true')
    db.execute('update core.sources set enabled=true')
    db.execute('update core.telegram_accounts set enabled=true')
    blocked=save_item(db,source,msg(101,'Vodafone: синтетична перевірка blocked backoff'),-100100)
    active=save_item(db,source,msg(102,'Vodafone: синтетична активна перевірка'),-100100)
    fail(db,blocked,'DiscussionUnavailable',600)
    db.execute("update raw.watch_state set state='active',next_check_at=now()+interval '1 hour' where item_id=%s",(active,))
    deadline=db.one('select next_check_at from raw.watch_state where item_id=%s',(blocked,))['next_check_at']
    db.execute("insert into core.refresh_requests(workflow_id,service,requested_by) values(1,'telegram','test')")
    collector=DB(cfg['COLLECTOR_DATABASE_URL'])
    try:
        apply_refresh_requests(collector,'telegram')
        assert db.one('select next_check_at from raw.watch_state where item_id=%s',(blocked,))['next_check_at']==deadline
        assert db.one('select next_check_at<=now() due from raw.watch_state where item_id=%s',(active,))['due']
        assert db.one('select status from core.refresh_requests order by id desc limit 1')['status']=='running'
    finally:collector.pool.close()


def test_refresh_missing_collector_is_visible_without_false_completion(prepared):
    db,admin,cfg,source,_=prepared
    request=db.one("""insert into core.refresh_requests(workflow_id,service,requested_by,requested_at)
        values(1,'telegram','synthetic',now()-interval '6 minutes') returning id""")
    db.execute("delete from raw.service_status where name='collector-telegram'")
    response=admin.get('/api/admin/refresh?workflow_id=1')
    assert response.status_code==200
    row=next(r for r in response.json()['requests'] if r['id']==str(request['id']))
    assert row['stale'] is True and row['collector_online'] is False
    assert row['status']=='pending' and row['completed_at'] is None
    assert 'не підтверджено' in row['detail']
    assert db.one('select status from core.refresh_requests where id=%s',(request['id'],))['status']=='pending'
    db.execute("insert into raw.service_status(name,detail) values('collector-telegram','Synthetic heartbeat only')")
    row=admin.get('/api/admin/refresh?workflow_id=1').json()['requests'][0]
    assert row['collector_online'] is True and row['stale'] is True
    assert 'ще очікує' in row['detail']
    # The repeat click still refers to that durable request and returns its true liveness.
    rows=admin.post('/api/admin/refresh',json={'workflow_id':1}).json()['requests']
    row=next(r for r in rows if r['service']=='telegram')
    assert row['id']==str(request['id']) and row['stale'] is True
