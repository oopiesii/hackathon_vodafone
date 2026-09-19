"""Aggregate-only Telegram observations. Never persist reactors or sender objects."""
from datetime import datetime, timezone
import json


def counter(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def extract_metrics(message):
    reactions = getattr(message, 'reactions', None)
    totals = None
    if reactions is not None:
        totals = {}
        for result in getattr(reactions, 'results', ()):
            reaction = getattr(result, 'reaction', None)
            emoji = getattr(reaction, 'emoticon', None)
            custom = getattr(reaction, 'document_id', None)
            key = emoji or (f'custom:{custom}' if custom is not None else 'paid' if type(reaction).__name__ == 'ReactionPaid' else None)
            count = counter(getattr(result, 'count', None))
            if key is not None and count is not None:
                totals[str(key)[:100]] = count
    reply = getattr(message, 'replies', None)
    values = {'views':counter(getattr(message, 'views', None)),
              'forwards':counter(getattr(message, 'forwards', None)),
              'replies':counter(getattr(reply, 'replies', None)), 'reactions':totals}
    values['available'] = {key:value is not None for key,value in values.items()}
    return values


def save_snapshot(db, item_id, message, now=None, force=False):
    now = now or datetime.now(timezone.utc)
    values = extract_metrics(message)
    with db.pool.connection() as conn:
        conn.execute('select pg_advisory_xact_lock(%s)', (item_id,))
        item = conn.execute('select deleted from raw.items where id=%s', (item_id,)).fetchone()
        if not item or item['deleted']:
            return None
        previous = conn.execute('select * from raw.metric_snapshots where item_id=%s order by observed_at desc,id desc limit 1', (item_id,)).fetchone()
        if previous and not force and (now-previous['observed_at']).total_seconds() < 30 and all(previous[k] == values[k] for k in values):
            return previous
        row = conn.execute('''insert into raw.metric_snapshots(item_id,observed_at,views,forwards,replies,reactions,available)
            values(%s,%s,%s,%s,%s,%s,%s) on conflict(item_id,observed_at) do update set observed_at=excluded.observed_at returning *''',
            (item_id,now,values['views'],values['forwards'],values['replies'],json.dumps(values['reactions']),json.dumps(values['available']))).fetchone()
        conn.execute('update raw.items set metrics=%s where id=%s', (json.dumps({**values,'observed_at':now.isoformat()}),item_id))
        return row
