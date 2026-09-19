"""Deterministic lifecycle; thresholds are explicit, configurable assumptions."""
from datetime import datetime, timedelta, timezone
import uuid

DEFAULTS = dict(active_days=2,sleep_days=7,archive_days=24,active_seconds=300,
                cooling_seconds=3600,sleeping_seconds=21600,min_views_delta=100,
                min_replies_delta=1,min_reactions_delta=5,revision=1)


def policy(db, workflow_id):
    return db.one('select * from core.telegram_watch_policies where workflow_id=%s', (workflow_id,)) or DEFAULTS.copy()


def activity(previous, current, settings):
    """Require comparable observations. Counts may decrease; preserve that correction."""
    if not previous or not current:
        return False, False, {}
    hours = (current['observed_at']-previous['observed_at']).total_seconds()/3600
    if hours <= 0:
        return False, False, {}
    deltas = {}
    for key in ('views','replies','reactions'):
        a,b = previous.get(key), current.get(key)
        if key == 'reactions':
            a = sum(a.values()) if isinstance(a,dict) else None
            b = sum(b.values()) if isinstance(b,dict) else None
        if a is None or b is None:
            continue
        delta = b-a
        deltas[key] = {'delta':delta,'per_hour':delta/hours,'correction':delta<0}
    # A threshold is a change per reference active interval, not an LLM risk score.
    scale = max(1.0, hours*3600/settings['active_seconds'])
    significant = any(v['delta'] >= settings['min_'+key+'_delta']*scale for key,v in deltas.items())
    return significant, bool(deltas), deltas


def decision(item, watch, previous, current, settings, override=None, now=None):
    now = now or datetime.now(timezone.utc)
    mode = (override or {}).get('mode','auto')
    if item['deleted']:
        return dict(state='deleted',seconds=None,quiet=0,reason='Видалено у джерелі',activity=False)
    if mode == 'paused':
        return dict(state='paused',seconds=None,quiet=watch['quiet_checks'],reason='Призупинено адміністратором',activity=False)
    hot,comparable,_ = activity(previous,current,settings)
    if mode == 'pinned':
        return dict(state='active',seconds=settings['active_seconds'],quiet=0,reason='Закріплено адміністратором',activity=hot)
    age = (now-(item['published_at'] or item['fetched_at'])).total_seconds()/86400
    quiet = watch['quiet_checks']+1 if comparable and not hot else 0 if hot else watch['quiet_checks']
    last_activity = watch.get('last_activity_at') or item['fetched_at']
    silent_days = (now-last_activity).total_seconds()/86400
    if hot:
        state,reason = 'active','Зафіксовано приріст активності'
    elif age < settings['active_days']:
        state,reason = 'active','Початкове спостереження'
    elif not comparable:
        if age >= settings['archive_days']:
            state,reason = 'archived','Ліміт строку вичерпано; активність невідома через недоступні метрики'
        else:
            state,reason = 'blocked','Недостатньо порівнюваних метрик; активність невідома'
    elif age >= settings['archive_days'] and quiet >= 3 and silent_days >= 1:
        state,reason = 'archived','Строк спостереження минув; планові перевірки зупинені'
    elif age >= settings['sleep_days'] and quiet >= 3 and silent_days >= 1:
        state,reason = 'sleeping','Тривалий час без помітного приросту'
    elif quiet >= 3:
        state,reason = 'cooling','Кілька успішних перевірок без помітного приросту'
    else:
        state,reason = 'active','Продовжуємо збирати спостереження'
    interval = {'active':'active_seconds','cooling':'cooling_seconds','sleeping':'sleeping_seconds','blocked':'cooling_seconds'}
    return dict(state=state,seconds=settings[interval[state]] if state in interval else None,quiet=quiet,reason=reason,activity=hot)


def complete(db,item,snapshot,now=None):
    now = now or datetime.now(timezone.utc)
    with db.pool.connection() as conn:
        w = conn.execute('select * from raw.watch_state where item_id=%s for update',(item['id'],)).fetchone()
        if not w:
            return
        if item.get('lease_token') and w['lease_token'] != item['lease_token']:
            return  # A later worker owns this observation.
        current_item=conn.execute('select deleted from raw.items where id=%s',(item['id'],)).fetchone()
        item={**item,'deleted':current_item['deleted']}
        previous = conn.execute('select * from raw.metric_snapshots where id=%s',(w['snapshot_id'],)).fetchone() if w['snapshot_id'] else None
        settings = conn.execute('select * from core.telegram_watch_policies where workflow_id=%s',(item['workflow_id'],)).fetchone() or DEFAULTS
        override = conn.execute('select * from core.telegram_watch_overrides where item_id=%s',(item['id'],)).fetchone()
        d = decision(item,w,previous,snapshot,settings,override,now)
        # A comment/edit arriving during the RPC must not be overwritten by a quiet result.
        if w['last_activity_at'] and w['last_activity_at'] > (w['last_checked_at'] or item['fetched_at']) and d['state'] not in ('paused','deleted'):
            d.update(state='active',seconds=settings['active_seconds'],quiet=0,reason='Новий зміст або відповідь після попередньої перевірки')
        conn.execute('''update raw.watch_state set state=%s,next_check_at=%s,last_checked_at=%s,quiet_checks=%s,
            last_activity_at=case when %s then %s else last_activity_at end,reason=%s,last_error=null,
            snapshot_id=%s,policy_revision=%s,lease_until=null,lease_token=null where item_id=%s''',
            (d['state'],now+timedelta(seconds=d['seconds']) if d['seconds'] else None,now,d['quiet'],d['activity'],now,
             d['reason'],snapshot['id'] if snapshot else None,settings['revision'],item['id']))


def fail(db,item_id,error,seconds=300):
    db.execute('''update raw.watch_state set state='blocked',last_error=%s,reason='Перевірка не вдалася; це не відсутність активності',
        next_check_at=now()+make_interval(secs=>%s),lease_until=null,lease_token=null where item_id=%s and state not in ('paused','deleted')''',(error,seconds,item_id))


def due(db,source_id,limit=10):
    token=uuid.uuid4().hex
    with db.pool.connection() as conn:
        return conn.execute('''with candidates as (
          select w.item_id from raw.watch_state w join raw.items i on i.id=w.item_id
          where i.source_id=%s and not i.deleted and w.next_check_at<=now()
          and (w.lease_until is null or w.lease_until<now())
          order by w.next_check_at,w.item_id for update of w skip locked limit %s
        ) update raw.watch_state w set lease_until=now()+interval '2 minutes',lease_token=%s
          from candidates c,raw.items i,core.sources s where w.item_id=c.item_id and i.id=c.item_id and s.id=i.source_id
          returning i.*,s.workflow_id,w.lease_token''',(source_id,limit,token)).fetchall()
