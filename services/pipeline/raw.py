from datetime import datetime, timezone
from .classification import normalize, content_hash, NORMALIZATION_VERSION, MAX_TEXT_LENGTH


def save_item(db, source, message, peer_id, kind='post', post_id=None, root_id=None):
    post_id = post_id or message.id
    key = f'{peer_id}:{message.id}'
    thread_key = f"{source['peer_id']}:{post_id}"
    reply = getattr(message, 'reply_to', None)
    reply_id = getattr(reply, 'reply_to_msg_id', None)
    parent_key = (thread_key if kind == 'comment' and reply_id == root_id else f'{peer_id}:{reply_id}') if reply_id else None
    if kind == 'group_message':
        thread_key = f"{peer_id}:{getattr(reply, 'reply_to_top_id', None) or reply_id or message.id}"
    text = normalize(message.message or '')
    hashed = content_hash(text)
    url = f"https://t.me/{source.get('current_username') or source['external_id']}/{post_id}" + (f'?comment={message.id}' if kind == 'comment' else '')
    edited = getattr(message, 'edit_date', None)
    truncated = len(message.message or '') > MAX_TEXT_LENGTH
    topic_id = getattr(reply,'reply_to_top_id',None) if getattr(reply,'forum_topic',False) else None
    # One transaction: changed content and its event are committed together.
    with db.pool.connection() as conn:
        # Serialize concurrent push/history deliveries before checking existence.
        conn.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))',(f"telegram:{key}",))
        previous = conn.execute('select id,version,text,content_hash,deleted,edited_at,parent_item_id from raw.items where source_id=%s and source_item_id=%s for update', (source['id'],key)).fetchone()
        if previous and (previous['deleted'] or (previous['edited_at'] and (not edited or edited < previous['edited_at']))):
            return previous['id']
        if previous and previous['text'] == text and previous['parent_item_id'] == parent_key:
            conn.execute('update raw.items set last_seen_at=now(),edited_at=coalesce(%s,edited_at),url=%s where id=%s',(edited,url,previous['id']))
            return previous['id']
        row = conn.execute('''insert into raw.items(source_id,source_item_id,parent_item_id,thread_item_id,url,published_at,text,content_hash,peer_id,message_id,kind,edited_at)
            values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            on conflict(source_id,source_item_id) do update set parent_item_id=excluded.parent_item_id,
             text=excluded.text,content_hash=excluded.content_hash,edited_at=excluded.edited_at,
            thread_item_id=excluded.thread_item_id,url=excluded.url,version=raw.items.version+1,last_seen_at=now() returning id,version''',
            (source['id'],key,parent_key,thread_key,url,message.date,text,hashed,peer_id,message.id,kind,edited)).fetchone()
        canonical=conn.execute('select id from raw.items where peer_id=%s and message_id=%s and id<>%s order by id limit 1',(peer_id,message.id,row['id'])).fetchone()
        conn.execute('update raw.items set normalization_version=%s,content_truncated=%s,topic_id=%s,canonical_item_id=%s where id=%s',
                     (NORMALIZATION_VERSION,truncated,topic_id,canonical['id'] if canonical else None,row['id']))
        conn.execute('insert into raw.item_versions(item_id,version,text,content_hash,normalization_version) values(%s,%s,%s,%s,%s) on conflict do nothing',
                     (row['id'],row['version'],text,hashed,NORMALIZATION_VERSION))
        if kind in ('post','group_message'):
            conn.execute('''insert into raw.watch_state(item_id,last_activity_at) values(%s,now()) on conflict(item_id) do update
                set next_check_at=case when raw.watch_state.state in ('paused','deleted') then null else now() end,
                last_activity_at=now(),quiet_checks=0,reason='Змінено зміст повідомлення' ''',(row['id'],))
        if kind in ('comment','group_message') and reply_id:
            conn.execute('''update raw.watch_state set next_check_at=now(),last_activity_at=now(),quiet_checks=0,
                reason='Отримано нову відповідь' where item_id in
                (select id from raw.items where source_id=%s and source_item_id in (%s,%s))
                and state not in ('paused','deleted')''',(source['id'],parent_key,thread_key))
        conn.execute('insert into raw.outbox(item_id,version) values(%s,%s) on conflict do nothing',(row['id'],row['version']))
        return row['id']


def delete_items(db, account_id, peer_id, message_ids):
    if not peer_id or not message_ids:
        return
    with db.pool.connection() as conn:
        rows = conn.execute('''select i.id,i.kind,i.source_id,i.source_item_id from raw.items i join core.sources s on s.id=i.source_id
            where s.account_id=%s and i.peer_id=%s and i.message_id=any(%s) and not i.deleted''', (account_id,peer_id,message_ids)).fetchall()
        for row in rows:
            updates = conn.execute('''update raw.items set deleted=true,text='',version=version+1,last_seen_at=now()
                where id=%s or (source_id=%s and thread_item_id=%s and %s='post' and not deleted) returning id,version''',
                (row['id'],row['source_id'],row['source_item_id'],row['kind'])).fetchall()
            for update in updates:
                conn.execute('delete from raw.item_versions where item_id=%s',(update['id'],))
                conn.execute('delete from raw.metric_snapshots where item_id=%s and id not in (select snapshot_id from raw.watch_state where snapshot_id is not null)',(update['id'],))
                conn.execute("update raw.watch_state set state='deleted',next_check_at=null,reason='Видалено у джерелі',lease_until=null,lease_token=null where item_id=%s",(update['id'],))
                conn.execute('insert into raw.outbox(item_id,version) values(%s,%s) on conflict do nothing',(update['id'],update['version']))
            if row['kind'] == 'post':
                conn.execute("update raw.threads set status='deleted' where source_id=%s and post_id=%s", (row['source_id'],int(row['source_item_id'].split(':')[1])))
