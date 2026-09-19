"""Autonomous RSS worker: durable scheduling, HTTP validators, atomic raw/outbox writes."""
import asyncio
import logging
import uuid
from datetime import datetime, timezone
from .bus import publish_outbox
from .db import DB
from .rss_fetch import FeedError, fetch, parse

log = logging.getLogger('pipeline.rss')


def claim(db):
    with db.pool.connection() as conn:
        conn.execute('''insert into raw.rss_state(source_id) select source_id from core.rss_sources
            on conflict do nothing''')
        row = conn.execute('''select s.id,s.external_id,r.poll_seconds,r.revision,st.etag,st.last_modified,
            st.failures,st.observed_revision from raw.rss_state st
            join core.sources s on s.id=st.source_id join core.rss_sources r on r.source_id=s.id
            join core.workflows w on w.id=s.workflow_id
            where s.kind='rss' and s.enabled and w.enabled and r.rights_status='allowed'
            and (select enabled from core.modules where name='rss')
            and (st.next_poll_at<=now() or st.observed_revision<>r.revision)
            and (st.lease_until is null or st.lease_until<now())
            order by st.next_poll_at,s.id for update of st skip locked limit 1''').fetchone()
        if row:
            row['lease_token'] = uuid.uuid4().hex
            conn.execute("update raw.rss_state set lease_until=now()+interval '3 minutes',last_attempt_at=now(),status='fetching',lease_token=%s where source_id=%s", (row['lease_token'],row['id']))
        return row


def save_article(conn, source_id, article):
    # URL fallback also catches publishers changing a GUID for the same article.
    previous = conn.execute('''select id,version,content_hash,url,title,published_at,edited_at,deleted
        from raw.items where source_id=%s and (source_item_id=%s or url=%s) order by id limit 1 for update''',
        (source_id, article['source_item_id'], article['url'])).fetchone()
    if previous and (previous['deleted'] or (previous['edited_at'] and article['edited_at'] and previous['edited_at'] > article['edited_at'])):
        return False
    fields = ('content_hash','url','title','published_at','edited_at')
    if previous and all(previous[f] == article[f] for f in fields):
        conn.execute('update raw.items set last_seen_at=now() where id=%s', (previous['id'],))
        return False
    if previous:
        row = conn.execute('''update raw.items set text=%s,title=%s,url=%s,published_at=%s,edited_at=%s,
            content_hash=%s,version=version+1,last_seen_at=now() where id=%s returning id,version''',
            (article['text'],article['title'],article['url'],article['published_at'],article['edited_at'],article['content_hash'],previous['id'])).fetchone()
    else:
        row = conn.execute('''insert into raw.items(source_id,source_item_id,url,published_at,edited_at,title,text,content_hash,kind,content_scope)
            values(%s,%s,%s,%s,%s,%s,%s,%s,'post','excerpt') returning id,version''',
            (source_id,article['source_item_id'],article['url'],article['published_at'],article['edited_at'],article['title'],article['text'],article['content_hash'])).fetchone()
    conn.execute("update raw.items set normalization_version='rss-excerpt-v1' where id=%s",(row['id'],))
    conn.execute("insert into raw.item_versions(item_id,version,text,content_hash,normalization_version) values(%s,%s,%s,%s,'rss-excerpt-v1') on conflict do nothing",(row['id'],row['version'],article['text'],article['content_hash']))
    conn.execute('insert into raw.outbox(item_id,version) values(%s,%s) on conflict do nothing',(row['id'],row['version']))
    return True


def commit_poll(db, source, response, articles, skipped):
    with db.pool.connection() as conn:
        current = conn.execute('select lease_token from raw.rss_state where source_id=%s for update',(source['id'],)).fetchone()
        if not current or current['lease_token'] != source['lease_token']:
            return
        # Recheck current configuration after HTTP. A disabled/edited source must not ingest an in-flight response.
        config = conn.execute('''select s.enabled and w.enabled and m.enabled and r.rights_status='allowed' active,r.revision
            from core.sources s join core.rss_sources r on r.source_id=s.id
            join core.workflows w on w.id=s.workflow_id cross join core.modules m
            where s.id=%s and m.name='rss'
            ''',(source['id'],)).fetchone()
        if not config or not config['active'] or config['revision'] != source['revision']:
            conn.execute("update raw.rss_state set lease_until=null,status='paused' where source_id=%s",(source['id'],))
            return
        changed = sum(save_article(conn, source['id'], a) for a in articles)
        conn.execute('''update raw.rss_state set etag=%s,last_modified=%s,last_success_at=now(),
            next_poll_at=now()+make_interval(secs=>%s),lease_until=null,status='ok',last_error=null,
            http_status=%s,failures=0,last_item_count=%s,last_new_count=%s,skipped_count=%s,observed_revision=%s
            where source_id=%s''',
            (response.etag or (source['etag'] if response.status==304 else None),
             response.last_modified or (source['last_modified'] if response.status==304 else None),
             source['poll_seconds'],response.status,len(articles),changed,skipped,source['revision'],source['id']))


def fail_poll(db, source, error):
    code = error.code if isinstance(error, FeedError) else type(error).__name__
    status = error.status if isinstance(error, FeedError) else None
    retry = error.retry_after if isinstance(error, FeedError) else None
    delay = max(source['poll_seconds'], min(86400, 300 * 2 ** min(source['failures'],8)), retry or 0)
    db.execute('''update raw.rss_state set status='error',last_error=%s,http_status=%s,failures=failures+1,
        next_poll_at=now()+make_interval(secs=>%s),lease_until=null,observed_revision=%s where source_id=%s and lease_token=%s''',
        (code,status,delay,source['revision'],source['id'],source['lease_token']))
    log.warning('RSS source %s: %s',source['id'],code)


async def poll(db, source):
    try:
        response = await asyncio.to_thread(fetch, source['external_id'], source['etag'], source['last_modified'])
        articles, skipped = parse(response.data, response.url) if response.status == 200 else ([],0)
        commit_poll(db, source, response, articles, skipped)
    except asyncio.CancelledError:
        raise
    except Exception as error:
        fail_poll(db, source, error)


async def main():
    db = DB()
    publisher = asyncio.create_task(publish_outbox(db, 'rss'))
    pending = set()
    try:
        while True:
            for done in list(pending):
                if done.done():
                    pending.remove(done)
                    done.result()
            while len(pending) < 3:
                source = claim(db)
                if not source:
                    break
                pending.add(asyncio.create_task(poll(db, source)))
            db.execute("insert into raw.service_status(name,detail) values('collector-rss','RSS/Atom; feed excerpts; polling with backoff') on conflict(name) do update set heartbeat_at=now(),detail=excluded.detail")
            await asyncio.sleep(3)
    finally:
        for task in pending | {publisher}:
            task.cancel()
        await asyncio.gather(*pending,publisher,return_exceptions=True)
        db.pool.close()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
