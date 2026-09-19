"""Context, screening completeness and evidence checks; no live data required."""
import copy
from pathlib import Path
import sys
import pytest

sys.path.insert(0,str(Path(__file__).parents[1]/'scripts'))
from analyze_telegram_agy import enrich,validate_screen,validate_details,pack,screen_payload,save_labels


def row(id,text,parent=None,source=1,deleted=False):
    return dict(id=id,source_id=source,source_item_id=str(id),parent_item_id=parent,
                thread_item_id=None,text=text,version=1,kind='comment' if parent else 'post',deleted=deleted)


def test_reply_context_changes_semantic_group_and_deleted_is_excluded():
    rows,_=enrich([row(1,'Vodafone не працює'),row(2,'Електрика не працює'),
                   row(3,'У мене теж','1'),row(4,'У мене теж','2'),row(5,'old',deleted=True)])
    assert len(rows)==4
    assert rows[2]['semantic_group']!=rows[3]['semantic_group']
    assert rows[2]['context'][0]['text']=='Vodafone не працює'


def test_missing_context_does_not_attach_other_sources():
    rows,_=enrich([row(1,'Vodafone',source=2),row(2,'У мене теж','1')])
    assert rows[1]['context']==[]
    assert rows[1]['missing_parent_key']=='1'


def test_reply_cycle_stops():
    rows,_=enrich([row(1,'A','2'),row(2,'B','1')])
    assert len(rows[0]['context'])==1


@pytest.mark.parametrize('change',[
    {'reviewed_count':0},{'batch':'wrong'},{'candidate_ids':[2]},
    {'candidate_ids':[1,1]},{'candidate_ids':[1],'uncertain_ids':[1]},
])
def test_screen_rejects_incomplete_or_wrong_ids(change):
    output=dict(batch='batch',reviewed_count=1,candidate_ids=[],uncertain_ids=[])
    output.update(change)
    with pytest.raises(ValueError):validate_screen(output,[{'id':1}],'batch')


def test_aspect_must_quote_own_message():
    rows,_=enrich([row(1,'Vodafone не працює'),row(2,'У мене теж','1')])
    label=dict(id=2,decision='relevant',relevance='vodafone',brands=['vodafone'],
               topic='outage',sentiment='negative',summary='Скарга',reason='Відповідь',
               evidence=[{'id':2,'quote':'У мене теж'}],aspects=[dict(brand='vodafone',
               topic='outage',sentiment='negative',cause='Не працює',evidence=[{'id':1,'quote':'Vodafone'}])])
    with pytest.raises(ValueError):validate_details({'items':[label]},[rows[1]])
    label['aspects'][0]['evidence'].append({'id':2,'quote':'У мене теж'})
    assert validate_details({'items':[label]},[rows[1]])['items'][0]['id']==2


def test_shared_parent_packing_preserves_all_messages_with_bounded_payload():
    import json
    rows,_=enrich([row(1,'Vodafone '+('контекст '*300))]+[row(i,'У мене теж','1') for i in range(2,102)])
    batches=list(pack(rows[1:],byte_limit=15000))
    assert sum(len(b) for b in batches)==100
    assert [r['id'] for b in batches for r in b]==list(range(2,102))
    assert len(batches)<4
    assert all(len(json.dumps(screen_payload(b,'batch'),ensure_ascii=False).encode())<15500 for b in batches)


def test_duplicate_comment_uses_own_evidence_ids():
    rows,_=enrich([row(1,'Vodafone не працює',source=1),row(2,'Vodafone не працює',source=2),
                  row(3,'У мене теж','1',source=1),row(4,'У мене теж','2',source=2)])
    label=dict(id=3,evidence=[{'id':3,'quote':'У мене теж'},{'id':1,'quote':'Vodafone'}],
               aspects=[{'evidence':[{'id':3,'quote':'У мене теж'},{'id':1,'quote':'Vodafone'}]}])
    values=[]
    class Cursor:
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def executemany(self,sql,batch):values.extend(batch)
    class Connection:
        def cursor(self):return Cursor()
    save_labels(Connection(),'test-run',[rows[3]],rows[2],label,'detailed')
    result=values[0][3].obj
    assert result['id']==4
    assert [e['id'] for e in result['evidence']]==[4,2]
    assert [e['id'] for e in result['aspects'][0]['evidence']]==[4,2]
    assert result['context_versions']==[{'id':2,'version':1}]
    assert label['evidence'][0]['id']==3
