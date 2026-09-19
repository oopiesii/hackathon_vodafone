"""RSS safety and end-to-end integration. All writes target isolated ufv_checks only."""
import asyncio
from datetime import datetime, timezone, timedelta
import json
import socket
import uuid
from unittest.mock import patch
import httpx
import pytest
from test_runtime import runtime, prepared
from pipeline.db import DB
from pipeline.rss_fetch import parse, FeedError, Response, validate_url, PublicHTTPS, retry_seconds
from pipeline.rss import claim, commit_poll, fail_poll
from pipeline.rss_classification import classify_rss
from pipeline.processor import process
from pipeline.bus import publish_outbox, connect

BASE='https://news.example.org/rss'
def xml(title='Vodafone відновив мобільний інтернет',description='Мережа працює.',link='https://news.example.org/one',guid='1',date='Sat, 19 Sep 2026 12:00:00 +0300'):
    return f'''<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Fixture</title><link>{BASE}</link><description>TEST</description><item><guid>{guid}</guid><link>{link}</link><title>{title}</title><description><![CDATA[{description}]]></description><author>person@example.org</author><pubDate>{date}</pubDate></item></channel></rss>'''.encode()


def setup_rss(prepared,enabled=True):
    db,client,cfg,*_=prepared
    db.execute("insert into core.modules values('rss',true)")
    db.execute('update core.workflows set enabled=true')
    response=client.post('/api/admin/rss/sources',json={'urls':BASE,'workflow_id':1,'permission_note':'Synthetic RSS fixture only, no real publisher content','terms_url':'https://news.example.org/terms','enabled':enabled})
    assert response.status_code==201,response.text
    return db,client,cfg,db.one("select id from core.sources where kind='rss'")['id']


def test_rss_atom_normalization_no_author_or_html():
    items,skipped=parse(xml(description='<p>Перевірка <b>інтернету</b></p><script>evil()</script> email x@y.com +380671234567'),BASE)
    a=items[0]
    assert not skipped and 'author' not in a and 'person@' not in json.dumps(a,default=str)
    assert 'evil' not in a['text'] and '<b>' not in a['text'] and 'x@y.com' not in a['text'] and '+380671234567' not in a['text']
    assert a['published_at'].hour==9 and a['edited_at'] is None
    atom=b'<feed xmlns="http://www.w3.org/2005/Atom"><title>Test</title><entry><id>abc</id><title>Vodafone</title><link href="https://example.org/a"/><summary>Internet</summary><updated>2026-09-19T00:00:00Z</updated></entry></feed>'
    item=parse(atom,BASE)[0][0]
    assert item['published_at'] is None and item['edited_at'].year==2026

@pytest.mark.parametrize('url',['http://example.org/rss','https://127.0.0.1/rss','https://10.0.0.1/','https://[::1]/','https://user:pw@example.org/','https://example.org:8443/','https://metadata.internal/rss'])
def test_unsafe_urls(url):
    with pytest.raises(FeedError):validate_url(url)


def test_dns_rebinding_and_unsafe_xml():
    with patch('socket.getaddrinfo',return_value=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',443))]):
        with pytest.raises(FeedError,match='unsafe_address'):PublicHTTPS('example.org').connect()
    with pytest.raises(FeedError):parse(b'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><rss/>',BASE)
    with pytest.raises(FeedError):parse(b'<html>Access denied</html>',BASE)
    assert retry_seconds('3600')==3600


def test_news_context_false_positives():
    assert classify_rss('Мережа супермаркетів відкрила новий магазин').decision=='rejected'
    assert classify_rss('Уряд підтримав тарифи на електроенергію').decision=='rejected'
    assert classify_rss('Vodafone відновив інтернет у Львові').decision=='accepted'
    assert classify_rss('В Одесі тестують зв’язок 5G').decision=='accepted'


def test_idempotent_edit_304_raw_to_feed_and_roles(prepared):
    db,client,cfg,sid=setup_rss(prepared)
    worker=DB(cfg['COLLECTOR_DATABASE_URL']);processor=DB(cfg['PROCESSOR_DATABASE_URL'])
    try:
        source=claim(worker);assert source['id']==sid
        response=Response(200,xml(),BASE,'"one"',None)
        commit_poll(worker,source,response,*parse(response.data,BASE))
        item=db.one('select * from raw.items where source_id=%s',(sid,))
        process(processor,item['id'])
        assert client.get('/api/feed').json()['items'][0]['source_kind']=='rss'
        inbox=client.get('/api/inbox/'+str(item['id'])).json()
        assert inbox['item']['content_scope']=='excerpt' and inbox['telegram'] is None
        assert client.get('/api/documents/'+str(inbox['item']['mention_id'])).json()['telegram'] is None
        for body in [xml(),None,xml(title='Vodafone відновив мобільний Інтернет')]:
            db.execute('update raw.rss_state set next_poll_at=now() where source_id=%s',(sid,))
            s=claim(worker);assert s
            commit_poll(worker,s,Response(200 if body else 304,body or b'',BASE,'"one"',None),*(parse(body,BASE) if body else ([],0)))
        assert db.one('select count(*) n from raw.items where source_id=%s',(sid,))['n']==1
        assert db.one('select version from raw.items where id=%s',(item['id'],))['version']==2
        assert db.one('select count(*) n from raw.outbox where item_id=%s',(item['id'],))['n']==2
        assert db.one('select count(*) n from raw.item_versions where item_id=%s',(item['id'],))['n']==2
        state=client.get('/api/admin/rss').json();assert state['items'][0]['collected_count']==1
        assert httpx.get(cfg['PUBLIC_URL']+'/api/admin/rss').status_code==401
        assert client.post('/api/admin/rss/module',headers={'Origin':'https://wrong.example'},json={'enabled':False}).status_code==403
    finally:
        worker.pool.close();processor.pool.close()


def test_disabled_inflight_claim_and_retry_after(prepared):
    db,client,cfg,sid=setup_rss(prepared)
    source=claim(db);assert claim(db) is None
    client.post('/api/admin/rss/module',json={'enabled':False})
    commit_poll(db,source,Response(200,xml(),BASE,None,None),*parse(xml(),BASE))
    assert db.one('select count(*) n from raw.items')['n']==0 and claim(db) is None
    client.post('/api/admin/rss/module',json={'enabled':True})
    source=claim(db);fail_poll(db,source,FeedError('http_429',429,3600))
    state=db.one('select * from raw.rss_state where source_id=%s',(sid,))
    assert state['next_poll_at']>datetime.now(timezone.utc)+timedelta(minutes=59)
    assert claim(db) is None
    db.execute('update raw.rss_state set next_poll_at=now()')
    old=claim(db);db.execute("update raw.rss_state set lease_until=now()-interval '1 second'")
    newer=claim(db);assert old['lease_token']!=newer['lease_token']
    commit_poll(db,old,Response(200,xml(),BASE,None,None),*parse(xml(),BASE))
    assert db.one('select count(*) n from raw.items')['n']==0


def test_restricted_source_cannot_toggle_or_bulk_override(prepared):
    db,client,cfg,sid=setup_rss(prepared,False)
    db.execute("update core.rss_sources set rights_status='blocked'")
    assert client.put(f'/api/admin/rss/sources/{sid}',json={'enabled':True,'poll_seconds':300}).status_code==422
    assert claim(db) is None
    r=client.post('/api/admin/rss/sources',json={'urls':BASE,'workflow_id':1,'permission_note':'Another fixture must not override existing restrictions','terms_url':'https://example.org/terms'})
    assert r.json()=={'added':0,'existing':1}
    assert db.one('select rights_status from core.rss_sources')['rights_status']=='blocked'


def test_rss_outbox_event_preserves_source_kind(prepared,monkeypatch):
    db,client,cfg,sid=setup_rss(prepared)
    suffix=uuid.uuid4().hex
    for k in ['NATS_URL','UFV_NATS_STREAM','UFV_NATS_SUBJECT']:
        monkeypatch.setenv(k,cfg[k] + ('_RSS_'+suffix if k=='UFV_NATS_STREAM' else '.rss_check.'+suffix if k=='UFV_NATS_SUBJECT' else ''))
    source=claim(db);commit_poll(db,source,Response(200,xml(),BASE,None,None),*parse(xml(),BASE))
    async def check():
        nc,js=await connect();sub=await nc.subscribe(cfg['UFV_NATS_SUBJECT']+'.rss_check.'+suffix);await nc.flush()
        task=asyncio.create_task(publish_outbox(db,'rss'))
        try:
            message=await sub.next_msg(timeout=5);assert json.loads(message.data)['source_kind']=='rss'
        finally:
            task.cancel();await asyncio.gather(task,return_exceptions=True);await js.delete_stream(cfg['UFV_NATS_STREAM']+'_RSS_'+suffix);await nc.close()
    asyncio.run(check())
