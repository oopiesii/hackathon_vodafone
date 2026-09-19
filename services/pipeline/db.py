import base64
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


class DB:
    def __init__(self, url=None):
        self.pool = ConnectionPool(url or os.environ['DATABASE_URL'], min_size=1, max_size=4, open=True,
                                   kwargs={'row_factory': dict_row})

    def all(self, sql, params=()):
        with self.pool.connection() as conn:
            return conn.execute(sql, params).fetchall()

    def one(self, sql, params=()):
        rows = self.all(sql, params)
        return rows[0] if rows else None

    def execute(self, sql, params=()):
        with self.pool.connection() as conn:
            conn.execute(sql, params)

    def enabled(self):
        return self.one("select enabled from core.modules where name='telegram'")['enabled']


def decode(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def decrypt(value):
    version, iv, tag, data = value.split('.')
    if version != 'gcm1':
        raise ValueError('unknown_secret_format')
    key = decode(os.environ['TG_SESSION_KEY'])
    return AESGCM(key).decrypt(decode(iv), decode(data) + decode(tag), None).decode()
