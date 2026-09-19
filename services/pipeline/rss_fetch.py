"""Bounded, public-HTTPS-only RSS/Atom fetching. No full article crawling or authors."""
import hashlib
import http.client
import ipaddress
import re
import socket
import ssl
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
import feedparser
from .classification import normalize

MAX_BYTES = 4 * 1024 * 1024
MAX_ITEMS = 500
UA = 'UFV-RSS/1.0 (+https://hire.qpon)'


class FeedError(Exception):
    def __init__(self, code, status=None, retry_after=None):
        self.code, self.status, self.retry_after = code, status, retry_after
        super().__init__(code)


def validate_url(url):
    try:
        p = urlsplit(url)
        if p.scheme != 'https' or not p.hostname or p.username or p.password or p.port not in (None, 443):
            raise ValueError()
        if len(url) > 2048 or any(ord(c) < 33 for c in url) or p.fragment:
            raise ValueError()
        host = p.hostname.encode('idna').decode()
        if '.' not in host or host.endswith(('.local', '.internal', '.localhost')):
            raise ValueError()
        try:
            if not ipaddress.ip_address(host).is_global:
                raise ValueError()
        except ValueError:
            # Distinguish a DNS name from a private IP address.
            if re.fullmatch(r'[\d.:a-fA-F]+', host):
                raise
        return p
    except (ValueError, UnicodeError):
        raise FeedError('unsafe_url') from None


class PublicHTTPS(http.client.HTTPSConnection):
    def connect(self):
        # Resolve ONCE, validate EVERY result, connect to that exact address; SNI stays the hostname.
        addresses = socket.getaddrinfo(self.host, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise FeedError('unsafe_address')
        last = None
        for family, socktype, proto, _, sockaddr in addresses:
            sock = socket.socket(family, socktype, proto)
            sock.settimeout(self.timeout)
            try:
                sock.connect(sockaddr)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
                return
            except OSError as exc:
                sock.close()
                last = exc
        raise last or FeedError('connection_failed')


def retry_seconds(value):
    if not value:
        return None
    try:
        seconds = int(value)
    except ValueError:
        try:
            seconds = int((parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
        except (ValueError, TypeError, OverflowError):
            return None
    return max(120, min(seconds, 31536000))


@dataclass
class Response:
    status: int
    data: bytes
    url: str
    etag: str | None
    last_modified: str | None


def fetch(url, etag=None, last_modified=None):
    headers = {'User-Agent': UA, 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml',
               'Accept-Encoding': 'identity'}
    if etag:
        headers['If-None-Match'] = etag
    if last_modified:
        headers['If-Modified-Since'] = last_modified
    for _ in range(4):
        p = validate_url(url)
        conn = PublicHTTPS(p.hostname.encode('idna').decode(), timeout=12, context=ssl.create_default_context())
        try:
            conn.request('GET', urlunsplit(('', '', p.path or '/', p.query, '')), headers=headers)
            r = conn.getresponse()
            if r.status in (301, 302, 303, 307, 308):
                location = r.getheader('Location')
                if not location:
                    raise FeedError('invalid_redirect')
                url = urljoin(url, location)
                headers.pop('If-None-Match', None)
                headers.pop('If-Modified-Since', None)
                continue
            if r.status == 304:
                return Response(304, b'', url, r.getheader('ETag'), r.getheader('Last-Modified'))
            if r.status != 200:
                raise FeedError('http_' + str(r.status), r.status, retry_seconds(r.getheader('Retry-After')))
            if r.getheader('Content-Encoding', 'identity') not in ('', 'identity'):
                raise FeedError('unsupported_encoding')
            chunks, length, deadline = [], 0, time.monotonic()+35
            while True:
                if time.monotonic()>deadline:
                    raise FeedError('response_timeout')
                chunk = r.read1(min(65536, MAX_BYTES+1-length))
                if not chunk:
                    break
                chunks.append(chunk)
                length += len(chunk)
                if length>MAX_BYTES:
                    raise FeedError('feed_too_large')
            data = b''.join(chunks)
            return Response(200, data, url, r.getheader('ETag'), r.getheader('Last-Modified'))
        finally:
            conn.close()
    raise FeedError('too_many_redirects')


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'iframe', 'noscript'):
            self.hidden += 1
        elif tag in ('p', 'br', 'div', 'li'):
            self.parts.append(' ')

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'iframe', 'noscript'):
            self.hidden = max(0, self.hidden - 1)
        elif tag in ('p', 'div', 'li'):
            self.parts.append(' ')

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def plain(text):
    p = PlainText()
    p.feed(str(text)[:100_000])
    return normalize(''.join(p.parts))


def canonical_url(value, base):
    p = urlsplit(urljoin(base, value))
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password:
        return None
    if p.port not in (None, 80, 443) or '.' not in p.hostname or p.hostname.endswith(('.local', '.internal')):
        return None
    try:
        if not ipaddress.ip_address(p.hostname).is_global:
            return None
    except ValueError:
        pass
    query = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
             if not k.lower().startswith('utm_') and k.lower() not in ('fbclid', 'gclid')]
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path or '/', urlencode(query), ''))[:2048]


def timestamp(parts):
    if not parts:
        return None
    try:
        return datetime(*parts[:6], tzinfo=timezone.utc)
    except (ValueError, TypeError, OverflowError):
        return None


def parse(data, base):
    if re.search(br'<!\s*(DOCTYPE|ENTITY)\b', data, re.I):
        raise FeedError('unsafe_xml')
    feed = feedparser.parse(data)
    if not feed.get('version') or feed.get('bozo'):
        raise FeedError('invalid_feed')
    if len(feed.entries) > MAX_ITEMS:
        raise FeedError('too_many_items')
    articles, skipped = [], 0
    for entry in feed.entries:
        try:
            url = canonical_url(entry.get('link', ''), base) if entry.get('link') else None
            title = plain(entry.get('title', ''))[:600]
            # Only the feed's explicit summary; do NOT silently use content:encoded/full article.
            summary = plain(entry.get('summary', ''))[:2400]
            if not url or not (title or summary):
                skipped += 1
                continue
            guid = str(entry.get('id') or url)
            text = title + ('\n' + summary if summary and summary != title else '')
            articles.append(dict(source_item_id=hashlib.sha256(guid.encode()).hexdigest(), url=url,
                                 title=title, text=text, content_hash=hashlib.sha256(text.encode()).hexdigest(),
                                 published_at=timestamp(entry.get('published_parsed')),
                                 edited_at=timestamp(entry['updated_parsed']) if 'updated_parsed' in entry else None))
        except (ValueError, TypeError, UnicodeError):
            skipped += 1
    return articles, skipped
