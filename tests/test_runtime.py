"""Integration checks on an isolated PostgreSQL database and real Hono API.

Configure UFV_TEST_ENV with a JSON environment file. No Telegram account is contacted.
"""
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import uuid

import httpx
import pytest
from telethon.crypto import AuthKey
from telethon.sessions import StringSession
from telethon import types
from telethon.errors import FloodWaitError

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'services'))
from pipeline.db import DB, decrypt
from pipeline.raw import save_item, delete_items
from pipeline.processor import process, consume
from pipeline.telegram import Collector
from pipeline.bus import publish_outbox, connect


@pytest.fixture(scope='module')
def runtime():
    path=Path(os.getenv('UFV_TEST_ENV','/tmp/ufv-checks-env.json'))
    if not path.exists():
        pytest.skip('Integration environment not configured')
    cfg=json.loads(path.read_text())
    assert cfg['DATABASE_URL'].endswith('/ufv_checks'), 'Never run fixture resets on a real database'
    db=DB(cfg['DATABASE_URL'])
    db.execute('truncate auth."rateLimit"')  # Reset only the isolated test database.
    client=httpx.Client(base_url=cfg['PUBLIC_URL'],headers={'Origin':cfg['PUBLIC_URL']})
    login=client.post('/api/auth/sign-in/email',json={'email':'admin@ufv.test','password':cfg['ADMIN_PASSWORD']})
    assert login.status_code==200
    yield db,client,cfg
    client.close();db.pool.close()


@pytest.fixture
def prepared(runtime):
    db,client,cfg=runtime
    db.execute('truncate auth."rateLimit"')
    db.execute('truncate core.workflows,core.telegram_accounts,core.modules,core.audit restart identity cascade')
    db.execute("insert into core.workflows(name) values('Synthetic verification workflow')")
    db.execute("insert into core.modules values('telegram',false)")
    s=StringSession();s.set_dc(2,'149.154.167.50',443);s.auth_key=AuthKey(os.urandom(256))
    payload={'label':'Synthetic session — disabled','api_id':123,'api_hash':'a'*32,'session':s.save(),'enabled':False}
    response=client.post('/api/admin/accounts',json=payload)
    assert response.status_code==200,response.text
    aid=int(response.json()['id'])
    response=client.post('/api/admin/channels',json={'workflow_id':1,'account_id':aid,'username':'synthetic_test','permission_note':'Only synthetic fixture messages, no Telegram connection','enabled':False})
    assert response.status_code==200,response.text
    sid=int(response.json()['id'])
    db.execute('insert into raw.source_state(source_id,peer_id) values(%s,-100100)',(sid,))
    source=db.one('select s.*,r.peer_id from core.sources s join raw.source_state r on r.source_id=s.id where s.id=%s',(sid,))
    return db,client,cfg,source,payload


def msg(mid,text,reply=None,edited=None):
    return SimpleNamespace(id=mid,message=text,date=datetime.now(timezone.utc),edit_date=edited,
                           reply_to=SimpleNamespace(reply_to_msg_id=reply) if reply else None)


def test_cross_language_vault_no_secret_output_and_idempotency(prepared,monkeypatch):
    db,client,cfg,source,payload=prepared
    monkeypatch.setenv('TG_SESSION_KEY',cfg['TG_SESSION_KEY'])
    stored=db.one('select session,api_hash from core.telegram_accounts')
    assert decrypt(stored['session'])==payload['session']
    assert decrypt(stored['api_hash'])==payload['api_hash']
    response=client.get('/api/admin/state')
    assert response.status_code==200
    output=response.text
    assert payload['session'] not in output and 'api_hash' not in output
    assert client.post('/api/admin/accounts',json=payload).status_code==409
    item=save_item(db,source,msg(10,'Vodafone інтернет зник'),-100100)
    for _ in range(3):
        assert save_item(db,source,msg(10,'Vodafone інтернет зник'),-100100)==item
        process(db,item)
    assert db.one('select count(*) n from raw.items')['n']==1
    assert db.one('select count(*) n from raw.outbox')['n']==1
    assert db.one('select count(*) n from core.mentions')['n']==1


def test_thread_context_spam_ad_and_deletion(prepared):
    db,client,cfg,s,_=prepared
    post=save_item(db,s,msg(10,'Vodafone: збій інтернету'),-100100);process(db,post)
    comment=save_item(db,s,msg(51,'У мене теж не працює',50),-100200,'comment',10,50);process(db,comment)
    nested=save_item(db,s,msg(52,'Теж так само',51),-100200,'comment',10,50);process(db,nested)
    spam=save_item(db,s,msg(53,'Казино бонус Vodafone',50),-100200,'comment',10,50);process(db,spam)
    ad=save_item(db,s,msg(54,'Промокод на інтернет',50),-100200,'comment',10,50);process(db,ad)
    assert db.one('select decision from core.mentions where raw_item_id=%s',(nested,))['decision']=='accepted'
    assert db.one('select decision from core.mentions where raw_item_id=%s',(spam,))['decision']=='rejected'
    assert db.one('select decision from core.mentions where raw_item_id=%s',(ad,))['decision']=='review'
    before=db.one('select count(*) n from core.mentions')['n']
    save_item(db,s,msg(10,'Vodafone відновив інтернет',edited=datetime.now(timezone.utc)),-100100);process(db,post)
    assert db.one('select count(*) n from core.mentions')['n']==before
    assert db.one('select count(*) n from core.processing_receipts where raw_item_id=%s',(comment,))['n']==0
    process(db,comment);process(db,nested)
    assert client.post('/api/admin/workflows/1/reprocess').status_code==200
    delete_items(db,s['account_id'],-100100,[10])
    for row in db.all('select id from raw.items'):
        process(db,row['id'])
    assert db.one("select count(*) n from core.mentions where not deleted")['n']==0
    assert db.one("select count(*) n from raw.items where text<>''")['n']==0


def test_roles_origins_share_scope_revocation(prepared):
    db,client,cfg,s,_=prepared
    for ident,kind in [(10,'post'),(51,'comment')]:
        process(db,save_item(db,s,msg(ident,'Vodafone інтернет'),-100100 if kind=='post' else -100200,kind,10))
    anonymous=httpx.Client(base_url=cfg['PUBLIC_URL'])
    assert anonymous.get('/api/feed').status_code==401
    assert client.post('/api/admin/module',json={'enabled':True},headers={'Origin':'https://other.example'}).status_code==403
    email=f'viewer-{uuid.uuid4().hex[:8]}@ufv.test'
    response=client.post('/api/auth/admin/create-user',json={'name':'Test viewer','email':email,'password':'Synthetic-checks-password!','role':'viewer'})
    assert response.status_code==200,response.text
    viewer=httpx.Client(base_url=cfg['PUBLIC_URL'])
    assert viewer.post('/api/auth/sign-in/email',json={'email':email,'password':'Synthetic-checks-password!'}).status_code==200
    assert viewer.get('/api/admin/state').status_code==403
    assert viewer.get('/api/feed').status_code==200
    assert viewer.post('/api/auth/admin/create-user',json={'name':'No','email':'no@ufv.test','password':'Test-test-test','role':'admin'}).status_code==403
    shared=client.post('/api/admin/shares',json={'workflow_id':1,'name':'Post-only checks','scope':'posts','channel_ids':[s['id']]}).json()
    assert anonymous.post('/api/shared/redeem',json={'token':shared['url'].split('#')[1]}).status_code==200
    anonymous.headers['x-ufv-share-scope']=str(shared['id'])
    items=anonymous.get('/api/shared/feed').json()['items']
    assert len(items)==1 and items[0]['kind']=='post'
    comment=db.one("select id from core.mentions where kind='comment'")['id']
    assert anonymous.get('/api/shared/documents/'+str(comment)).status_code==404
    assert anonymous.get('/api/shared/feed?workflow_id=2').status_code==403
    assert client.delete('/api/admin/shares/'+str(shared['id'])).status_code==200
    assert anonymous.get('/api/shared/feed').status_code==401
    summary=client.post('/api/admin/shares',json={'workflow_id':1,'name':'Summary','scope':'summary'}).json()
    anonymous.post('/api/shared/redeem',json={'token':summary['url'].split('#')[1]})
    anonymous.headers['x-ufv-share-scope']=str(summary['id'])
    assert anonymous.get('/api/shared/feed').json()['items']==[]
    assert anonymous.get('/api/shared/feed?q=Vodafone').status_code==403
    assert anonymous.get('/api/shared/documents/1').status_code==403
    anonymous.close();viewer.close()


def test_shared_requests_bound_to_redeemed_link(prepared):
    _,client,cfg,_,_=prepared
    broad=client.post('/api/admin/shares',json={'workflow_id':1,'name':'Broad binding checks','scope':'full'}).json()
    narrow=client.post('/api/admin/shares',json={'workflow_id':1,'name':'Narrow binding checks','scope':'summary'}).json()
    with httpx.Client(base_url=cfg['PUBLIC_URL']) as public:
        response=public.post('/api/shared/redeem',json={'token':broad['url'].split('#')[1]})
        assert response.status_code==200
        assert response.json()['scope_id']==str(broad['id'])
        old_cookies=httpx.Cookies(public.cookies)
        assert public.get('/api/shared/feed').status_code==409
        assert public.get('/api/shared/me').json()['scope_id']==str(broad['id'])
        public.post('/api/shared/redeem',json={'token':narrow['url'].split('#')[1]})
        public.headers['x-ufv-share-scope']=str(narrow['id'])
        assert public.get('/api/shared/feed').status_code==200
        assert public.get('/api/shared/me').json()['scope_id']==str(narrow['id'])
        # An older Set-Cookie, or another tab, must not expand the bound scope.
        public.cookies=old_cookies
        for path in ['/api/shared/me','/api/shared/feed','/api/shared/feed?q=Vodafone','/api/shared/documents/1']:
            response=public.get(path)
            assert response.status_code==409
            assert response.json()=={'error':'share_scope_changed'}


@pytest.mark.asyncio
async def test_postgres_cursors_restart_and_flood_wait(prepared,monkeypatch):
    db,client,cfg,s,_=prepared
    db.execute('insert into raw.threads(source_id,post_id,discussion_id,root_id) values(%s,10,-100200,50)',(s['id'],))
    class Fake:
        async def iter_messages(self,entity,**kwargs):
            for ident in [51,52]:
                if ident>kwargs.get('min_id',0):
                    yield types.Message(id=ident,peer_id=types.PeerChannel(200),date=datetime.now(timezone.utc),message='Vodafone інтернет')
    for _ in range(2):
        await Collector(db).poll_thread(Fake(),s,'entity',db.one('select * from raw.threads'))
    assert db.one('select comment_cursor from raw.threads')['comment_cursor']==52
    assert db.one('select count(*) n from raw.items')['n']==2
    class Limited:
        async def iter_messages(self,entity,**kwargs):
            raise FloodWaitError(None,capture=120)
            yield
    with pytest.raises(FloodWaitError):
        await Collector(db).poll_thread(Limited(),s,'entity',db.one('select * from raw.threads'))
    assert db.one('select comment_cursor from raw.threads')['comment_cursor']==52
    def no_connection(*args,**kwargs):raise AssertionError('Disabled module connected')
    monkeypatch.setattr('pipeline.telegram.TelegramClient',no_connection)
    await Collector(db).run_account(db.one('select * from core.telegram_accounts'))


@pytest.mark.asyncio
async def test_real_jetstream_outbox_to_processor(prepared,monkeypatch):
    db,client,cfg,s,_=prepared
    for key in ['NATS_URL','UFV_NATS_STREAM','UFV_NATS_SUBJECT']:
        monkeypatch.setenv(key,cfg[key])
    nc,js=await connect()
    # A purge retains JetStream deduplication IDs; fixture IDs restart at 1.
    await js.delete_stream(cfg['UFV_NATS_STREAM'])
    await js.add_stream(name=cfg['UFV_NATS_STREAM'],subjects=[cfg['UFV_NATS_SUBJECT']])
    item=save_item(db,s,msg(10,'Vodafone інтернет: тестовий матеріал'),-100100)
    publisher=asyncio.create_task(publish_outbox(db));processor=asyncio.create_task(consume(db))
    try:
        for _ in range(60):
            if db.one('select id from core.mentions where raw_item_id=%s',(item,)):
                break
            await asyncio.sleep(.1)
        else:pytest.fail('NATS delivery did not reach processor')
        assert db.one('select published_at from raw.outbox')['published_at'] is not None
        assert db.one('select decision from core.mentions')['decision']=='accepted'
    finally:
        publisher.cancel();processor.cancel();await asyncio.gather(publisher,processor,return_exceptions=True)
        await js.delete_stream(cfg['UFV_NATS_STREAM']);await nc.close()


def test_api_recovers_terminated_database_connections(runtime):
    db,client,cfg=runtime
    assert client.get('/api/me').status_code==200
    db.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and usename='ufv_api' and pid<>pg_backend_pid()")
    import time
    time.sleep(.2)
    assert client.get('/api/health').status_code==200
    assert client.get('/api/me').status_code==200


def test_prepare_two_accounts_is_idempotent_and_cannot_enable_draft(runtime):
    db,client,cfg=runtime
    db.execute('truncate core.workflows,core.telegram_accounts,core.modules,core.audit restart identity cascade')
    db.execute("insert into core.workflows(name) values('Synthetic workflow')")
    db.execute("insert into core.modules values('telegram',false)")
    for _ in range(2):
        r=client.post('/api/admin/accounts/prepare')
        assert r.status_code==200
        assert len(r.json()['accounts'])==2
    state=client.get('/api/admin/state').json()
    assert all(not a['credentials_ready'] and not a['enabled'] and a['status']=='setup_required' for a in state['accounts'])
    assert client.post('/api/admin/accounts/1/toggle',json={'enabled':True}).status_code==422
    assert db.one('select count(*) n from core.telegram_accounts')['n']==2
    session=StringSession();session.set_dc(2,'149.154.167.50',443);session.auth_key=AuthKey(os.urandom(256))
    imported=client.put('/api/admin/accounts/1',json={'label':'Telegram 1','api_id':123,'api_hash':'a'*32,'session':session.save(),'enabled':False})
    assert imported.status_code==200
    assert client.get('/api/admin/state').json()['accounts'][0]['credentials_ready'] is True


def test_inbox_includes_pending_rejected_context_and_all_workflows(prepared):
    db,client,cfg,s,_=prepared
    post=save_item(db,s,msg(10,'Vodafone інтернет'),-100100)
    response=client.get('/api/inbox').json()
    assert len(response['items'])==1 and response['items'][0]['state']=='pending'
    assert client.get('/api/feed').json()['items']==[]
    process(db,post)
    spam=save_item(db,s,msg(51,'Казино бонус',50),-100200,'comment',10,50);process(db,spam)
    assert {i['state'] for i in client.get('/api/inbox').json()['items']}=={'accepted','rejected'}
    context=client.get(f'/api/inbox/{spam}').json()['parent']
    assert context['id']==str(post)
    assert len(client.get('/api/inbox?state=rejected').json()['items'])==1
    save_item(db,s,msg(10,'Редагований текст',edited=datetime.now(timezone.utc)),-100100)
    changed=client.get(f'/api/inbox/{post}').json()['item']
    assert changed['state']=='pending' and changed['text']=='Редагований текст'
    workflow=db.one("insert into core.workflows(name) values('Second fixture') returning id")
    other=db.one("insert into core.sources(kind,external_id,workflow_id) values('telegram','second_fixture',%s) returning *",(workflow['id'],))
    other['peer_id']=-100300
    second=save_item(db,other,msg(20,'Інтернет'),-100300)
    assert len(client.get('/api/inbox').json()['items'])==3
    assert len(client.get('/api/inbox?workflow_id=1').json()['items'])==2
    anonymous=httpx.Client(base_url=cfg['PUBLIC_URL'])
    assert anonymous.get('/api/inbox').status_code==401
    viewer_email=f'inbox-viewer-{uuid.uuid4().hex[:8]}@ufv.test'
    response=client.post('/api/auth/admin/create-user',json={'name':'Viewer','email':viewer_email,'password':'Synthetic-inbox-password!','role':'viewer'})
    assert response.status_code==200
    assert anonymous.post('/api/auth/sign-in/email',json={'email':viewer_email,'password':'Synthetic-inbox-password!'}).status_code==200
    assert anonymous.get('/api/inbox').status_code==403
    assert anonymous.get(f'/api/inbox/{second}').status_code==403
    anonymous.close()


def test_recovered_session_completes_without_reauthentication(runtime, monkeypatch):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
    from telegram_setup import register_session
    db, client, cfg = runtime
    db.execute('truncate core.workflows,core.telegram_accounts,core.modules,core.audit restart identity cascade')
    db.execute("insert into core.modules values('telegram',false)")
    client.post('/api/admin/accounts/prepare').raise_for_status()
    memory = StringSession(); memory.set_dc(2,'149.154.167.50',443); memory.auth_key = AuthKey(os.urandom(256))
    secret = memory.save()
    config = {'url':cfg['SERVER_DATABASE_URL'], 'key':cfg['TG_SESSION_KEY']}
    monkeypatch.setenv('TG_SESSION_KEY',cfg['TG_SESSION_KEY'])
    assert register_session(config,secret,account_id=1)['enabled'] is False
    state = client.get('/api/admin/state').json()['accounts'][0]
    assert state['has_session'] and not state['credentials_ready']
    assert state['status'] == 'api_credentials_required'
    assert client.post('/api/admin/accounts/1/toggle',json={'enabled':True}).status_code == 422
    assert client.post('/api/admin/accounts/2/credentials',json={'api_id':123,'api_hash':'b'*32}).status_code == 422
    response = client.post('/api/admin/accounts/1/credentials',json={'api_id':123,'api_hash':'b'*32})
    assert response.status_code == 200
    stored = db.one('select * from core.telegram_accounts where id=1')
    assert stored['enabled'] and decrypt(stored['session']) == secret
    assert decrypt(stored['api_hash']) == 'b'*32
    assert register_session(config,secret)['id'] == 1
    assert db.one('select count(*) n from core.telegram_accounts')['n'] == 2
    with pytest.raises(ValueError,match='іншого акаунта'):
        register_session(config,secret,account_id=2)
    memory.auth_key = AuthKey(os.urandom(256))
    with pytest.raises(ValueError,match='зайняте'):
        register_session(config,memory.save(),123,'b'*32,account_id=1)
    second = register_session(config,memory.save(),123,'b'*32)
    assert second['id'] == 2 and second['enabled']
    output = client.get('/api/admin/state').text
    assert secret not in output and 'b'*32 not in output


@pytest.mark.asyncio
async def test_cli_persists_login_and_recovers_db_failure_without_otp(runtime, monkeypatch, tmp_path, capsys):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
    import create_session
    import telegram_setup
    db, client, cfg = runtime
    db.execute('truncate core.workflows,core.telegram_accounts,core.modules,core.audit restart identity cascade')
    client.post('/api/admin/accounts/prepare').raise_for_status()
    config = {'url':cfg['SERVER_DATABASE_URL'], 'key':cfg['TG_SESSION_KEY']}
    monkeypatch.setattr(create_session,'server_config',lambda:config)
    monkeypatch.setattr(create_session,'saved_api_credentials',lambda _: (123,'c'*32))
    monkeypatch.setattr(telegram_setup,'RECOVERY_DIR',tmp_path/'recovery')
    memory=StringSession();memory.set_dc(2,'149.154.167.50',443);memory.auth_key=AuthKey(os.urandom(256))
    class FakeClient:
        starts = 0
        disconnected = False
        def __init__(self,*args): self.session = memory
        async def start(self,**kwargs): FakeClient.starts += 1
        async def disconnect(self): FakeClient.disconnected = True
    monkeypatch.setattr(create_session,'TelegramClient',FakeClient)
    def failed_register(*args):
        assert FakeClient.disconnected, 'Collector must never share an active login client'
        raise ConnectionError('Synthetic DB outage')
    monkeypatch.setattr(create_session,'register_session',failed_register)
    args=SimpleNamespace(new_api=False,account=1,import_file=None,recover_file=None)
    with pytest.raises(ConnectionError):
        await create_session.main(args)
    backup,=list((tmp_path/'recovery').glob('*.gcm'))
    assert backup.stat().st_mode & 0o777 == 0o600
    assert memory.save() not in backup.read_text()
    payload=json.loads(telegram_setup.decrypt(backup.read_text(),config['key']))
    assert payload['session']==memory.save() and payload['api_hash']=='c'*32
    monkeypatch.setattr(create_session,'register_session',telegram_setup.register_session)
    args.recover_file=str(backup)
    await create_session.main(args)
    assert FakeClient.starts == 1, 'Recovery must not request another Telegram login'
    assert db.one('select enabled from core.telegram_accounts where id=1')['enabled']
    assert len(list((tmp_path/'recovery').glob('*.gcm'))) == 1, 'Temporary second backup removed after commit'
    output=capsys.readouterr().out
    assert memory.save() not in output and 'c'*32 not in output
    assert 'додано безпосередньо до сайту' in output
