"""S2 dashboard reads current proofs; mixed operator aggregates never leak to viewers."""
from test_runtime import runtime, prepared
from test_dashboard import post, role_client
from test_analyst import mock_llm
from analyst.provider import make_provider, NullProvider, Config
from analyst.summary import summarize_window


def setup_source(db, prepared_source):
    db.execute('update core.workflows set enabled=true where id=1')
    source=db.one("""insert into core.sources(kind,external_id,title,workflow_id,enabled,permission_note,llm_allowed,llm_basis)
        values('rss','https://example.test/summary','Synthetic S2 evidence',1,true,'Synthetic checks only',true,'Synthetic checks authorization') returning *""")
    db.execute("insert into core.rss_sources(source_id,rights_status,terms_url,publisher) values(%s,'allowed','https://example.test/terms','Synthetic')",(source['id'],))
    db.execute("""insert into core.analyst_state(singleton,mode,model) values(true,'active','synthetic-model')
        on conflict(singleton) do update set heartbeat_at=now(),mode='active',model='synthetic-model'""")
    db.execute('delete from core.analyst_budget')
    return {**prepared_source,**source}


def test_s2_dashboard_three_roles_exact_evidence_scope_and_revocation(prepared,mock_llm):
    db,admin,cfg,source,_=prepared
    source=setup_source(db,source)
    mention=post(db,source,10,'Vodafone не працює інтернет: синтетичний доказ S2.')
    db.execute('select core.refresh_dashboard_rollups()')
    _,config=mock_llm
    assert summarize_window(db,1,'24h',make_provider(config),config)=='ai'
    analyst=role_client(admin,cfg,'analyst');viewer=role_client(admin,cfg,'viewer')
    try:
        for client in [admin,analyst,viewer]:
            result=client.get('/api/dashboard').json()['ai']
            assert result['mode']=='ai' and result['status']=='ready',result
            assert result['model']==config.model and result['generated_at']
            evidence=result['observations'][0]['evidence'][0]
            assert evidence['id']==str(mention)
            saved=db.one('select quote,url from core.mentions where id=%s',(mention,))
            assert evidence['quote'] in saved['quote'] and evidence['url']==saved['url']
            assert client.get('/api'+evidence['href']).status_code==200
            assert client.get('/api'+result['href']).status_code==200
            assert 'provenance' not in result and 'source_ids' not in result
        # Source revocation invalidates the whole model body, including its headline.
        db.execute('update core.sources set llm_allowed=false where id=%s',(source['id'],))
        assert admin.get('/api/dashboard').json()['ai']['mode']=='rules'
        assert viewer.get('/api/dashboard').json()['ai']['mode']=='rules'
        # A summary from a different workflow cannot be selected by the default dashboard.
        assert admin.get('/api/dashboard?workflow_id=999999').status_code==404
    finally:analyst.close();viewer.close()


def test_s2_dashboard_mixed_input_is_operator_only_and_null_provider_is_honest(prepared,mock_llm):
    db,admin,cfg,source,_=prepared
    source=setup_source(db,source)
    post(db,source,10,'Vodafone не працює інтернет: прийнятий доказ.')
    post(db,source,11,'НЕПУБЛІЧНИЙ_ДЛЯ_VIEWER нетематичний кулінарний матеріал.')
    db.execute('select core.refresh_dashboard_rollups()')
    _,config=mock_llm
    assert summarize_window(db,1,'24h',make_provider(config),config)=='ai'
    viewer=role_client(admin,cfg,'viewer');analyst=role_client(admin,cfg,'analyst')
    try:
        assert admin.get('/api/dashboard').json()['ai']['mode']=='ai'
        assert analyst.get('/api/dashboard').json()['ai']['mode']=='ai'
        response=viewer.get('/api/dashboard')
        assert response.json()['ai']['mode']=='rules'
        assert 'НЕПУБЛІЧНИЙ_ДЛЯ_VIEWER' not in response.text
        assert response.json()['ai']['generated_at'] is None
        assert response.json()['metrics']['mentions']['value']==1
        # Fresh state without a key is specifically waiting_key, never a fabricated AI result.
        db.execute("update core.analyst_state set mode='waiting_key',heartbeat_at=now()")
        assert summarize_window(db,1,'7d',NullProvider(),Config())=='rules'
        # Saved legacy templates called effective curated counts "rules". The API
        # must reconstruct the template from this permitted scope's own counts.
        db.execute("""update core.ai_summaries set body=jsonb_set(body,'{headline}',
            '\"За вікно: 2 дозволених матеріалів; 1 прийнято правилами.\"'::jsonb)
            where workflow_id=1 and mode='rules'""")
        result=admin.get('/api/dashboard?window=7d').json()['ai']
        assert result['status']=='waiting_key' and result['label']=='AI очікує ключ'
        assert result['mode']=='rules' and result['generated_at']
        assert 'прийнято правилами' not in result['summary']
        assert 'дозволом на AI: 2; прийнятих: 1.' in result['summary']
        assert result['coverage']['scope']=='allowed_sources'
        db.execute("update core.analyst_state set heartbeat_at=now()-interval '10 minutes'")
        assert admin.get('/api/dashboard?window=7d').json()['ai']['status']=='unavailable'
    finally:viewer.close();analyst.close()


def test_s2_dashboard_review_expiry_month_dirty_and_recompute(prepared,mock_llm):
    db,admin,cfg,source,_=prepared
    source=setup_source(db,source)
    mention=post(db,source,10,'Vodafone не працює інтернет: перевірка актуальності.')
    db.execute('select core.refresh_dashboard_rollups()')
    _,config=mock_llm
    for window in ['24h','30d']:
        assert summarize_window(db,1,window,make_provider(config),config)=='ai'
        assert admin.get('/api/dashboard?window='+window).json()['ai']['mode']=='ai'
    assert admin.post(f'/api/admin/documents/{mention}/review',json={'decision':'rejected'}).status_code==200
    for window in ['24h','30d']:
        assert admin.get('/api/dashboard?window='+window).json()['ai']['mode']=='rules'
    db.execute('select core.refresh_dashboard_rollups()')
    assert admin.get('/api/dashboard?window=30d').json()['ai']['mode']=='rules'
    assert admin.post(f'/api/admin/documents/{mention}/review',json={'decision':'accepted'}).status_code==200
    db.execute('select core.refresh_dashboard_rollups()')
    assert summarize_window(db,1,'24h',make_provider(config),config)=='ai'
    db.execute("update core.ai_summaries set generated_at=now()-interval '31 minutes' where workflow_id=1")
    assert admin.get('/api/dashboard').json()['ai']['mode']=='rules'
    assert summarize_window(db,1,'24h',make_provider(config),config)=='ai'
    db.execute('update raw.items set version=version+1 where id=(select raw_item_id from core.mentions where id=%s)',(mention,))
    assert admin.get('/api/dashboard').json()['ai']['mode']=='rules'
