"""S1: version-bound розмітка одного дозволеного item і прямого контексту."""
from datetime import datetime, timezone
import uuid

from psycopg.types.json import Jsonb
from pipeline.classification import normalize

from .db import reserve_budget
from .provider import ProviderError
from .validation import PROMPT, SCHEMA, VERSION, validate


def bounded_text(text, byte_limit):
    return normalize(text).encode('utf-8')[:byte_limit].decode('utf-8','ignore')


def item_payload(db, ident):
    row = db.one('select * from core.analyst_items where id=%s', (ident,))
    if not row:
        return None
    parent = db.one('''select id,version,text from core.analyst_items
        where source_id=%s and source_item_id=%s''', (row['source_id'], row['parent_item_id'])) if row['parent_item_id'] else None
    # Explicit payload allowlist: no URL, channel/account profile, contacts or DB metadata.
    payload = {'id': row['id'], 'kind': row['kind'], 'text': bounded_text(row['text'],40000),
               'context': [{'id': parent['id'], 'version': parent['version'], 'text': bounded_text(parent['text'],16000)}] if parent else []}
    payload['truncated'] = payload['text'] != normalize(row['text']) or bool(parent and payload['context'][0]['text'] != normalize(parent['text']))
    return row, parent, payload


def pending_ids(db, model, limit=20):
    return db.all('''select i.id from core.analyst_items i
        left join core.analyst_items p on p.source_id=i.source_id and p.source_item_id=i.parent_item_id
        left join core.analyst_receipts r on r.raw_item_id=i.id
        where r.raw_item_id is null or r.raw_version<>i.version or r.model<>%s or r.prompt_version<>%s
         or r.parent_id is distinct from p.id or r.parent_version is distinct from p.version
         or (r.status='error' and r.retry_at<=now() and r.attempts<3)
        order by i.fetched_at desc,i.id desc limit %s''', (model, VERSION, limit))


def analyze_item(db, ident, provider, config):
    if not config.enabled:
        return 'waiting_key'
    item = item_payload(db, ident)
    if not item:
        return 'not_allowed'
    row, parent, payload = item
    parent_id = parent['id'] if parent else None
    parent_version = parent['version'] if parent else None
    old = db.one('select * from core.analyst_receipts where raw_item_id=%s', (ident,))
    same = old and (old['raw_version'], old['parent_id'], old['parent_version'], old['model'], old['prompt_version']) == (
        row['version'], parent_id, parent_version, config.model, VERSION)
    if same and (old['status'] == 'complete' or old['attempts'] >= 3 or old['retry_at'] > datetime.now(timezone.utc)):
        return 'already_processed'
    if not reserve_budget(db, config.max_items_per_hour):
        return 'rate_limited'
    attempts = old['attempts'] + 1 if same else 1
    try:
        # LLM-SEAM(S1-label): нормалізований текст + прямий контекст → ufv-relevance-v1.
        # Без ключа немає запиту й receipt: незалежний rules-v2 продовжує працювати.
        result = provider.complete_json(PROMPT, SCHEMA, {'items': [payload]})
        if result is None:
            return 'waiting_key'
        label = validate(result, [payload])[0]
    except (ProviderError, ValueError) as exc:
        code = str(exc) if isinstance(exc, ProviderError) else 'evidence_validation_failed'
        db.execute('''insert into core.analyst_receipts(raw_item_id,raw_version,parent_id,parent_version,model,prompt_version,status,attempts,error_code,retry_at)
            values(%s,%s,%s,%s,%s,%s,'error',%s,%s,now()+interval '15 minutes')
            on conflict(raw_item_id) do update set raw_version=excluded.raw_version,parent_id=excluded.parent_id,
            parent_version=excluded.parent_version,model=excluded.model,prompt_version=excluded.prompt_version,
            status='error',attempts=excluded.attempts,error_code=excluded.error_code,retry_at=excluded.retry_at,analyzed_at=now()''',
            (ident,row['version'],parent_id,parent_version,config.model,VERSION,attempts,code))
        return code
    current = item_payload(db, ident)
    if not current or current[2] != payload or current[0]['version'] != row['version']:
        return 'input_changed'
    label['context_versions'] = [{'id': c['id'], 'version': c['version']} for c in payload['context']]
    label['input_truncated'] = payload['truncated']
    if row['parent_item_id'] and not parent:
        label['missing_parent_key'] = row['parent_item_id']
    today = datetime.now(timezone.utc).date().isoformat()
    run = uuid.uuid5(uuid.NAMESPACE_URL, f'ufv:analyst:{row["workflow_id"]}:{today}:{config.provider}:{config.model}:{VERSION}')
    with db.pool.connection() as conn:
        conn.execute('''insert into core.analysis_runs(id,workflow_id,cutoff_at,model,prompt_version,scope,status,total,note)
            values(%s,%s,now(),%s,%s,%s,'running',0,'Постійний аналіз дозволених джерел; точність не виміряна.')
            on conflict(id) do update set cutoff_at=now(),status='running' ''',
            (run,row['workflow_id'],config.model,VERSION,Jsonb({'mode':'continuous','day_utc':today,'rights':'llm_allowed'})))
        conn.execute('''insert into core.analysis_labels(run_id,raw_item_id,raw_version,label) values(%s,%s,%s,%s)
            on conflict(run_id,raw_item_id) do update set raw_version=%s,label=%s,analyzed_at=now()''',
            (run,ident,row['version'],Jsonb(label),row['version'],Jsonb(label)))
        conn.execute('''update core.analysis_runs set total=(select count(*) from core.analysis_labels where run_id=%s),
            progress=jsonb_build_object('mode','continuous','last_label_at',now()) where id=%s''', (run,run))
        conn.execute('''insert into core.analyst_receipts(raw_item_id,raw_version,parent_id,parent_version,model,prompt_version,status,attempts)
            values(%s,%s,%s,%s,%s,%s,'complete',%s) on conflict(raw_item_id) do update set
            raw_version=excluded.raw_version,parent_id=excluded.parent_id,parent_version=excluded.parent_version,
            model=excluded.model,prompt_version=excluded.prompt_version,status='complete',attempts=excluded.attempts,
            error_code=null,analyzed_at=now()''', (ident,row['version'],parent_id,parent_version,config.model,VERSION,attempts))
        conn.execute('update core.analyst_state set last_label_at=now() where singleton')
    return 'complete'
