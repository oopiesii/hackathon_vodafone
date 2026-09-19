"""Explicit catalog import; only approved excerpt sources enabled. Reads DATABASE_URL from environment."""
import argparse
import json
import os
from pathlib import Path
import psycopg


def seed(conn, enable=False, workflow_id=1):
    catalog=json.loads((Path(__file__).resolve().parents[1]/'services/collector-rss/catalog.json').read_text())
    added=0
    for s in catalog['sources']:
        row=conn.execute("""insert into core.sources(kind,external_id,title,enabled,workflow_id,permission_note)
            values('rss',%s,%s,%s,%s,%s) on conflict(kind,external_id) do nothing returning id""",
            (s['url'],s['title'],enable and s['rights_status']=='allowed',workflow_id,s['permission_note'])).fetchone()
        if not row:
            continue
        conn.execute('''insert into core.rss_sources(source_id,rights_status,terms_url,publisher)
            values(%s,%s,%s,%s)''',(row[0],s['rights_status'],s['terms_url'],s['publisher']))
        added+=1
    conn.execute("insert into core.modules(name,enabled) values('rss',%s) on conflict(name) do nothing",(enable,))
    if enable:
        conn.execute("update core.modules set enabled=true where name='rss'")
        conn.execute('update core.workflows set enabled=true where id=%s',(workflow_id,))
    return added

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--enable',action='store_true');p.add_argument('--workflow-id',type=int,default=1);args=p.parse_args()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        print('RSS catalog sources added:',seed(conn,args.enable,args.workflow_id))
