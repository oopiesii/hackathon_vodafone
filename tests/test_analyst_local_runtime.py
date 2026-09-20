"""Провайдер локального рантайму: без справжнього містка й без мережі — контрольований HTTP-сервер на 127.0.0.1."""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
from analyst.provider import Config, LocalRuntimeProvider, NullProvider, ProviderError, make_provider
from analyst.validation import obj

SCHEMA = obj({'ok': {'type': 'string'}})


@pytest.fixture
def bridge():
    state = {'status': 200, 'seen': []}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            state['seen'].append((self.path, self.headers.get('Authorization'), body))
            reply = {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps({'ok': 'так'})}}]} if state['status'] == 200 else {'error': {'code': 'runtime_disabled'}}
            data = json.dumps(reply).encode()
            self.send_response(state['status']); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = HTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield state, f'http://127.0.0.1:{server.server_port}/v1'
    server.shutdown()


def config(url, hosts=('127.0.0.1',), key='t' * 32):
    return Config('local-runtime', key, 'claude-opus-5', 60, url, frozenset(hosts))


def test_calls_bridge_in_openai_format_with_bearer_token(bridge):
    state, url = bridge
    provider = make_provider(config(url))
    assert isinstance(provider, LocalRuntimeProvider)
    assert provider.complete_json('завдання', SCHEMA, {'items': []}) == {'ok': 'так'}
    path, auth, body = state['seen'][0]
    assert path == '/v1/chat/completions' and auth == 'Bearer ' + 't' * 32
    assert body['response_format']['json_schema']['schema'] == SCHEMA and body['messages'][0] == {'role': 'system', 'content': 'завдання'}


def test_disabled_switch_means_no_model_not_an_error(bridge):
    state, url = bridge
    state['status'] = 409
    assert make_provider(config(url)).complete_json('завдання', SCHEMA, {}) is None


def test_other_bridge_failures_stay_errors(bridge):
    state, url = bridge
    state['status'] = 502
    with pytest.raises(ProviderError):
        make_provider(config(url)).complete_json('завдання', SCHEMA, {})


@pytest.mark.parametrize('url,hosts', [
    ('http://example.com/v1', ('example.com',)),          # публічний хост, навіть якщо його назвали
    ('http://8.8.8.8/v1', ('8.8.8.8',)),
    ('http://172.18.0.1:8790/v1', ()),                    # приватний, але не названий явно
    ('http://user:pw@127.0.0.1:8790/v1', ('127.0.0.1',)),
    ('ftp://127.0.0.1/v1', ('127.0.0.1',)),
])
def test_only_explicitly_named_private_hosts_are_allowed(url, hosts):
    with pytest.raises(ProviderError):
        make_provider(config(url, hosts))


def test_docker_gateway_and_host_alias_are_accepted():
    for url, host in (('http://172.18.0.1:8790/v1', '172.18.0.1'), ('http://host.docker.internal:8790/v1', 'host.docker.internal')):
        assert isinstance(make_provider(config(url, (host,))), LocalRuntimeProvider)


def test_without_token_or_model_it_is_off():
    assert isinstance(make_provider(config('http://127.0.0.1:8790/v1', key='')), NullProvider)
