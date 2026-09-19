"""Telegram contracts: no real account, source, or join RPC is used by these tests."""
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS
import uuid

import httpx
import pytest
from telethon import types
from telethon.errors import FloodWaitError

from test_runtime import runtime, prepared, msg
from pipeline.classification import classify, normalize
from pipeline.db import DB
from pipeline.metrics import extract_metrics, save_snapshot
from pipeline.raw import save_item, delete_items
from pipeline.processor import process
from pipeline.telegram import Collector
from pipeline.telegram_jobs import source_type, claim, finish, run_one
from pipeline.watch import DEFAULTS, activity, decision, complete, due, fail

NOW=datetime(2026,9,19,tzinfo=timezone.utc)

def observed(views=None,replies=None,reactions=None,when=NOW):
    return dict(views=views,replies=replies,reactions=reactions,observed_at=when)

def entity(ident=200,username='synthetic_group',member=False,forum=False):
    return types.Channel(id=ident,title='Synthetic group',photo=types.ChatPhotoEmpty(),date=NOW,
        username=username,access_hash=123,megagroup=True,left=not member,forum=forum)


@pytest.mark.parametrize('age,quiet,expected',[(1,0,'active'),(3,2,'cooling'),(8,2,'sleeping'),(25,2,'archived')])
def test_lifecycle(age,quiet,expected):
    item=dict(deleted=False,published_at=NOW-timedelta(days=age),fetched_at=NOW-timedelta(days=age))
    state=dict(quiet_checks=quiet,last_activity_at=item['fetched_at'])
    result=decision(item,state,observed(10,when=NOW-timedelta(minutes=5)),observed(10),DEFAULTS,now=NOW)
    assert result['state']==expected
    assert (result['seconds'] is None)==(expected=='archived')

def test_lifecycle_unknown_corrections_rates_pin_and_pause():
    before=observed(100,1,{'👍':5},NOW-timedelta(hours=2))
    after=observed(90,1,{'👍':4})
    hot,known,deltas=activity(before,after,DEFAULTS)
    assert known and not hot and deltas['views']==dict(delta=-10,per_hour=-5,correction=True)
    assert not activity(observed(),observed(),DEFAULTS)[1]
    item=dict(deleted=False,published_at=NOW-timedelta(days=50),fetched_at=NOW-timedelta(days=50))
    state=dict(quiet_checks=9,last_activity_at=item['fetched_at'])
    unknown=decision(item,state,observed(),observed(),DEFAULTS,now=NOW)
    assert unknown['state']=='archived' and 'невідома' in unknown['reason']
    assert decision({**item,'published_at':NOW-timedelta(days=3)},state,observed(),observed(),DEFAULTS,now=NOW)['state']=='blocked'
    assert decision(item,state,before,after,DEFAULTS,{'mode':'pinned'},NOW)['state']=='active'
    assert decision(item,state,before,after,DEFAULTS,{'mode':'paused'},NOW)['seconds'] is None
    assert not activity(observed(0,when=NOW-timedelta(hours=2)),observed(100),DEFAULTS)[0]
    assert activity(observed(0,when=NOW-timedelta(minutes=5)),observed(100),DEFAULTS)[0]
    assert not activity(observed(0),observed(100),DEFAULTS)[1]

def test_aggregate_metrics_exclude_people():
    message=NS(views=10,forwards=None,replies=NS(replies=2,recent_repliers=['private']),
        from_id='private',reactions=NS(results=[NS(reaction=types.ReactionEmoji('👍'),count=3)],recent_reactions=['private']))
    result=extract_metrics(message)
    assert result['reactions']=={'👍':3} and result['replies']==2
    assert result['forwards'] is None and result['available']['forwards'] is False
    assert 'private' not in str(result) and 'from_id' not in result
    assert extract_metrics(NS(views=-5))['views'] is None
    assert extract_metrics(NS(reactions=NS(results=[])))['reactions']=={}

@pytest.mark.parametrize('text,expected',[
    ('Vodafone інтернет зник','accepted'),('Казино бонус Vodafone','rejected'),
    ('Vodafone заблокував шахрайське казино','review'),('Промокод на інтернет','review'),
    ('Сьогодні варимо борщ','rejected'),('Тариф на опалення','review'),
])
def test_filter_is_explainable(text,expected):
    verdict=classify(text)
    assert verdict.decision==expected and verdict.reason

def test_normalization_preserves_plain_text_and_masks_contacts():
    text=normalize('Швидкість 1 < 10; @vodafone_ua +380501234567 somebody@example.org @private_person https://example.org')
    assert '1 < 10' in text and 'Vodafone' in text
    for private in ['380501234567','somebody@example.org','@private_person','https://example.org']:
        assert private not in text

def test_source_types_and_private_rejection():
    assert source_type(entity())=='supergroup'
    assert source_type(entity(forum=True))=='forum'
    with pytest.raises(ValueError):source_type(entity(username=None))
    with pytest.raises(ValueError):source_type(NS(username='private_user'))

def test_metrics_do_not_reprocess_content_and_edits_are_versioned(prepared):
    db,client,_,source,_=prepared
    message=msg(10,'Vodafone INTERNET');message.views=10
    ident=save_item(db,source,message,-100100);process(db,ident)
    save_snapshot(db,ident,message,NOW)
    message.views=20
    assert save_item(db,source,message,-100100)==ident
    save_snapshot(db,ident,message,NOW+timedelta(minutes=5))
    assert db.one('select version from raw.items where id=%s',(ident,))['version']==1
    assert db.one('select count(*) n from raw.outbox')['n']==1
    detail=client.get(f'/api/inbox/{ident}').json()['telegram']
    assert [int(m['views']) for m in detail['metrics']]==[10,20]
    message.message='Vodafone internet';message.edit_date=datetime.now(timezone.utc)
    save_item(db,source,message,-100100)
    assert db.one('select count(*) n from raw.item_versions')['n']==2
    assert db.one('select version from raw.items where id=%s',(ident,))['version']==2
    delete_items(db,source['account_id'],-100100,[10])
    assert db.one('select count(*) n from raw.item_versions')['n']==0
    assert client.get(f'/api/inbox/{ident}').json()['telegram']['metrics']==[]

def test_group_context_forum_and_out_of_order_parent(prepared):
    db,client,_,source,_=prepared
    child=msg(11,'У мене теж не працює',10)
    child.reply_to.reply_to_top_id=10;child.reply_to.forum_topic=True
    reply=save_item(db,source,child,-100100,'group_message');process(db,reply)
    assert db.one('select decision from core.mentions where raw_item_id=%s',(reply,))['decision']=='review'
    root=save_item(db,source,msg(10,'Vodafone інтернет зник'),-100100,'group_message');process(db,root)
    assert not db.one('select * from core.processing_receipts where raw_item_id=%s',(reply,))
    process(db,reply)
    nested=save_item(db,source,msg(12,'Теж так само',11),-100100,'group_message');process(db,nested)
    assert db.one('select decision from core.mentions where raw_item_id=%s',(nested,))['decision']=='accepted'
    unrelated=save_item(db,source,msg(13,'Кіт сьогодні грається',11),-100100,'group_message');process(db,unrelated)
    assert db.one('select decision from core.mentions where raw_item_id=%s',(unrelated,))['decision']=='review'
    assert db.one('select topic_id from raw.items where id=%s',(reply,))['topic_id']==10
    assert len(client.get('/api/inbox?kind=group_message').json()['items'])==4
    assert client.get(f'/api/inbox/{nested}').json()['parent']['id']==str(reply)

def test_watch_leases_errors_and_late_comments(prepared):
    db,_,_,source,_=prepared
    ident=save_item(db,source,msg(10,'Vodafone інтернет'),-100100)
    targets=due(db,source['id']);assert len(targets)==1
    assert due(db,source['id'])==[]
    fail(db,ident,'Timeout')
    state=db.one('select * from raw.watch_state where item_id=%s',(ident,))
    assert state['state']=='blocked' and state['quiet_checks']==0 and state['last_checked_at'] is None
    db.execute("update raw.watch_state set state='archived',next_check_at=null,quiet_checks=10 where item_id=%s",(ident,))
    save_item(db,source,msg(51,'У мене теж',50),-100200,'comment',10,50)
    state=db.one('select * from raw.watch_state where item_id=%s',(ident,))
    assert state['next_check_at'] and state['quiet_checks']==0
    db.execute("update raw.watch_state set state='paused',next_check_at=null where item_id=%s",(ident,))
    save_item(db,source,msg(52,'Теж так само',50),-100200,'comment',10,50)
    assert db.one('select next_check_at from raw.watch_state where item_id=%s',(ident,))['next_check_at'] is None

def create_import(client,source,input='@synthetic_group'):
    response=client.post('/api/admin/telegram/imports',json=dict(input=input,workflow_id=1,
        account_id=source['account_id'],permission_note='Synthetic fixtures, never connected',idempotency_key=str(uuid.uuid4())))
    assert response.status_code==200,response.text
    return response.json()['id']

def activate(db):
    db.execute("update core.modules set enabled=true where name='telegram'")
    db.execute('update core.telegram_accounts set enabled=true')
    db.execute('update core.workflows set enabled=true')

class FakeTelegram:
    def __init__(self,channel=None):self.channel=channel or entity();self.joins=0
    async def get_entity(self,value):return self.channel
    async def __call__(self,request):self.joins+=1;self.channel.left=False

def test_bulk_preview_idempotency_resolve_commit_and_join(prepared):
    db,client,_,source,_=prepared
    preview=client.post('/api/admin/telegram/imports/preview',json={'input':'@Synthetic_group\nhttps://t.me/synthetic_group\nhttps://t.me/+private\nhttps://evil.example/test\nhttps://t.me/channel/123\nhttps://t.me/s/another_group'})
    rows=preview.json()['rows']
    assert len(rows)==6 and [bool(r['error']) for r in rows]==[False,True,True,True,True,False]
    body=dict(input='@synthetic_group',workflow_id=1,account_id=source['account_id'],permission_note='Synthetic fixture only',idempotency_key=str(uuid.uuid4()))
    batch=client.post('/api/admin/telegram/imports',json=body).json()['id']
    assert client.post('/api/admin/telegram/imports',json=body).json()['id']==batch
    assert client.post('/api/admin/telegram/imports',json={**body,'input':'@different_group'}).status_code==409
    fake=FakeTelegram()
    assert claim(db,source['account_id']) is None  # Paused account/module cannot perform jobs.
    activate(db)
    assert asyncio.run(run_one(db,fake,source['account_id']))
    assert db.one("select state from core.telegram_jobs")['state']=='resolved'
    for _ in range(2):
        results=client.post(f'/api/admin/telegram/imports/{batch}/commit').json()['results']
        assert results[0]['status']=='added'
    assert db.one('select count(*) n from core.sources')['n']==2
    assert client.post(f'/api/admin/telegram/imports/{batch}/join').json()['queued']==1
    assert client.post(f'/api/admin/telegram/imports/{batch}/join').json()['queued']==0
    asyncio.run(run_one(db,fake,source['account_id']))
    assert fake.joins==1
    assert not asyncio.run(run_one(db,fake,source['account_id']))
    assert 'access_hash' not in client.get(f'/api/admin/telegram/imports/{batch}').text

def test_floodwait_restart_cancel_and_identity_change(prepared):
    db,client,_,source,_=prepared
    batch=create_import(client,source);activate(db)
    class Limited(FakeTelegram):
        async def get_entity(self,value):raise FloodWaitError(None,42)
    with pytest.raises(FloodWaitError):asyncio.run(run_one(db,Limited(),source['account_id']))
    job=db.one('select * from core.telegram_jobs')
    assert job['state']=='flood_wait' and claim(db,source['account_id']) is None
    client.post(f"/api/admin/telegram/jobs/{job['id']}/action",json={'action':'pause'}).raise_for_status()
    client.post(f"/api/admin/telegram/jobs/{job['id']}/action",json={'action':'resume'}).raise_for_status()
    assert db.one('select next_run_at from core.telegram_jobs')['next_run_at']==job['next_run_at']
    db.execute("update core.telegram_jobs set next_run_at=now()-interval '1 second'")
    claimed=claim(db,source['account_id'])
    db.execute("update core.telegram_jobs set lease_until=now()-interval '1 second'")
    reclaimed=claim(db,source['account_id'])
    finish(db,claimed,'resolved',{'invalid':'stale worker'})
    assert db.one('select state from core.telegram_jobs')['state']=='running'
    client.post(f"/api/admin/telegram/jobs/{job['id']}/action",json={'action':'cancel'}).raise_for_status()
    finish(db,reclaimed,'resolved')
    assert db.one('select state from core.telegram_jobs')['state']=='cancelled'
    assert client.post(f"/api/admin/telegram/jobs/{job['id']}/action",json={'action':'retry'}).status_code==409

def test_policy_controls_access_and_worker_roles(prepared):
    db,client,cfg,source,_=prepared
    ident=save_item(db,source,msg(10,'Vodafone інтернет'),-100100);process(db,ident)
    settings={k:v for k,v in DEFAULTS.items() if k!='revision'}
    assert client.put('/api/admin/telegram/policies/1',json={**settings,'sleep_days':1}).status_code==422
    client.put('/api/admin/telegram/policies/1',json=settings).raise_for_status()
    client.post(f'/api/admin/telegram/watches/{ident}',json={'mode':'pinned'}).raise_for_status()
    anonymous=httpx.Client(base_url=cfg['PUBLIC_URL'])
    assert anonymous.get('/api/admin/telegram/watches').status_code==401
    email=f'limited-{uuid.uuid4().hex[:8]}@ufv.test'
    client.post('/api/auth/admin/create-user',json={'name':'Viewer','email':email,'password':'Synthetic-password-2026!','role':'viewer'}).raise_for_status()
    anonymous.post('/api/auth/sign-in/email',json={'email':email,'password':'Synthetic-password-2026!'}).raise_for_status()
    assert anonymous.get('/api/admin/telegram/imports').status_code==403
    assert anonymous.post(f'/api/admin/telegram/watches/{ident}',json={'mode':'paused'}).status_code==403
    mention=db.one('select id from core.mentions')['id']
    assert anonymous.get(f'/api/documents/{mention}').status_code==200
    anonymous.close()
    collector=DB(cfg['COLLECTOR_DATABASE_URL'])
    item=save_item(collector,source,msg(12,'Vodafone інтернет'),-100100)
    save_snapshot(collector,item,msg(12,'Vodafone інтернет'))
    assert collector.one('select count(*) n from core.telegram_watch_policies')['n']==1
    collector.pool.close()

def test_group_context_fetch_is_bounded_and_real_reply_chain(prepared):
    db,_,_,source,_=prepared
    source['source_type']='supergroup'
    message=types.Message(id=10,peer_id=types.PeerChannel(100),date=NOW,message='У мене теж',reply_to=types.MessageReplyHeader(reply_to_msg_id=9))
    class Ancestors:
        def __init__(self):self.ids=[]
        async def get_messages(self,entity,ids):
            self.ids.append(ids)
            return types.Message(id=ids,peer_id=types.PeerChannel(100),date=NOW,message='Vodafone інтернет',reply_to=types.MessageReplyHeader(reply_to_msg_id=ids-1))
    fake=Ancestors()
    asyncio.run(Collector(db).group_context(fake,source,None,message))
    assert fake.ids==list(range(9,1,-1))
    assert db.one('select count(*) n from raw.items')['n']==8


def test_watch_discussion_error_is_not_silence_and_deleted_post_stays_deleted(prepared):
    db,_,_,source,_=prepared
    activate(db);db.execute('update core.sources set enabled=true')
    db.execute("update raw.source_state set source_type='channel'")
    collector=Collector(db);source=collector.sources(source['account_id'])[0]
    message=msg(10,'Vodafone інтернет');message.views=40
    ident=collector.record(source,message,source['peer_id'])
    db.execute("insert into raw.threads(source_id,post_id,status) values(%s,10,'error')",(source['id'],))
    class RepliesUnavailable:
        async def get_messages(self,entity,ids):return message
    asyncio.run(collector.poll_watches(RepliesUnavailable(),source,None))
    state=db.one('select * from raw.watch_state where item_id=%s',(ident,))
    assert state['state']=='blocked' and state['quiet_checks']==0
    db.execute('update raw.watch_state set next_check_at=now() where item_id=%s',(ident,))
    class Deleted:
        async def get_messages(self,entity,ids):return None
    asyncio.run(collector.poll_watches(Deleted(),source,None))
    assert db.one('select deleted from raw.items where id=%s',(ident,))['deleted']
    collector.record(source,message,source['peer_id'])
    assert db.one('select deleted from raw.items where id=%s',(ident,))['deleted']


def test_bulk_join_rechecks_stable_identity_and_account(prepared):
    db,client,_,source,_=prepared
    activate(db);batch=create_import(client,source);fake=FakeTelegram()
    asyncio.run(run_one(db,fake,source['account_id']))
    client.post(f'/api/admin/telegram/imports/{batch}/commit').raise_for_status()
    client.post(f'/api/admin/telegram/imports/{batch}/join').raise_for_status()
    fake.channel=entity(ident=201)
    asyncio.run(run_one(db,fake,source['account_id']))
    result=db.one("select state,last_error from core.telegram_jobs where kind='join'")
    assert result==dict(state='failed',last_error='SourceIdentityOrAccountChanged')
    assert fake.joins==0


def test_live_group_scope_disable_and_tombstone(prepared):
    db,_,_,source,_=prepared
    activate(db);db.execute('update core.sources set enabled=true')
    db.execute("update raw.source_state set source_type='supergroup'")
    collector=Collector(db)
    collector.live(source['account_id'],NS(chat_id=-100999,message=msg(99,'Vodafone чужа група')))
    assert db.one('select count(*) n from raw.items')['n']==0
    event=NS(chat_id=source['peer_id'],message=msg(10,'Vodafone інтернет'))
    collector.live(source['account_id'],event)
    assert db.one('select kind from raw.items')['kind']=='group_message'
    db.execute('update core.modules set enabled=false')
    collector.live(source['account_id'],NS(chat_id=source['peer_id'],message=msg(11,'Vodafone нове')))
    assert db.one('select count(*) n from raw.items')['n']==1


@pytest.mark.asyncio
async def test_manager_applies_watch_override_without_faking_observations(prepared):
    db,client,_,source,_=prepared
    ident=save_item(db,source,msg(10,'Vodafone інтернет'),-100100)
    collector=Collector(db)
    for mode,state in [('paused','paused'),('pinned','active'),('auto','active')]:
        client.post(f'/api/admin/telegram/watches/{ident}',json={'mode':mode}).raise_for_status()
        task=asyncio.create_task(collector.run())
        await asyncio.sleep(.05)
        task.cancel();await asyncio.gather(task,return_exceptions=True)
        watch=db.one('select state,last_checked_at,next_check_at from raw.watch_state where item_id=%s',(ident,))
        assert watch['state']==state and watch['last_checked_at'] is None
        assert (watch['next_check_at'] is None)==(mode=='paused')


def test_runtime_roles_and_approval_retry_does_not_resend_join(prepared):
    db,client,cfg,source,_=prepared
    activate(db);batch=create_import(client,source)
    collector=DB(cfg['COLLECTOR_DATABASE_URL']);processor=DB(cfg['PROCESSOR_DATABASE_URL'])
    fake=FakeTelegram()
    try:
        asyncio.run(run_one(collector,fake,source['account_id']))
        client.post(f'/api/admin/telegram/imports/{batch}/commit').raise_for_status()
        client.post(f'/api/admin/telegram/imports/{batch}/join').raise_for_status()
        job=db.one("update core.telegram_jobs set state='approval_pending' where kind='join' returning id")
        client.post(f"/api/admin/telegram/jobs/{job['id']}/action",json={'action':'retry'}).raise_for_status()
        asyncio.run(run_one(collector,fake,source['account_id']))
        assert fake.joins==0 and db.one("select state from core.telegram_jobs where kind='join'")['state']=='approval_pending'
        ident=save_item(collector,source,msg(10,'Vodafone інтернет'),-100100)
        process(processor,ident)
        assert len(client.get('/api/feed').json()['items'])==1
    finally:
        collector.pool.close();processor.pool.close()


def test_manual_parent_rejection_and_pending_edit_invalidate_context(prepared):
    db,client,_,source,_=prepared
    root=save_item(db,source,msg(10,'Vodafone інтернет'),-100100);process(db,root)
    child=save_item(db,source,msg(51,'У мене теж',50),-100200,'comment',10,50);process(db,child)
    mention=db.one('select id from core.mentions where raw_item_id=%s',(root,))['id']
    revision=db.one('select processor_revision from core.workflows')['processor_revision']
    client.post(f'/api/admin/documents/{mention}/review',json={'decision':'rejected'}).raise_for_status()
    assert db.one('select processor_revision from core.workflows')['processor_revision']==revision+1
    process(db,child)
    assert db.one('select decision from core.mentions where raw_item_id=%s',(child,))['decision']!='accepted'
    save_item(db,source,msg(10,'Футбол',edited=datetime.now(timezone.utc)),-100100)
    process(db,child)
    assert db.one('select decision,context_id from core.mentions where raw_item_id=%s',(child,))==dict(decision='review',context_id=None)
