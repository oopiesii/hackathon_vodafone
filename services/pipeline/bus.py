import asyncio
import json
import logging
import os
import nats

log = logging.getLogger('pipeline.bus')


async def connect():
    nc = await nats.connect(os.environ.get('NATS_URL','nats://nats:4222'), connect_timeout=3,
                           max_reconnect_attempts=-1, reconnect_time_wait=2)
    js = nc.jetstream()
    stream=os.environ.get('UFV_NATS_STREAM','UFV_RAW')
    subject=os.environ.get('UFV_NATS_SUBJECT','raw.item.created')
    try:
        await js.stream_info(stream)
    except nats.js.errors.NotFoundError:
        await js.add_stream(name=stream,subjects=[subject],max_age=7*86400,max_bytes=100_000_000)
    return nc, js


async def publish_outbox(db, source_kind="telegram"):
    """Each connector publishes its own rows; NATS deduplicates concurrent retries."""
    while True:
        nc = None
        try:
            nc, js = await connect()
            while True:
                rows = db.all('''select o.id,o.version,i.id raw_item_id,i.source_id,i.fetched_at,s.kind source_kind
                    from raw.outbox o join raw.items i on i.id=o.item_id join core.sources s on s.id=i.source_id
                    where o.published_at is null and s.kind=%s order by o.id limit 100''', (source_kind,))
                for row in rows:
                    event = {'v':1,'raw_item_id':str(row['raw_item_id']),'source_id':str(row['source_id']),
                             'source_kind':row['source_kind'],'fetched_at':row['fetched_at'].isoformat()}
                    await js.publish(os.environ.get('UFV_NATS_SUBJECT','raw.item.created'),json.dumps(event).encode(),headers={'Nats-Msg-Id':f"{row['raw_item_id']}:{row['version']}"})
                    db.execute('update raw.outbox set published_at=now() where id=%s',(row['id'],))
                await asyncio.sleep(2)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning('publisher retry: %s',type(exc).__name__)
            await asyncio.sleep(5)
        finally:
            if nc:
                await nc.close()
