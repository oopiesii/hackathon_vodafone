"""Живий NATS consumer + DB catch-up; NullProvider лишає правила незмінними."""
import asyncio
import json
import logging
import os
import threading

import psycopg
from pipeline.bus import connect

from .db import DB
from .label import analyze_batch, analyze_item, pending_ids
from .provider import Config, NullProvider, load_config, make_provider, ProviderError
from .summary import summarize_window

log = logging.getLogger('analyst')


class Analyst:
    def __init__(self, db):
        self.db = db
        self.lock = threading.Lock()

    def heartbeat(self, config, mode=None, error=None, clear_error=False):
        self.db.execute('''insert into core.analyst_state(singleton,mode,model,last_error,limit_per_hour)
            values(true,%s,%s,%s,%s) on conflict(singleton) do update set heartbeat_at=now(),
            mode=excluded.mode,model=excluded.model,
            last_error=case when excluded.last_error is not null then excluded.last_error
              when excluded.mode='waiting_key' or %s then null else core.analyst_state.last_error end,
            limit_per_hour=excluded.limit_per_hour''',
            (mode or ('active' if config.enabled else 'waiting_key'),config.model or None,error,config.max_items_per_hour,clear_error))

    def item(self, ident):
        with self.lock:
            config = load_config()
            result = analyze_item(self.db,ident,make_provider(config),config)
            self.heartbeat(config,'rate_limited' if result=='rate_limited' else None,
                           result if result.startswith(('provider_','evidence_')) else None,
                           result in ('complete','already_processed'))
            return result

    def tick(self):
        with self.lock:
            config = load_config()
            provider = make_provider(config)
            config_version = f'{config.enabled}:{config.provider}:{config.model}'
            self.heartbeat(config)
            # Нові матеріали мають пройти семантичну браму до того, як S2 витратить
            # спільний погодинний бюджет на зведення. Catch-up пакує до 20 item/запит.
            if config.enabled:
                pending = pending_ids(self.db,config.model,limit=20)
                if pending:
                    result = analyze_batch(self.db,[row['id'] for row in pending],provider,config)
                    if result == 'rate_limited':
                        self.heartbeat(config,'rate_limited')
                    elif result.startswith(('provider_','evidence_')):
                        self.heartbeat(config,'error',result)
                    elif result == 'complete':
                        self.heartbeat(config,clear_error=True)
            # Check every five seconds; timestamp comparison observes the manual refresh queue.
            workflows = self.db.all('select distinct workflow_id from core.analyst_items')
            for row in workflows:
                for window in ('24h','7d','30d'):
                    due = self.db.one('''select not exists(select 1 from core.analyst_summary_schedule
                        where workflow_id=%s and "window"=%s and attempted_at>now()-interval '15 minutes'
                        and attempted_at>coalesce((select max(requested_at) from core.refresh_requests where workflow_id=%s),'-infinity')
                        and config_version=%s) due''',
                        (row['workflow_id'],window,row['workflow_id'],config_version))
                    if due['due']:
                        self.db.execute('''insert into core.analyst_summary_schedule(workflow_id,"window",config_version)
                            values(%s,%s,%s) on conflict(workflow_id,"window") do update
                            set attempted_at=now(),config_version=excluded.config_version''',
                            (row['workflow_id'],window,config_version))
                        try:
                            result=summarize_window(self.db,row['workflow_id'],window,provider,config)
                            if result in ('rollup_pending','input_changed'):
                                self.db.execute('''update core.analyst_summary_schedule set attempted_at=now()-interval '15 minutes'
                                    where workflow_id=%s and "window"=%s''',(row['workflow_id'],window))
                        except (ProviderError,ValueError) as exc:
                            code = str(exc) if isinstance(exc,ProviderError) else 'evidence_validation_failed'
                            self.heartbeat(config,'error',code)
                            # Reject the generated body; preserve the same real window/counts as rules.
                            summarize_window(self.db,row['workflow_id'],window,NullProvider(),Config())


async def consume(analyst):
    while True:
        nc = None
        try:
            nc, js = await connect()
            sub = await js.pull_subscribe(os.environ.get('UFV_NATS_SUBJECT','raw.item.created'),
                                          durable=os.environ.get('UFV_ANALYST_DURABLE','analyst-v1'))
            while True:
                try:
                    messages = await sub.fetch(1,timeout=2)
                except asyncio.TimeoutError:
                    continue
                for message in messages:
                    try:
                        event = json.loads(message.data)
                        if not isinstance(event,dict) or event.get('v') != 1 or not str(event.get('raw_item_id','')).isdigit() or len(str(event['raw_item_id']))>18:
                            await message.term()
                            continue
                        await message.in_progress()
                        task=asyncio.create_task(asyncio.to_thread(analyst.item,int(event['raw_item_id'])))
                        while True:
                            try:
                                await asyncio.wait_for(asyncio.shield(task),timeout=20)
                                break
                            except asyncio.TimeoutError:
                                await message.in_progress()
                        # Budget/key/rights are retried from PostgreSQL catch-up, not a hot NATS loop.
                        await message.ack()
                    except (ValueError,KeyError,TypeError):
                        await message.term()
                    except Exception:
                        log.warning('consumer_item_failed')
                        await message.nak(delay=60)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning('consumer_reconnecting')
            await asyncio.sleep(5)
        finally:
            if nc:
                await nc.close()


async def main():
    url = os.environ['DATABASE_URL']
    # One instance consumes the budget and generates summaries; no extra privileges required.
    with psycopg.connect(url,autocommit=True) as leader:
        if not leader.execute('select pg_try_advisory_lock(727812)').fetchone()[0]:
            log.warning('analyst_already_running')
            return
        db = DB(url)
        analyst = Analyst(db)
        analyst.heartbeat(load_config())
        subscriber = asyncio.create_task(consume(analyst))
        async def keep_alive():
            while True:
                await asyncio.sleep(10)
                try:
                    await asyncio.to_thread(db.execute,'update core.analyst_state set heartbeat_at=now() where singleton')
                except Exception:
                    log.warning('heartbeat_failed')
        heartbeat = asyncio.create_task(keep_alive())
        try:
            while True:
                try:
                    leader.execute('select 1')
                except psycopg.Error:
                    log.warning('analyst_leadership_connection_lost')
                    break
                try:
                    await asyncio.to_thread(analyst.tick)
                except Exception:
                    log.warning('analyst_cycle_failed')
                    try:
                        db.execute("update core.analyst_state set heartbeat_at=now(),mode='error',last_error='analyst_cycle_failed' where singleton")
                    except Exception:
                        pass
                await asyncio.sleep(5)
        finally:
            subscriber.cancel()
            heartbeat.cancel()
            await asyncio.gather(subscriber,heartbeat,return_exceptions=True)
            db.pool.close()


if __name__=='__main__':
    logging.basicConfig(level=logging.WARNING)
    asyncio.run(main())
