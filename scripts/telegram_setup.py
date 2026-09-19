"""Server-local onboarding. Secrets never pass through CLI arguments or stdout."""
import base64
import hashlib
import os
from pathlib import Path
import re
import subprocess

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import psycopg
from psycopg.rows import dict_row
from telethon.sessions import StringSession

RECOVERY_DIR = Path('/etc/ufv/recovery')


def encode(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def key_bytes(key):
    value = base64.urlsafe_b64decode(key + '=' * (-len(key) % 4))
    if len(value) != 32:
        raise ValueError('Некоректний ключ шифрування сервера')
    return value


def encrypt(value, key):
    iv = os.urandom(12)
    encrypted = AESGCM(key_bytes(key)).encrypt(iv, value.encode(), None)
    return '.'.join(['gcm1', encode(iv), encode(encrypted[-16:]), encode(encrypted[:-16])])


def decrypt(value, key):
    version, iv, tag, data = value.split('.')
    if version != 'gcm1':
        raise ValueError('Невідомий формат шифрування')
    decode = lambda v: base64.urlsafe_b64decode(v + '=' * (-len(v) % 4))
    return AESGCM(key_bytes(key)).decrypt(decode(iv), decode(data) + decode(tag), None).decode()


def server_config():
    """Use restricted API database credentials from the local protected config."""
    path = Path('/etc/ufv/production.env')
    if not path.is_file() or not os.access(path, os.R_OK):
        raise ValueError('Запустіть скрипт від root на сервері UFV: потрібен /etc/ufv/production.env.')
    settings = dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line)
    host = subprocess.check_output([
        'docker', 'inspect', 'ufv-postgres-1', '--format',
        '{{(index .NetworkSettings.Networks "ufv_backend").IPAddress}}',
    ], text=True, stderr=subprocess.DEVNULL).strip()
    if not host:
        raise ValueError('PostgreSQL UFV не запущений')
    return {
        'url': f"postgres://ufv_api:{settings['DB_API_PASSWORD']}@{host}:5432/ufv",
        'key': settings['TG_SESSION_KEY'],
    }


def saved_api_credentials(config):
    with psycopg.connect(config['url'], row_factory=dict_row) as conn:
        row = conn.execute('select api_id,api_hash from core.telegram_accounts where api_id is not null and api_hash is not null order by id limit 1').fetchone()
    if row:
        return row['api_id'], decrypt(row['api_hash'], config['key'])
    return None


def register_session(config, session, api_id=None, api_hash=None, account_id=None):
    session = session.strip()
    parsed = StringSession(session)
    if not parsed.auth_key or len(parsed.auth_key.key) != 256:
        raise ValueError('Некоректна Telethon StringSession')
    if (api_id is None) != (api_hash is None):
        raise ValueError('API ID та API hash потрібні разом')
    if api_id is not None and (api_id <= 0 or not re.fullmatch(r'[a-fA-F0-9]{32}', api_hash)):
        raise ValueError('Перевірте API ID/hash')
    fingerprint = hashlib.sha256(parsed.auth_key.key.hex().encode()).hexdigest()
    with psycopg.connect(config['url'], row_factory=dict_row) as conn:
        conn.execute('select pg_advisory_xact_lock(727102)')
        duplicate = conn.execute('select * from core.telegram_accounts where session_fingerprint=%s for update', (fingerprint,)).fetchone()
        if account_id is not None:
            target = conn.execute('select * from core.telegram_accounts where id=%s for update', (account_id,)).fetchone()
            if not target:
                raise ValueError('Такого місця акаунта немає')
            if duplicate and duplicate['id'] != account_id:
                raise ValueError('Цю сесію вже додано до іншого акаунта')
        else:
            target = duplicate or conn.execute('select * from core.telegram_accounts where session is null order by id limit 1 for update').fetchone()
        if target and target['session_fingerprint'] not in (None, fingerprint):
            raise ValueError('Це місце вже зайняте іншою сесією. Вкажіть порожній акаунт.')
        if not target:
            target = conn.execute("insert into core.telegram_accounts(label,enabled) values('Telegram',false) returning *").fetchone()
            conn.execute("update core.telegram_accounts set label='Telegram ' || id::text where id=%s", (target['id'],))
        resolved_id = api_id if api_id is not None else target['api_id']
        encrypted_hash = encrypt(api_hash, config['key']) if api_hash is not None else target['api_hash']
        ready = resolved_id is not None and encrypted_hash is not None
        conn.execute('''update core.telegram_accounts set api_id=%s,api_hash=%s,session=%s,
            session_fingerprint=%s,enabled=%s,revision=revision+1 where id=%s''',
            (resolved_id, encrypted_hash, encrypt(session, config['key']), fingerprint, ready, target['id']))
        conn.execute("insert into core.audit(actor_id,action,object_type,object_id) values('server-cli',%s,'account',%s)",
                     ('session_registered' if ready else 'session_recovered_needs_api', target['id']))
        result = conn.execute('select id,label,enabled from core.telegram_accounts where id=%s', (target['id'],)).fetchone()
    return result


def save_recovery(config, session, api_id, api_hash):
    """Preserve successful login if DB fails, without writing plaintext into Git."""
    import json
    folder = RECOVERY_DIR
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    filename = folder / ('telegram-' + os.urandom(8).hex() + '.gcm')
    payload = json.dumps({'session': session, 'api_id': api_id, 'api_hash': api_hash})
    with os.fdopen(os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        f.write(encrypt(payload, config['key']))
        f.flush()
        os.fsync(f.fileno())
    return filename
