import asyncio
import json
import logging
import os
import time
from .bus import connect
from .classification import classify, CONTEXT_REPLY
from .db import DB
from .rss_classification import classify_rss

log = logging.getLogger('pipeline.processor')


def process(db, ident):
    with db.pool.connection() as conn:
        # Multiple deliveries/processor instances cannot race on this item.
        conn.execute('select pg_advisory_xact_lock(%s)',(ident,))
        item = conn.execute('''select i.*,s.workflow_id,s.kind source_kind,w.filter_spam,w.processor_revision from raw.items i
            join core.sources s on s.id=i.source_id join core.workflows w on w.id=s.workflow_id where i.id=%s''',(ident,)).fetchone()
        if not item:
            return
        previous=conn.execute('select raw_version,decision,quote from core.mentions where raw_item_id=%s',(ident,)).fetchone()
        parent = conn.execute('''select m.*,r.decision manual from raw.items i join core.mentions m on m.raw_item_id=i.id
            left join core.review_decisions r on r.mention_id=m.id and r.raw_version=m.raw_version
            where i.source_id=%s and i.source_item_id=%s and not i.deleted and not m.deleted and m.raw_version=i.version''',
            (item['source_id'],item['parent_item_id'])).fetchone() if item['parent_item_id'] else None
        context = parent['quote'] if parent else ''
        # Follow only the actual reply chain. An unrelated reply must not inherit
        # a telecom topic just because it lives in the same group/forum.
        ancestor=parent
        seen=set()
        for _ in range(8):
            if not ancestor or ancestor['id'] in seen or (ancestor['manual'] or ancestor['decision'])!='accepted':
                break
            seen.add(ancestor['id'])
            if not ancestor['context_id']:
                break
            ancestor=conn.execute('''select m.*,r.decision manual from core.mentions m join raw.items i on i.id=m.raw_item_id
                left join core.review_decisions r on r.mention_id=m.id and r.raw_version=m.raw_version
                where m.id=%s and m.source_id=%s and not m.deleted and not i.deleted and m.raw_version=i.version''',(ancestor['context_id'],item['source_id'])).fetchone()
            if ancestor and (ancestor['manual'] or ancestor['decision'])=='accepted':
                context+='\n'+ancestor['quote']
        if parent and (parent['manual'] or parent['decision'])=='rejected':
            context=''
        verdict = classify_rss(item['text'],item['filter_spam']) if item['source_kind']=='rss' else classify(item['text'],context,item['filter_spam'])
        if not parent and item['kind'] in ('comment','group_message') and CONTEXT_REPLY.search(item['text']):
            verdict.decision,verdict.reason='review','Батьківський коментар ще недоступний.'
        if item['deleted']:
            verdict.decision,verdict.reason='rejected','Видалено у джерелі.'
        duplicate = None
        if item['kind']=='post' and len(item['text'])>=100:
            duplicate = conn.execute('''select m.id from core.mentions m join core.sources s on s.id=m.source_id
                where s.workflow_id=%s and (m.content_hash=%s or m.url=%s) and m.raw_item_id<%s and not m.deleted order by m.raw_item_id limit 1''',
                (item['workflow_id'],item['content_hash'],item['url'],ident)).fetchone()
        conn.execute('''insert into core.mentions(raw_item_id,source_id,url,published_at,category,summary,quote,kind,decision,reason,brand,context_id,duplicate_of,fetched_at,edited_at,content_hash,raw_version,deleted)
            values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            on conflict(raw_item_id) do update set url=excluded.url,published_at=excluded.published_at,category=excluded.category,summary=excluded.summary,
            quote=excluded.quote,decision=excluded.decision,reason=excluded.reason,brand=excluded.brand,context_id=excluded.context_id,
            duplicate_of=excluded.duplicate_of,edited_at=excluded.edited_at,content_hash=excluded.content_hash,
            raw_version=excluded.raw_version,deleted=excluded.deleted,analyzed_at=now()''',
            (ident,item['source_id'],item['url'],item['published_at'],verdict.topic,item['text'][:500],item['text'],item['kind'],
             verdict.decision,verdict.reason,verdict.brand,parent['id'] if parent else None,duplicate['id'] if duplicate else None,
             item['fetched_at'],item['edited_at'],item['content_hash'],item['version'],item['deleted']))
        conn.execute('''insert into core.processing_receipts(raw_item_id,version,processor_revision) values(%s,%s,%s)
            on conflict(raw_item_id) do update set version=excluded.version,processor_revision=excluded.processor_revision,processed_at=now()''',
            (ident,item['version'],item['processor_revision']))
        if not previous or previous['raw_version']!=item['version'] or previous['decision']!=verdict.decision or previous['quote']!=item['text']:
            # Context edits must invalidate the analyses of existing direct replies too.
            conn.execute('''delete from core.processing_receipts where raw_item_id in
                (select id from raw.items where source_id=%s and parent_item_id=%s)''',
                (item['source_id'],item['source_item_id']))


async def consume(db):
    while True:
        nc=None
        try:
            nc,js=await connect()
            sub=await js.pull_subscribe(os.environ.get('UFV_NATS_SUBJECT','raw.item.created'),durable='processor-v1')
            while True:
                try:
                    messages=await sub.fetch(20,timeout=2)
                except asyncio.TimeoutError:
                    continue
                for msg in messages:
                    try:
                        event=json.loads(msg.data)
                        if event.get('v')!=1 or not str(event.get('raw_item_id','')).isdigit():
                            await msg.term()
                            continue
                        process(db,int(event['raw_item_id']))
                        await msg.ack()
                    except Exception as exc:
                        log.warning('processing retry: %s',type(exc).__name__)
                        await msg.nak(delay=10)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning('consumer reconnect: %s',type(exc).__name__)
            await asyncio.sleep(5)
        finally:
            if nc:
                await nc.close()


async def main():
    db=DB()
    subscriber=asyncio.create_task(consume(db))
    last_rollup = 0.0
    try:
        while True:
            rows=db.all('''select i.id from raw.items i join core.sources s on s.id=i.source_id
                join core.workflows w on w.id=s.workflow_id left join core.processing_receipts p on p.raw_item_id=i.id
                where p.raw_item_id is null or p.version<>i.version or p.processor_revision<>w.processor_revision order by i.id limit 200''')
            for row in rows:
                process(db,row['id'])
            # A parent may arrive after its reply; retry only unresolved contexts whose parent is now present.
            late=db.all('''select i.id from raw.items i join core.mentions m on m.raw_item_id=i.id
                join raw.items p on p.source_id=i.source_id and p.source_item_id=i.parent_item_id
                join core.mentions pm on pm.raw_item_id=p.id
                where m.context_id is null and not m.deleted and not pm.deleted limit 100''')
            for row in late:
                process(db,row['id'])
            if time.monotonic() - last_rollup >= 60:
                try:
                    db.execute('select core.refresh_dashboard_rollups()')
                except Exception as exc:
                    log.warning('dashboard rollup retry: %s', type(exc).__name__)
                last_rollup = time.monotonic()
            db.execute("insert into core.service_status(name,detail) values('processor','rules-v2; database catch-up active') on conflict(name) do update set heartbeat_at=now(),detail=excluded.detail")
            await asyncio.sleep(2)
    finally:
        subscriber.cancel()
        await asyncio.gather(subscriber,return_exceptions=True)
        db.pool.close()


if __name__=='__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
