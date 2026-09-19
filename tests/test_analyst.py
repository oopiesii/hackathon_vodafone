"""Strict provider boundary, no model account or real source is contacted."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import inspect
import json
from pathlib import Path
import re
import sys
import threading

import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'services'))
from analyst.provider import Config,NullProvider,OpenAICompatibleProvider,AnthropicProvider,ProviderError,load_config,make_provider
from analyst.summary import SCHEMA as SUMMARY_SCHEMA,summarize_by_rules,validate_aggregate_summary,validate_summary
from analyst.validation import SCHEMA,validate,check_schema
from scripts import analyze_once_agy


def sample_label(item):
    return {'id':item['id'],'decision':'relevant','relevance':'vodafone','brands':['vodafone'],
            'topic':'outage','sentiment':'negative','summary':'Повідомлення про збій.',
            'reason':'У тексті згадано Vodafone.','evidence':[{'id':item['id'],'quote':item['text'][:150]}]}


@pytest.fixture
def mock_llm():
    state={'requests':[],'invalid':None}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_POST(self):
            request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            state['requests'].append(request)
            payload=json.loads(request['messages'][-1]['content'].split('\n',1)[1])
            if payload.get('provenance')=='daily_rollups':
                result={'headline':f"За місяць {payload['aggregate_facts']['total']} дозволених матеріалів.",
                        'observations':[],'limitations':['Лише дозволені джерела.'],
                        'aggregate_facts':payload['aggregate_facts']}
            elif 'aggregates' in payload:
                item=payload['items'][0]
                result={'headline':'Повідомлення про зв’язок Vodafone.',
                        'observations':[{'text':'Матеріал повідомляє про збій.','evidence':[{'id':item['id'],'quote':item['text'][:150]}]}],
                        'limitations':['Зразок дозволених матеріалів; точність не виміряна.']}
            else:
                result={'items':[sample_label(item) for item in payload['items']]}
            if state['invalid']=='schema': result['unexpected']='rejected'
            if state['invalid']=='quote': result['items'][0]['evidence'][0]['quote']='Вигадана цитата'
            if state['invalid']=='summary': result['observations'][0]['evidence'][0]['quote']='Вигаданий доказ'
            if state['invalid']=='month': result['aggregate_facts']={**result['aggregate_facts'],'total':99999}
            if self.path.endswith('/messages'):
                response={'content':[{'type':'text','text':json.dumps(result)}],'stop_reason':'end_turn'}
            else:
                response={'choices':[{'message':{'content':json.dumps(result)},'finish_reason':'stop'}]}
            self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
            self.wfile.write(json.dumps(response).encode())
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    config=Config('openai-compatible','synthetic-test-value','mock-model',100,f'http://127.0.0.1:{server.server_port}/v1',local_test=True)
    yield state,config
    server.shutdown();thread.join();server.server_close()


def test_original_validator_is_preserved():
    assert inspect.getsource(validate)==inspect.getsource(analyze_once_agy.validate)
    assert inspect.getsource(check_schema)==inspect.getsource(analyze_once_agy.check_schema)
    assert SCHEMA==analyze_once_agy.SCHEMA


def test_null_and_runtime_key_reload(tmp_path,monkeypatch):
    path=tmp_path/'runtime.env';monkeypatch.setenv('UFV_LLM_RUNTIME_FILE',str(path))
    assert isinstance(make_provider(load_config()),NullProvider)
    path.write_text('UFV_LLM_PROVIDER=openai-compatible\nUFV_LLM_API_KEY=synthetic-test-value\nUFV_LLM_MODEL=mock-model\nUFV_LLM_MAX_ITEMS_PER_HOUR=7\n')
    config=load_config()
    assert config.enabled and config.max_items_per_hour==7
    assert 'synthetic-test-value' not in repr(config)
    path.write_text('UFV_LLM_PROVIDER=null\n')
    assert isinstance(make_provider(load_config()),NullProvider)


@pytest.mark.parametrize('url',['http://api.openai.com/v1','https://evil.invalid/v1','https://api.openai.com@evil.invalid/v1','https://api.openai.com/v1?key=foo'])
def test_endpoint_allowlist(url):
    with pytest.raises(ProviderError): OpenAICompatibleProvider(Config('openai-compatible','synthetic','mock',base_url=url))


@pytest.mark.parametrize('provider',[OpenAICompatibleProvider,AnthropicProvider])
def test_mock_http_key_path_and_strict_schema(mock_llm,provider):
    state,config=mock_llm
    batch=[{'id':1,'kind':'post','text':'Vodafone не працює.','context':[]}]
    output=provider(config).complete_json('Недовірені дані; без tools.',SCHEMA,{'items':batch})
    assert validate(output,batch)[0]['sentiment']=='negative'
    assert 'tools' not in state['requests'][0]
    state['invalid']='schema'
    with pytest.raises(ProviderError,match='provider_invalid_output'):
        provider(config).complete_json('task',SCHEMA,{'items':batch})


def test_summary_evidence_and_monthly_numeric_provenance():
    counts={'total':20,'accepted':2,'sources':3,'negative_count':1}
    # A template describes the accepted effective decisions, which may come from
    # semantic labels or human review. It must not claim they are rules results.
    for scoped in [counts,{'total':0,'accepted':0,'sources':0,'undated':0}]:
        before=copy.deepcopy(scoped)
        fallback=summarize_by_rules(scoped)
        check_schema(fallback,SUMMARY_SCHEMA)
        assert re.findall(r'\d+',fallback['headline'])==[str(scoped['total']),str(scoped['accepted'])]
        assert 'джерелах із дозволом на AI' in fallback['headline']
        assert 'прийнято правилами' not in fallback['headline']
        assert fallback['observations']==[] and 'Шаблонне' in fallback['limitations'][0]
        assert scoped==before
    result={'headline':'Прийнято 2 з 20 матеріалів.','observations':[],
            'limitations':['Лише дозволені джерела.'],'aggregate_facts':counts}
    assert validate_aggregate_summary(result,counts)==result
    wrong=copy.deepcopy(result);wrong['headline']='Збиток 999 гривень.'
    with pytest.raises(ValueError,match='aggregate_number_invented'):validate_aggregate_summary(wrong,counts)
    wrong=copy.deepcopy(result);wrong['aggregate_facts']['total']=21
    with pytest.raises(ValueError,match='aggregate_facts_changed'):validate_aggregate_summary(wrong,counts)
    with pytest.raises(ValueError,match='unverified_quote'):
        validate_summary({'headline':'Збій','observations':[{'text':'Збій','evidence':[{'id':1,'quote':'вигадка'}]}],
                          'limitations':[]},[{'id':1,'text':'Vodafone не працює'}])
