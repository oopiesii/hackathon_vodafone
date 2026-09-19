"""Run as root on the deployment host after building Node artifacts and starting Postgres.

Credentials are read from a protected file and are never passed as CLI arguments.
"""
import os
from pathlib import Path
import subprocess
import psycopg
from psycopg import sql

root=Path(__file__).resolve().parents[1]
secrets=dict(line.split('=',1) for line in Path('/etc/ufv/production.env').read_text().splitlines() if '=' in line)
address=subprocess.check_output(['docker','inspect','ufv-postgres-1','--format','{{(index .NetworkSettings.Networks "ufv_backend").IPAddress}}'],text=True).strip()
url=f"postgres://ufv:{secrets['POSTGRES_PASSWORD']}@{address}:5432/ufv"
env={**os.environ,**secrets,'DATABASE_URL':url,'PUBLIC_URL':'https://hire.qpon','NODE_ENV':'production'}
subprocess.run(['node','db/migrate.mjs'],cwd=root,env=env,check=True)
subprocess.run(['node','apps/api/dist/scripts/auth-migrate.js'],cwd=root,env=env,check=True)
with psycopg.connect(url,autocommit=True) as conn:
    for role,key in [('ufv_api','DB_API_PASSWORD'),('ufv_collector','DB_COLLECTOR_PASSWORD'),('ufv_processor','DB_PROCESSOR_PASSWORD')]:
        if not conn.execute('select 1 from pg_roles where rolname=%s',(role,)).fetchone():
            conn.execute(sql.SQL('create role {} login').format(sql.Identifier(role)))
        conn.execute(sql.SQL('alter role {} password {}').format(sql.Identifier(role),sql.Literal(secrets[key])))
    conn.execute('grant usage on schema auth,core,raw to ufv_api,ufv_collector,ufv_processor')
    conn.execute('grant select,insert,update,delete on all tables in schema auth to ufv_api')
    conn.execute('grant usage,select on all sequences in schema auth to ufv_api')
    conn.execute('grant select on all tables in schema core to ufv_api')
    conn.execute('grant insert,update,delete on core.sources,core.workflows,core.modules,core.telegram_accounts,core.review_decisions,core.audit to ufv_api')
    conn.execute('grant insert,update,delete on core.telegram_watch_policies,core.telegram_watch_overrides,core.telegram_imports,core.telegram_jobs to ufv_api')
    conn.execute('grant usage,select on all sequences in schema core to ufv_api')
    conn.execute('grant select on raw.account_status,raw.memberships,raw.source_state,raw.threads,raw.service_status to ufv_api')
    conn.execute('grant select on core.sources,core.workflows,core.modules,core.telegram_accounts to ufv_collector')
    conn.execute('grant select on core.telegram_watch_policies,core.telegram_watch_overrides to ufv_collector')
    conn.execute('grant select,update on core.telegram_jobs to ufv_collector')
    conn.execute('grant select,insert,update,delete on all tables in schema raw to ufv_collector')
    conn.execute('grant usage,select on all sequences in schema raw to ufv_collector')
    conn.execute('grant select on raw.items to ufv_processor')
    conn.execute('grant select on core.sources,core.workflows,core.review_decisions to ufv_processor')
    conn.execute('grant select,insert,update,delete on core.mentions,core.processing_receipts,core.service_status to ufv_processor')
    conn.execute('grant usage,select on sequence core.mentions_id_seq to ufv_processor')
    conn.execute('grant select,insert,update,delete on core.rss_sources to ufv_api')
    conn.execute('grant select on core.rss_sources to ufv_collector')
    exists=conn.execute('select 1 from auth."user" where email=%s',('admin@hire.qpon',)).fetchone()
if not exists:
    password=Path('/etc/ufv/admin-bootstrap.txt').read_text().split('Password: ',1)[1].strip()
    subprocess.run(['node','apps/api/dist/scripts/create-admin.js','admin@hire.qpon','Адміністратор'],cwd=root,env={**env,'ADMIN_PASSWORD':password},check=True)
print('Migrations, runtime database grants and first admin are ready.')
