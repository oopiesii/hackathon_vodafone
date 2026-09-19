"""Read-only production acceptance: counts, drilldowns and response times.

Only signs in to the existing administrator account. No fixture, refresh request,
rights change or message is written. Reports contain counts, never source text.
"""
import json
from pathlib import Path
import time

import httpx

ORIGIN = 'https://hire.qpon'


def main():
    password = Path('/etc/ufv/admin-bootstrap.txt').read_text().split('Password: ', 1)[1].strip()
    with httpx.Client(base_url=ORIGIN, headers={'Origin': ORIGIN}, timeout=30) as client:
        response = client.post('/api/auth/sign-in/email', json={'email': 'admin@hire.qpon', 'password': password})
        del password
        assert response.status_code == 200, 'Production login failed'

        def get(path):
            assert path.startswith('/api/'), 'Only same-origin API paths are allowed'
            response = client.get(path)
            assert response.status_code == 200, f'HTTP {response.status_code}: {path}'
            return response.json()

        for window in ['24h', '7d', '30d']:
            for attempt in range(15):
                started = time.monotonic()
                data = get(f'/api/dashboard?workflow_id=1&window={window}')
                elapsed = time.monotonic() - started
                if data.get('aggregation', {}).get('complete', True):
                    break
                time.sleep(2)
            assert data.get('aggregation', {}).get('complete', True), 'Monthly generation did not become complete'
            assert data['visibility'] == 'accepted', 'Completed semantic workflow must exclude review'
            feed = get('/api' + data['metrics']['mentions']['href'])
            assert feed['total']['count'] == data['metrics']['mentions']['value'], f'{window}: mentions drilldown differs'
            for source in data['sources']:
                rows = get('/api' + source['href'])
                assert rows['total']['count'] == source['count'], f'{window}: source drilldown differs'
            for competitor in data['competitors']:
                rows = get('/api' + competitor['href'])
                assert rows['total']['count'] == competitor['count'], f'{window}: competitor drilldown differs'
            brand = get('/api' + data['vodafone_7d']['href'])
            assert brand['total']['count'] == data['vodafone_7d']['count'], f'{window}: Vodafone drilldown differs'
            assert all(item['brand'] == 'vodafone' and item['decision'] == 'accepted' for item in brand['items'])
            if brand['items']:
                doc = get('/api/documents/' + str(brand['items'][0]['id']))['document']
                assert doc['id'] == brand['items'][0]['id'] and doc['decision'] == 'accepted'
                assert doc['source_url'], 'Evidence has no original source'
            print(json.dumps({'window': window, 'mentions': feed['total']['count'],
                              'vodafone_7d': brand['total']['count'], 'sources_checked': len(data['sources']),
                              'dashboard_seconds': round(elapsed, 3),
                              'aggregate_updated_at': data.get('aggregate_updated_at'),
                              'result': 'PASS'}, ensure_ascii=False), flush=True)
        status = get('/api/admin/ai/status')
        assert all(not source['llm_allowed'] for source in status['sources'] if source['kind'] == 'telegram'), 'Telegram LLM policy changed'
        print(json.dumps({'analyst_mode': status['mode'], 'heartbeat_at': status['heartbeat_at'],
                          'telegram_llm_allowed': 0, 'result': 'PASS'}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
