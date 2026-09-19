"""Import a reviewed daily web-search digest. Does not schedule or fabricate searches."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
from urllib.parse import urlparse
import psycopg


def main(path):
    data=json.loads(Path(path).read_text())
    searched=datetime.fromisoformat(data['searched_at'])
    if searched.tzinfo is None:
        raise ValueError('searched_at_requires_timezone')
    for item in data['items']:
        url=urlparse(item['url'])
        if url.scheme!='https' or not url.netloc or url.username or url.password:
            raise ValueError('invalid_source_url')
        if len(item['evidence_quote'].split())>25:
            raise ValueError('quote_too_long')
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        for item in data['items']:
            conn.execute('''insert into core.search_briefs(workflow_id,searched_at,query,url,publisher,title,
                published_on,summary,evidence_quote,topic,verification)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                on conflict(workflow_id,searched_at,url) do update set publisher=excluded.publisher,
                title=excluded.title,published_on=excluded.published_on,summary=excluded.summary,
                evidence_quote=excluded.evidence_quote,topic=excluded.topic,verification=excluded.verification''',
                (data['workflow_id'],searched,data['query'],item['url'],item['publisher'],item['title'],
                 item['published_on'],item['summary'],item['evidence_quote'],item['topic'],item['verification']))
    print(f"Search digest: {len(data['items'])} records imported; automatic search is not enabled.")


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('file')
    main(p.parse_args().file)
