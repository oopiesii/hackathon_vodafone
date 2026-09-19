import asyncio
import logging
from datetime import datetime, timedelta, timezone

from telethon import TelegramClient, events, functions, types, utils
from telethon.errors import FloodWaitError, RPCError
from telethon.sessions import StringSession
from psycopg.errors import UniqueViolation

from .bus import publish_outbox
from .db import DB, decrypt
from .raw import save_item, delete_items
from .metrics import save_snapshot
from . import watch
from .refresh import apply_refresh_requests
from .telegram_jobs import source_type, describe, observe_access, run_one

log=logging.getLogger('pipeline.telegram')


class Collector:
    def __init__(self, db):
        self.db=db
        self.tasks={}

    def status(self, aid, status, error=None, cooldown=None):
        self.db.execute('''insert into raw.account_status(account_id,status,last_error,cooldown_until,checked_at)
            values(%s,%s,%s,%s,now()) on conflict(account_id) do update set status=excluded.status,
            last_error=excluded.last_error,cooldown_until=coalesce(excluded.cooldown_until,raw.account_status.cooldown_until),checked_at=now()''',
            (aid,status,error,cooldown))

    def sources(self, aid):
        if not self.db.enabled():
            return []
        return self.db.all('''select s.*,coalesce(r.peer_id,s.telegram_peer_id) peer_id,r.source_type,r.username current_username,r.post_cursor,r.last_polled_at,w.comments_enabled,w.poll_seconds
            from core.sources s join core.workflows w on w.id=s.workflow_id
            join core.telegram_accounts a on a.id=s.account_id left join raw.source_state r on r.source_id=s.id
            where s.account_id=%s and s.kind='telegram' and s.enabled and a.enabled and w.enabled
            and length(s.permission_note)>=10 order by s.id''',(aid,))

    async def stop(self, aid):
        item=self.tasks.pop(aid,None)
        if item:
            item[1].cancel()
            await asyncio.gather(item[1],return_exceptions=True)

    async def run(self):
        try:
            while True:
                try:
                    apply_refresh_requests(self.db, 'telegram')
                except Exception as exc:
                    log.warning('refresh retry: %s', type(exc).__name__)
                accounts=self.db.all('''select a.*,s.cooldown_until from core.telegram_accounts a
                    left join raw.account_status s on s.account_id=a.id where a.enabled and a.session is not null and a.api_id is not null and a.api_hash is not null''') if self.db.enabled() else []
                wanted={a['id']:a for a in accounts}
                # Applying a setting is not a successful Telegram observation.
                self.db.execute("""update raw.watch_state w set next_check_at=case when o.mode='paused' then null else now() end,
                    state=case when o.mode='paused' then 'paused' else 'active' end,quiet_checks=0,
                    reason=case when o.mode='paused' then 'Призупинено адміністратором' else 'Змінено ручний пріоритет' end,
                    override_applied_at=o.updated_at from core.telegram_watch_overrides o
                    where w.item_id=o.item_id and w.state<>'deleted'
                    and (w.override_applied_at is null or w.override_applied_at<o.updated_at)""")
                self.db.execute("""update raw.watch_state w set next_check_at=now(),policy_revision=p.revision
                    from core.telegram_watch_policies p,raw.items i,core.sources s
                    where w.item_id=i.id and i.source_id=s.id and s.workflow_id=p.workflow_id
                    and w.policy_revision<>p.revision and w.state not in ('paused','deleted')""")
                for aid,(revision,task) in list(self.tasks.items()):
                    if aid not in wanted or wanted[aid]['revision']!=revision:
                        await self.stop(aid)
                for aid,account in wanted.items():
                    if account['cooldown_until'] and account['cooldown_until']>datetime.now(timezone.utc):
                        continue
                    if aid not in self.tasks or self.tasks[aid][1].done():
                        self.tasks[aid]=(account['revision'],asyncio.create_task(self.run_account(account)))
                self.db.execute("insert into raw.service_status(name,detail) values('collector-telegram',%s) on conflict(name) do update set heartbeat_at=now(),detail=excluded.detail",
                                ('enabled' if self.db.enabled() else 'disabled',))
                await asyncio.sleep(2)
        finally:
            for aid in list(self.tasks):
                await self.stop(aid)

    async def discover(self, client, aid):
        rows=[]
        async for dialog in client.iter_dialogs(limit=1000):
            entity=dialog.entity
            if isinstance(entity,types.Channel) and entity.username and (entity.broadcast or entity.megagroup):
                rows.append((aid,utils.get_peer_id(entity),entity.username,entity.title))
        with self.db.pool.connection() as conn:
            conn.execute('delete from raw.memberships where account_id=%s',(aid,))
            for row in rows:
                conn.execute('insert into raw.memberships(account_id,peer_id,username,title) values(%s,%s,%s,%s)',row)

    async def run_account(self, account):
        aid=account['id'];client=None
        try:
            if not self.db.enabled():
                return
            session=StringSession(decrypt(account['session']))
            session.save_entities=False
            client=TelegramClient(session,account['api_id'],decrypt(account['api_hash']),flood_sleep_threshold=0,
                request_retries=1,connection_retries=2,sequential_updates=True,catch_up=True,device_model='Vodafone monitoring prototype')
            self.status(aid,'connecting')
            await asyncio.wait_for(client.connect(),25)
            if not await asyncio.wait_for(client.is_user_authorized(),25):
                self.status(aid,'unauthorized','Потрібна нова авторизована сесія',datetime.now(timezone.utc)+timedelta(minutes=10))
                return
            await asyncio.wait_for(self.discover(client,aid),60)
            self.status(aid,'online')
            async def on_message(event):
                try:
                    self.live(aid,event)
                except Exception as exc:
                    log.warning('event account=%s error=%s',aid,type(exc).__name__)
            async def on_delete(event):
                delete_items(self.db,aid,event.chat_id,event.deleted_ids)
            client.add_event_handler(on_message,events.NewMessage())
            client.add_event_handler(on_message,events.MessageEdited())
            client.add_event_handler(on_delete,events.MessageDeleted())
            await asyncio.wait_for(client.catch_up(),30)
            entities={}
            while True:
                await run_one(self.db,client,aid)
                for source in self.sources(aid):
                    last=source['last_polled_at']
                    if last and (datetime.now(timezone.utc)-last).total_seconds()<source['poll_seconds']:
                        continue
                    try:
                        entity=entities.get(source['id'])
                        if not entity:
                            access=self.db.one('select access_hash from raw.source_access where account_id=%s and peer_id=%s',(aid,source['peer_id'])) if source['peer_id'] else None
                            target=types.InputPeerChannel(utils.resolve_id(source['peer_id'])[0],access['access_hash']) if access and access['access_hash'] is not None else (source.get('current_username') or source['external_id'])
                            entity=await asyncio.wait_for(client.get_entity(target),25)
                            kind=source_type(entity)
                            source['source_type']=kind
                            source['current_username']=entity.username
                            observe_access(self.db,aid,describe(entity),getattr(entity,'access_hash',None))
                            peer=utils.get_peer_id(entity)
                            if source['peer_id'] and source['peer_id']!=peer:
                                raise ValueError('ChannelIdentityChanged')
                            source['peer_id']=peer
                            self.db.execute('''insert into raw.source_state(source_id,peer_id,title,source_type,username) values(%s,%s,%s,%s,%s)
                                on conflict(source_id) do update set title=excluded.title,source_type=excluded.source_type,username=excluded.username,peer_id=excluded.peer_id''',(source['id'],peer,entity.title,kind,entity.username))
                            entities[source['id']]=entity
                        await asyncio.wait_for(self.poll_source(client,source,entity),60)
                        await asyncio.wait_for(self.poll_watches(client,source,entity),60)
                    except FloodWaitError:
                        raise
                    except (RPCError,ValueError,TimeoutError,UniqueViolation) as exc:
                        self.source_status(source['id'],'error',str(exc) if isinstance(exc,ValueError) else type(exc).__name__)
                    await asyncio.sleep(1)
                await asyncio.sleep(2)
        except asyncio.CancelledError:
            if self.db.one('select id from core.telegram_accounts where id=%s',(aid,)):
                self.status(aid,'stopped')
            raise
        except FloodWaitError as exc:
            self.status(aid,'flood_wait',f'FloodWait: {exc.seconds} с',datetime.now(timezone.utc)+timedelta(seconds=exc.seconds+1))
        except Exception as exc:
            self.status(aid,'error',type(exc).__name__,datetime.now(timezone.utc)+timedelta(seconds=60))
            log.warning('account=%s error=%s',aid,type(exc).__name__)
        finally:
            if client:
                await client.disconnect()

    def source_status(self, ident, status, error=None):
        self.db.execute('''insert into raw.source_state(source_id,status,last_error,last_polled_at) values(%s,%s,%s,now())
            on conflict(source_id) do update set status=excluded.status,last_error=excluded.last_error,last_polled_at=now()''',
            (ident,status,error))

    def record(self,source,message,peer_id,kind='post',post_id=None,root_id=None,collect_metrics=True):
        ident=save_item(self.db,source,message,peer_id,kind,post_id,root_id)
        state=self.db.one('select state from raw.watch_state where item_id=%s',(ident,))
        if collect_metrics and (not state or state['state'] not in ('paused','archived','deleted')):
            save_snapshot(self.db,ident,message)
        return ident

    def live(self, aid, event):
        for source in self.sources(aid):
            if event.chat_id==source['peer_id'] and source.get('source_type') in ('channel','supergroup','forum'):
                self.record(source,event.message,event.chat_id,'group_message' if source.get('source_type') in ('supergroup','forum') else 'post')
            elif source['comments_enabled']:
                reply=getattr(event.message,'reply_to',None)
                top=getattr(reply,'reply_to_top_id',None) or getattr(reply,'reply_to_msg_id',None)
                if not top:
                    continue
                thread=self.db.one("select * from raw.threads where source_id=%s and discussion_id=%s and root_id=%s and status!='deleted'",(source['id'],event.chat_id,top))
                if not thread:
                    parent=self.db.one('select thread_item_id from raw.items where source_id=%s and source_item_id=%s',(source['id'],f'{event.chat_id}:{top}'))
                    if parent:
                        thread=self.db.one("select * from raw.threads where source_id=%s and post_id=%s and status!='deleted'",(source['id'],int(parent['thread_item_id'].split(':')[1])))
                if thread:
                    self.record(source,event.message,event.chat_id,'comment',thread['post_id'],thread['root_id'])

    async def group_context(self,client,source,entity,message):
        """Recover a bounded real ancestor chain, never adjacent unrelated messages."""
        seen={message.id}
        for _ in range(8):
            parent_id=getattr(getattr(message,'reply_to',None),'reply_to_msg_id',None)
            if not parent_id or parent_id in seen:
                return
            seen.add(parent_id)
            if self.db.one('select id from raw.items where source_id=%s and source_item_id=%s',
                           (source['id'],f"{source['peer_id']}:{parent_id}")):
                return
            message=await asyncio.wait_for(client.get_messages(entity,ids=parent_id),20)
            if not isinstance(message,types.Message):
                return
            self.record(source,message,source['peer_id'],'group_message')

    async def ensure_thread(self,client,source,entity,message):
        replies=getattr(message,'replies',None)
        if not replies or not getattr(replies,'comments',False):
            return
        self.db.execute('insert into raw.threads(source_id,post_id) values(%s,%s) on conflict do nothing',(source['id'],message.id))
        thread=self.db.one('select * from raw.threads where source_id=%s and post_id=%s',(source['id'],message.id))
        if not thread['root_id'] and thread['status']!='deleted':
            await self.resolve_thread(client,entity,thread)

    async def resolve_thread(self,client,entity,thread):
        result=await client(functions.messages.GetDiscussionMessageRequest(entity,thread['post_id']))
        if not result.messages:
            raise ValueError('DiscussionUnavailable')
        root=result.messages[-1]
        self.db.execute("update raw.threads set discussion_id=%s,root_id=%s,status='pending',last_error=null where id=%s",
                        (utils.get_peer_id(root.peer_id),root.id,thread['id']))
        return self.db.one('select * from raw.threads where id=%s',(thread['id'],))

    async def poll_source(self,client,source,entity):
        cursor=source['post_cursor'] or 0
        async for message in client.iter_messages(entity,min_id=cursor,reverse=True,
                offset_date=source['history_since'] if not cursor else None,limit=100,wait_time=1):
            if not any(s['id']==source['id'] for s in self.sources(source['account_id'])):
                return
            if isinstance(message,types.Message):
                self.record(source,message,source['peer_id'],'group_message' if source.get('source_type') in ('supergroup','forum') else 'post')
                if source.get('source_type') in ('supergroup','forum'):
                    await self.group_context(client,source,entity,message)
                if source['comments_enabled'] and source.get('source_type') not in ('supergroup','forum'):
                    try:
                        await self.ensure_thread(client,source,entity,message)
                    except FloodWaitError:
                        raise
                    except (RPCError,ValueError):
                        pass  # Persistent unresolved thread will be retried independently.
            self.db.execute('update raw.source_state set post_cursor=greatest(post_cursor,%s) where source_id=%s',(message.id,source['id']))
        async for message in client.iter_messages(entity,limit=10,wait_time=1):
            if isinstance(message,types.Message) and message.date>=source['history_since']:
                self.record(source,message,source['peer_id'],'group_message' if source.get('source_type') in ('supergroup','forum') else 'post')
                if source.get('source_type') in ('supergroup','forum'):
                    await self.group_context(client,source,entity,message)
                if source['comments_enabled'] and source.get('source_type') not in ('supergroup','forum'):
                    try:
                        await self.ensure_thread(client,source,entity,message)
                    except FloodWaitError:
                        raise
                    except (RPCError,ValueError):
                        pass
        if source['comments_enabled']:
            for thread in self.db.all("select t.* from raw.threads t join raw.items i on i.source_id=t.source_id and i.message_id=t.post_id and i.kind='post' left join raw.watch_state w on w.item_id=i.id where t.source_id=%s and t.status!='deleted' and (t.last_polled_at is null or (w.state not in ('paused','archived','deleted') and w.next_check_at<=now())) order by t.last_polled_at nulls first,t.id limit 10",(source['id'],)):
                if not any(s['id']==source['id'] and s['comments_enabled'] for s in self.sources(source['account_id'])):
                    return
                await self.poll_thread(client,source,entity,thread)
                await asyncio.sleep(1)
        self.source_status(source['id'],'watching')
        self.db.execute('update raw.source_state set last_success_at=now() where source_id=%s',(source['id'],))

    async def poll_watches(self,client,source,entity):
        for item in watch.due(self.db,source['id']):
            try:
                if not any(s['id']==source['id'] for s in self.sources(source['account_id'])):
                    watch.fail(self.db,item['id'],'SourcePaused',30)
                    continue
                message=await asyncio.wait_for(client.get_messages(entity,ids=item['message_id']),20)
                if isinstance(message,types.MessageEmpty) or message is None:
                    delete_items(self.db,source['account_id'],source['peer_id'],[item['message_id']])
                    continue
                self.record(source,message,source['peer_id'],item['kind'],collect_metrics=False)
                snapshot=save_snapshot(self.db,item['id'],message,force=True)
                thread=self.db.one("select status from raw.threads where source_id=%s and post_id=%s",(source['id'],item['message_id'])) if source['comments_enabled'] and item['kind']=='post' else None
                if thread and thread['status']=='error':
                    watch.fail(self.db,item['id'],'DiscussionUnavailable')
                    continue
                watch.complete(self.db,item,snapshot)
            except FloodWaitError as exc:
                watch.fail(self.db,item['id'],'FloodWait',exc.seconds+1)
                raise
            except Exception as exc:
                watch.fail(self.db,item['id'],type(exc).__name__)

    async def poll_thread(self,client,source,entity,thread):
        try:
            if not thread['root_id']:
                thread=await self.resolve_thread(client,entity,thread)
            async for message in client.iter_messages(entity,reply_to=thread['post_id'],min_id=thread['comment_cursor'],reverse=True,limit=100,wait_time=1):
                if isinstance(message,types.Message):
                    self.record(source,message,thread['discussion_id'],'comment',thread['post_id'],thread['root_id'])
                self.db.execute('update raw.threads set comment_cursor=greatest(comment_cursor,%s) where id=%s',(message.id,thread['id']))
            async for message in client.iter_messages(entity,reply_to=thread['post_id'],limit=10,wait_time=1):
                if isinstance(message,types.Message):
                    self.record(source,message,thread['discussion_id'],'comment',thread['post_id'],thread['root_id'])
            self.db.execute("update raw.threads set status='watching',last_error=null,last_polled_at=now() where id=%s",(thread['id'],))
        except FloodWaitError:
            raise
        except (RPCError,ValueError) as exc:
            self.db.execute("update raw.threads set status='error',last_error=%s,last_polled_at=now() where id=%s",(type(exc).__name__,thread['id']))


async def main():
    db=DB()
    with db.pool.connection() as lease:
        if not lease.execute('select pg_try_advisory_lock(727100) locked').fetchone()['locked']:
            raise RuntimeError('A collector instance is already running')
        publisher=asyncio.create_task(publish_outbox(db))
        try:
            await Collector(db).run()
        finally:
            publisher.cancel()
            await asyncio.gather(publisher,return_exceptions=True)
    db.pool.close()


if __name__=='__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
