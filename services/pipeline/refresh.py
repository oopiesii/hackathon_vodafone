"""Collector-owned handling of admin refresh requests; never bypass source backoff."""
from datetime import datetime, timedelta, timezone


def apply_refresh_requests(db, service):
    if service not in ('telegram', 'rss'):
        raise ValueError('Unknown collector')
    with db.pool.connection() as conn:
        requests=conn.execute('''select * from core.refresh_requests where service=%s
            and status in ('pending','running') order by requested_at,id for update skip locked limit 20''',(service,)).fetchall()
        for request in requests:
            now=datetime.now(timezone.utc)
            if request['status']=='pending':
                enabled=conn.execute('''select w.enabled and coalesce(m.enabled,false) enabled
                    from core.workflows w left join core.modules m on m.name=%s where w.id=%s''',
                    (service,request['workflow_id'])).fetchone()
                if not enabled or not enabled['enabled']:
                    _finish(conn,request['id'],'disabled','Збір вимкнений для сервісу або workflow.')
                    continue
                if service=='telegram':
                    sources=conn.execute('''select s.id,st.cooldown_until from core.sources s
                        join core.telegram_accounts a on a.id=s.account_id left join raw.account_status st on st.account_id=a.id
                        where s.workflow_id=%s and s.kind='telegram' and s.enabled and a.enabled
                        and a.session is not null and a.api_id is not null and a.api_hash is not null and length(s.permission_note)>=10''',
                        (request['workflow_id'],)).fetchall()
                    ready=[s['id'] for s in sources if not s['cooldown_until'] or s['cooldown_until']<=now]
                    if ready:
                        # last_success_at is untouched: scheduling is not a successful observation.
                        conn.execute('update raw.source_state set last_polled_at=null where source_id=any(%s)',(ready,))
                        conn.execute('''update raw.watch_state w set next_check_at=now() from raw.items i
                            where w.item_id=i.id and i.source_id=any(%s) and w.state in ('active','cooling','sleeping','blocked')''',(ready,))
                else:
                    sources=conn.execute('''select s.id,st.status,st.next_poll_at from core.sources s
                        join core.rss_sources r on r.source_id=s.id left join raw.rss_state st on st.source_id=s.id
                        where s.workflow_id=%s and s.kind='rss' and s.enabled and r.rights_status='allowed' ''',
                        (request['workflow_id'],)).fetchall()
                    ready=[s['id'] for s in sources if s['status']!='error' or not s['next_poll_at'] or s['next_poll_at']<=now]
                    if ready:
                        conn.execute('''insert into raw.rss_state(source_id) select unnest(%s::bigint[]) on conflict do nothing''',(ready,))
                        conn.execute('update raw.rss_state set next_poll_at=now() where source_id=any(%s)',(ready,))
                if not ready:
                    _finish(conn,request['id'],'deferred' if sources else 'disabled',
                            'Чинне очікування Telegram/RSS збережено.' if sources else 'Немає активних дозволених джерел із готовим доступом.')
                    continue
                skipped=len(sources)-len(ready)
                detail=f'Заплановано {len(ready)} джерел; очікують лімітів: {skipped}. Збір іде в черзі чинного колектора.'
                conn.execute("update core.refresh_requests set status='running',started_at=now(),target_ids=%s,detail=%s where id=%s",
                             ([source['id'] for source in sources],detail,request['id']))
                continue
            # A refresh succeeds only after an observed poll, never on configuration update.
            if service=='telegram':
                states=conn.execute('''select s.id,st.last_polled_at attempted_at,st.last_success_at success_at,
                    a.cooldown_until deferred_until from core.sources s left join raw.source_state st on st.source_id=s.id
                    left join raw.account_status a on a.account_id=s.account_id where s.id=any(%s)''',(request['target_ids'],)).fetchall()
            else:
                states=conn.execute('''select s.id,st.last_attempt_at attempted_at,st.last_success_at success_at,
                    case when st.status='error' then st.next_poll_at end deferred_until
                    from core.sources s left join raw.rss_state st on st.source_id=s.id where s.id=any(%s)''',(request['target_ids'],)).fetchall()
            successes=sum(bool(s['success_at'] and s['success_at']>=request['started_at']) for s in states)
            deferred=sum(bool(s['deferred_until'] and s['deferred_until']>now) for s in states)
            attempts=sum(bool(s['attempted_at'] and s['attempted_at']>=request['started_at']) for s in states)
            if successes==len(request['target_ids']):
                _finish(conn,request['id'],'completed',f'Оновлено {successes} джерел. Нові матеріали обробляються окремо.')
            elif deferred or now-request['started_at']>timedelta(minutes=5):
                _finish(conn,request['id'],'deferred',f'Оновлено {successes} джерел. Решта очікують лімітів або завершення черги; очікування не скорочено.')
            elif service=='telegram' and attempts==len(request['target_ids']):
                _finish(conn,request['id'],'failed',f'Перевірено {attempts} джерел; частина спроб завершилася помилкою. Деталі — у Sources.')


def _finish(conn, ident, state, detail):
    conn.execute('''update core.refresh_requests set status=%s,started_at=coalesce(started_at,now()),
        completed_at=now(),detail=%s where id=%s''',(state,detail,ident))
