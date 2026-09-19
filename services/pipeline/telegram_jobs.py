"""Durable, per-account resolve/join commands; executed by the account's sole client."""
from datetime import datetime, timedelta, timezone
import asyncio
import json
import uuid
from telethon import functions, types, utils
from telethon.errors import FloodWaitError, RPCError


def source_type(entity):
    if not isinstance(entity,types.Channel) or not entity.username:
        raise ValueError('PublicChannelOrGroupRequired')
    if getattr(entity,'broadcast',False):return 'channel'
    if getattr(entity,'megagroup',False):return 'forum' if getattr(entity,'forum',False) else 'supergroup'
    raise ValueError('UnsupportedTelegramSource')


def describe(entity):
    return {'peer_id':str(utils.get_peer_id(entity)),'username':entity.username,
            'source_type':source_type(entity),'membership':'left' if getattr(entity,'left',False) else 'member'}


def observe_access(db,account_id,result,access_hash=None):
    db.execute('''insert into raw.source_access(account_id,peer_id,username,source_type,membership,access_hash)
        values(%s,%s,%s,%s,%s,%s) on conflict(account_id,peer_id) do update
        set username=excluded.username,source_type=excluded.source_type,membership=excluded.membership,
        access_hash=coalesce(excluded.access_hash,raw.source_access.access_hash),checked_at=now()''',
        (account_id,int(result['peer_id']),result['username'],result['source_type'],result['membership'],access_hash))
    if result['membership']=='member':
        db.execute('''insert into raw.memberships(account_id,peer_id,username,title) values(%s,%s,%s,%s)
            on conflict(account_id,peer_id) do update set username=excluded.username,observed_at=now()''',
            (account_id,int(result['peer_id']),result['username'],result['username']))
    else:
        db.execute('delete from raw.memberships where account_id=%s and peer_id=%s',(account_id,int(result['peer_id'])))


def claim(db,account_id):
    token=uuid.uuid4().hex
    with db.pool.connection() as c:
        return c.execute('''with pick as (
          select j.id from core.telegram_jobs j join core.telegram_accounts a on a.id=j.account_id
          join core.workflows w on w.id=j.workflow_id left join raw.account_status s on s.account_id=a.id
          where j.account_id=%s and a.enabled and w.enabled
          and exists(select 1 from core.modules where name='telegram' and enabled)
          and (s.cooldown_until is null or s.cooldown_until<=now()) and
          ((state in ('queued','flood_wait') and next_run_at<=now()) or (state='running' and lease_until<now()))
          order by next_run_at,j.id for update of j skip locked limit 1
        ) update core.telegram_jobs j set state='running',attempts=attempts+1,
          lease_token=%s,lease_until=now()+interval '60 seconds',updated_at=now()
          from pick where j.id=pick.id returning j.*''',(account_id,token)).fetchone()


def finish(db,job,state,result=None,error=None,delay=0):
    db.execute('''update core.telegram_jobs set state=%s,result=%s,last_error=%s,next_run_at=now()+make_interval(secs=>%s),
        lease_token=null,lease_until=null,updated_at=now() where id=%s and lease_token=%s and state='running' ''',
        (state,json.dumps(result or {}),error,delay,job['id'],job['lease_token']))


async def run_one(db,client,account_id):
    job=claim(db,account_id)
    if not job:return False
    try:
        entity=await asyncio.wait_for(client.get_entity(job['username']),25)
        result=describe(entity)
        observe_access(db,account_id,result,getattr(entity,'access_hash',None))
        if job['kind']=='resolve':
            finish(db,job,'resolved',result)
            return True
        source=db.one('select telegram_peer_id,account_id from core.sources where id=%s',(job['source_id'],))
        if not source or source['account_id']!=account_id or (source['telegram_peer_id'] and str(source['telegram_peer_id'])!=result['peer_id']):
            finish(db,job,'failed',error='SourceIdentityOrAccountChanged')
            return True
        current=db.one('''select j.state,j.lease_token,a.enabled account_enabled,w.enabled workflow_enabled
            from core.telegram_jobs j join core.telegram_accounts a on a.id=j.account_id
            join core.workflows w on w.id=j.workflow_id where j.id=%s''',(job['id'],))
        if not current or current['state']!='running' or current['lease_token']!=job['lease_token'] or not current['account_enabled'] or not current['workflow_enabled'] or not db.enabled():
            finish(db,job,'queued',result,delay=5)
            return True
        if result['membership']=='member':
            finish(db,job,'already_joined',result)
        elif job['result'].get('membership_check_only'):
            finish(db,job,'approval_pending',result,error='Членство ще не підтверджено; повторну заявку не надсилали')
        else:
            await asyncio.wait_for(client(functions.channels.JoinChannelRequest(entity)),25)
            result['membership']='member'
            observe_access(db,account_id,result)
            finish(db,job,'joined',result)
        # Conservative spacing, not a claimed Telegram limit. FloodWait always wins.
        db.execute("update core.telegram_jobs set next_run_at=greatest(next_run_at,now()+interval '20 seconds') where account_id=%s and kind='join' and state='queued'",(account_id,))
    except FloodWaitError as exc:
        finish(db,job,'flood_wait',error=f'FloodWait: {exc.seconds} с',delay=exc.seconds+1)
        raise
    except RPCError as exc:
        name=type(exc).__name__
        if name=='InviteRequestSentError':
            finish(db,job,'approval_pending',error='Заявку на вступ надіслано; очікуємо рішення адміністратора')
        elif name=='UserAlreadyParticipantError':
            finish(db,job,'already_joined')
        elif getattr(exc,'code',0)>=500 and job['attempts']<3:
            finish(db,job,'queued',error=name,delay=20*job['attempts'])
        else:
            finish(db,job,'failed',error=name)
    except ValueError as exc:
        finish(db,job,'failed',error=str(exc) if str(exc) in ('PublicChannelOrGroupRequired','UnsupportedTelegramSource') else 'SourceNotFound')
    except Exception as exc:
        finish(db,job,'queued' if job['attempts']<3 else 'failed',error=type(exc).__name__,delay=min(300,20*job['attempts']))
    return True
