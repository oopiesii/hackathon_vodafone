from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


class DB:
    def __init__(self, url):
        self.pool = ConnectionPool(url, min_size=1, max_size=4, open=True,
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


def reserve_budget(db, limit, count=1):
    """Атомарний загальний ліміт, який не обнуляється після restart чи HTTP-помилки."""
    if limit < count:
        return False
    return db.one('''insert into core.analyst_budget(hour,used) values(date_trunc('hour',now()),%s)
        on conflict(hour) do update set used=core.analyst_budget.used+excluded.used
        where core.analyst_budget.used+excluded.used<=%s returning used''', (count, limit)) is not None
