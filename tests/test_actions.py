from test_runtime import runtime, prepared
from test_dashboard import role_client, post


def test_document_actions_admin_audit_viewer_read_and_brand_status(prepared):
    db,admin,cfg,source,_=prepared
    # Two negative sources create the medium signal; one item per source.
    first=post(db,source,10,'Vodafone не працює інтернет',views=20)
    second_id=db.one("insert into core.sources(kind,external_id,workflow_id,permission_note) values('rss','https://example.test/second',1,'Synthetic tests only') returning id")['id']
    second=post(db,{**source,'id':second_id},11,'Vodafone не працює інтернет',views=20)
    analyst=role_client(admin,cfg,'analyst');viewer=role_client(admin,cfg,'viewer')
    try:
        assert admin.get('/api/dashboard').json()['brand_status']['level']=='attention'
        assert viewer.get(f'/api/documents/{first}').json()['document']['action']=='none'
        for client in [viewer,analyst]:
            assert client.put(f'/api/admin/documents/{first}/action',json={'status':'resolved'}).status_code==403
        assert admin.put(f'/api/admin/documents/{first}/action',json={'status':'resolved'},headers={'Origin':'https://other.test'}).status_code==403
        assert admin.put(f'/api/admin/documents/{first}/action',json={'status':'invented'}).status_code==422
        assert admin.put('/api/admin/documents/999999/action',json={'status':'resolved'}).status_code==404
        for mid in [first,second]:
            response=admin.put(f'/api/admin/documents/{mid}/action',json={'status':'resolved'})
            assert response.status_code==200,response.text
        assert viewer.get(f'/api/documents/{first}').json()['document']['action']=='resolved'
        dash=viewer.get('/api/dashboard').json()
        assert dash['signals'][0]['action']=='resolved'
        assert dash['brand_status']['level']=='calm'
        assert db.one("select count(*) n from core.audit where action='action_resolved'")['n']==2
    finally:analyst.close();viewer.close()
