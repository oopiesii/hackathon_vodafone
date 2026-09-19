"""Container health is local worker liveness, not model availability."""
import os
import sys
import psycopg

try:
    with psycopg.connect(os.environ['DATABASE_URL'],connect_timeout=3) as conn:
        row=conn.execute("select heartbeat_at>now()-interval '5 minutes' from core.analyst_state where singleton").fetchone()
        sys.exit(0 if row and row[0] else 1)
except Exception:
    sys.exit(1)
