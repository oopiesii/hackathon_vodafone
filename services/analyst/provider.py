"""Вузька JSON-межа провайдера. Немає tools, файлового доступу чи HTTP redirects."""
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler

from .validation import check_schema

RUNTIME_KEYS = ('UFV_LLM_PROVIDER', 'UFV_LLM_API_KEY', 'UFV_LLM_MODEL',
                'UFV_LLM_MAX_ITEMS_PER_HOUR', 'UFV_LLM_BASE_URL', 'UFV_LLM_ALLOWED_HOSTS')
DEFAULT_HOSTS = {'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'}


class ProviderError(Exception):
    """Лише контрольований код; ніколи відповідь провайдера, URL або credential."""


@dataclass(frozen=True)
class Config:
    provider: str = 'null'
    key: str = field(default='', repr=False)
    model: str = ''
    max_items_per_hour: int = 60
    base_url: str = ''
    allowed_hosts: frozenset = frozenset(DEFAULT_HOSTS)
    local_test: bool = False

    @property
    def enabled(self):
        return self.provider in ('anthropic', 'openai-compatible', 'local-runtime') and bool(self.key and self.model)


def load_config():
    values = {k: os.environ.get(k, '') for k in RUNTIME_KEYS}
    path = os.environ.get('UFV_LLM_RUNTIME_FILE')
    if path:
        try:
            # Mount the directory, so an atomic file replacement is visible without restart.
            content = Path(path).read_text()
            if len(content) > 32768:
                raise ProviderError('runtime_config_invalid')
            for line in content.splitlines():
                key, sep, value = line.partition('=')
                if sep and key in RUNTIME_KEYS:
                    values[key] = value.strip()
        except OSError:
            # Missing/unreadable hot config must never retain a previous key.
            return Config()
    try:
        cap = int(values['UFV_LLM_MAX_ITEMS_PER_HOUR'] or '60')
    except ValueError:
        raise ProviderError('runtime_config_invalid') from None
    if not 0 <= cap <= 10000:
        raise ProviderError('runtime_config_invalid')
    provider = values['UFV_LLM_PROVIDER'] or 'null'
    if provider not in ('null', 'anthropic', 'openai-compatible', 'local-runtime'):
        raise ProviderError('runtime_config_invalid')
    model = values['UFV_LLM_MODEL']
    if len(model) > 200 or any(ord(c) < 32 for c in model):
        raise ProviderError('runtime_config_invalid')
    return Config(provider, values['UFV_LLM_API_KEY'], model, cap,
                  values['UFV_LLM_BASE_URL'],
                  frozenset(DEFAULT_HOSTS | {h.strip().lower() for h in values['UFV_LLM_ALLOWED_HOSTS'].split(',') if h.strip()}))


class LLMProvider(Protocol):
    def complete_json(self, task: str, schema: dict, payload: dict) -> dict | None: ...


class NullProvider:
    def complete_json(self, task, schema, payload):
        return None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProviderError('provider_redirect_refused')


class HTTPProvider:
    timeout = 45

    def __init__(self, config):
        self.config = config
        base = config.base_url or self.default_base
        parts = urlsplit(base)
        local = config.local_test and parts.hostname in ('127.0.0.1', '::1') and parts.scheme == 'http'
        if (not local and (parts.scheme != 'https' or parts.hostname not in config.allowed_hosts)) or parts.username or parts.password or parts.query or parts.fragment:
            raise ProviderError('provider_endpoint_not_allowed')
        self.url = base.rstrip('/') + self.suffix

    def request(self, body, headers):
        req = Request(self.url, data=json.dumps(body, ensure_ascii=False).encode(),
                      headers={'Content-Type': 'application/json', **headers}, method='POST')
        # No ambient proxy credentials, no redirects forwarding the API key.
        opener = build_opener(NoRedirect(), ProxyHandler({}))
        try:
            with opener.open(req, timeout=self.timeout) as response:
                data = response.read(1_048_577)
            if len(data) > 1_048_576:
                raise ProviderError('provider_response_too_large')
            return json.loads(data)
        except HTTPError as error:
            raise ProviderError('provider_rate_limited' if error.code == 429 else 'provider_runtime_disabled' if error.code == 409 else 'provider_http_error') from None
        except (URLError, TimeoutError, OSError):
            raise ProviderError('provider_unavailable') from None
        except (ValueError, UnicodeError):
            raise ProviderError('provider_invalid_json') from None

    def complete_json(self, task, schema, payload):
        try:
            output = self.infer(task, schema, payload)
            check_schema(output, schema)
            return output
        except (KeyError, IndexError, TypeError, ValueError):
            raise ProviderError('provider_invalid_output') from None


class OpenAICompatibleProvider(HTTPProvider):
    default_base = 'https://api.openai.com/v1'
    suffix = '/chat/completions'

    def infer(self, task, schema, payload):
        reply = self.request({
            'model': self.config.model, 'temperature': 0, 'max_tokens': 5000,
            'messages': [{'role': 'system', 'content': task},
                         {'role': 'user', 'content': 'UNTRUSTED_INPUT_JSON:\n' + json.dumps(payload, ensure_ascii=False)}],
            'response_format': {'type': 'json_schema', 'json_schema': {'name': 'ufv_result', 'strict': True, 'schema': schema}},
        }, {'Authorization': 'Bearer ' + self.config.key})
        if reply['choices'][0].get('finish_reason') != 'stop':
            raise ProviderError('provider_incomplete_output')
        return json.loads(reply['choices'][0]['message']['content'])


class AnthropicProvider(HTTPProvider):
    default_base = 'https://api.anthropic.com/v1'
    suffix = '/messages'

    def infer(self, task, schema, payload):
        reply = self.request({
            'model': self.config.model, 'max_tokens': 5000, 'temperature': 0,
            'system': task + '\nПоверніть лише JSON без markdown. JSON_SCHEMA:\n' + json.dumps(schema),
            'messages': [{'role': 'user', 'content': 'UNTRUSTED_INPUT_JSON:\n' + json.dumps(payload, ensure_ascii=False)}],
        }, {'x-api-key': self.config.key, 'anthropic-version': '2023-06-01'})
        if reply.get('stop_reason') != 'end_turn':
            raise ProviderError('provider_incomplete_output')
        return json.loads(''.join(part['text'] for part in reply['content'] if part['type'] == 'text'))


class LocalRuntimeProvider(OpenAICompatibleProvider):
    """Локальний рантайм Claude Code через services/runtime-bridge (лише демо).

    Місток стоїть на тому самому сервері, тому дозволено http — але тільки до хоста, явно названого в
    UFV_LLM_ALLOWED_HOSTS, і тільки якщо це loopback, приватна адреса або host.docker.internal.
    Вимкнений перемикач містка (409) означає «моделі немає»: повертаємо None, і діють правила.
    """
    timeout = 180

    def __init__(self, config):
        self.config = config
        parts = urlsplit(config.base_url)
        host = (parts.hostname or '').lower()
        explicit = {h for h in config.allowed_hosts if h not in DEFAULT_HOSTS}
        private = host in ('localhost', 'host.docker.internal') or host.startswith(('127.', '10.', '192.168.')) \
            or any(host.startswith(f'172.{n}.') for n in range(16, 32))
        if (parts.scheme not in ('http', 'https') or host not in explicit or not private
                or parts.username or parts.password or parts.query or parts.fragment):
            raise ProviderError('provider_endpoint_not_allowed')
        self.url = config.base_url.rstrip('/') + self.suffix

    def complete_json(self, task, schema, payload):
        try:
            return super().complete_json(task, schema, payload)
        except ProviderError as error:
            if str(error) == 'provider_runtime_disabled':
                return None
            raise


def make_provider(config):
    if not config.enabled:
        return NullProvider()
    return {'anthropic': AnthropicProvider, 'local-runtime': LocalRuntimeProvider}.get(config.provider, OpenAICompatibleProvider)(config)
