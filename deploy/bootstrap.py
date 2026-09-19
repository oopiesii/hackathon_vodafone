"""Run as root on the deployment host after building Node artifacts and starting Postgres.

Credentials are read from a protected file and are never passed as CLI arguments.
"""
import os
from pathlib import Path
import subprocess
import secrets as random_secrets
import psycopg
from psycopg import sql
from analyst_grants import grant_analyst

root=Path(__file__).resolve().parents[1]
secrets=dict(line.split('=',1) for line in Path('/etc/ufv/production.env').read_text().splitlines() if '=' in line)
if not secrets.get('DB_ANALYST_PASSWORD'):
    secrets['DB_ANALYST_PASSWORD']=random_secrets.token_hex(24)
    with Path('/etc/ufv/production.env').open('a') as target:
        target.write('\nDB_ANALYST_PASSWORD='+secrets['DB_ANALYST_PASSWORD']+'\n')
# Optional LLM-only hot overrides; production.env is never mounted into analyst.
runtime_dir=Path('/etc/ufv/analyst')
runtime_dir.mkdir(mode=0o750,exist_ok=True)
os.chown(runtime_dir,0,10001)
runtime_file=runtime_dir/'runtime.env'
if not runtime_file.exists():
    fd=os.open(runtime_file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
    with os.fdopen(fd,'w') as target:
        target.write('# Optional UFV_LLM_* hot overrides; defaults come from production.env.\n')
    os.chown(runtime_file,0,10001)
address=subprocess.check_output(['docker','inspect','ufv-postgres-1','--format','{{(index .NetworkSettings.Networks "ufv_backend").IPAddress}}'],text=True).strip()
url=f"postgres://ufv:{secrets['POSTGRES_PASSWORD']}@{address}:5432/ufv"
env={**os.environ,**secrets,'DATABASE_URL':url,'PUBLIC_URL':'https://hire.qpon','NODE_ENV':'production'}
subprocess.run(['node','db/migrate.mjs'],cwd=root,env=env,check=True)
subprocess.run(['node','apps/api/dist/scripts/auth-migrate.js'],cwd=root,env=env,check=True)
with psycopg.connect(url,autocommit=True) as conn:
    for role,key in [('ufv_api','DB_API_PASSWORD'),('ufv_collector','DB_COLLECTOR_PASSWORD'),('ufv_processor','DB_PROCESSOR_PASSWORD'),('ufv_analyst','DB_ANALYST_PASSWORD')]:
        if not conn.execute('select 1 from pg_roles where rolname=%s',(role,)).fetchone():
            conn.execute(sql.SQL('create role {} login').format(sql.Identifier(role)))
        conn.execute(sql.SQL('alter role {} password {}').format(sql.Identifier(role),sql.Literal(secrets[key])))
    conn.execute('grant usage on schema auth,core,raw to ufv_api,ufv_collector,ufv_processor')
    conn.execute('grant select,insert,update,delete on all tables in schema auth to ufv_api')
    conn.execute('grant usage,select on all sequences in schema auth to ufv_api')
    conn.execute('grant select on all tables in schema core to ufv_api')
    conn.execute('grant insert,update,delete on core.sources,core.workflows,core.modules,core.telegram_accounts,core.review_decisions,core.audit to ufv_api')
    conn.execute('grant insert,update,delete on core.telegram_watch_policies,core.telegram_watch_overrides,core.telegram_imports,core.telegram_jobs to ufv_api')
    conn.execute('grant insert,update on core.action_status,core.refresh_requests to ufv_api')
    conn.execute('grant usage,select on all sequences in schema core to ufv_api')
    conn.execute('grant select on raw.account_status,raw.memberships,raw.source_state,raw.threads,raw.service_status to ufv_api')
    conn.execute('grant select on core.sources,core.workflows,core.modules,core.telegram_accounts to ufv_collector')
    conn.execute('grant select on core.telegram_watch_policies,core.telegram_watch_overrides to ufv_collector')
    conn.execute('grant select,update on core.telegram_jobs to ufv_collector')
    conn.execute('grant select,update on core.refresh_requests to ufv_collector')
    conn.execute('grant select,insert,update,delete on all tables in schema raw to ufv_collector')
    conn.execute('grant usage,select on all sequences in schema raw to ufv_collector')
    conn.execute('grant select on raw.items to ufv_processor')
    conn.execute('grant select on core.sources,core.workflows,core.review_decisions to ufv_processor')
    conn.execute('grant select,insert,update,delete on core.mentions,core.processing_receipts,core.service_status to ufv_processor')
    conn.execute('grant usage,select on sequence core.mentions_id_seq to ufv_processor')
    conn.execute('grant execute on function core.refresh_dashboard_rollups() to ufv_processor')
    conn.execute('grant select,insert,update,delete on core.rss_sources to ufv_api')
    conn.execute('grant select on core.rss_sources to ufv_collector')
    grant_analyst(conn)
    exists=conn.execute('select 1 from auth."user" where email=%s',('admin@hire.qpon',)).fetchone()
if not exists:
    password=Path('/etc/ufv/admin-bootstrap.txt').read_text().split('Password: ',1)[1].strip()
    subprocess.run(['node','apps/api/dist/scripts/create-admin.js','admin@hire.qpon','Адміністратор'],cwd=root,env={**env,'ADMIN_PASSWORD':password},check=True)
print('Migrations, runtime database grants and first admin are ready.')
