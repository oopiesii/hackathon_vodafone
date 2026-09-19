"""No model calls or production data: validate untrusted model output boundaries."""
import copy
import pytest
from scripts.analyze_once_agy import validate


@pytest.fixture
def sample():
    batch=[{'id':1,'kind':'comment','text':'У мене теж не працює.',
            'context':[{'id':2,'text':'Vodafone не працює у Львові.','version':1}]}]
    label={'id':1,'decision':'relevant','relevance':'vodafone','brands':['vodafone'],
           'topic':'outage','sentiment':'negative','summary':'Скарга на зв’язок.',
           'reason':'Коментар підтверджує проблему з батьківського повідомлення.',
           'evidence':[{'id':1,'quote':'У мене теж не працює.'},{'id':2,'quote':'Vodafone не працює'}]}
    return batch,{'items':[label]}


def test_context_quotes_are_verified(sample):
    batch,output=sample
    assert validate(output,batch)[0]['relevance']=='vodafone'


@pytest.mark.parametrize('mutation',[
    lambda x:x['items'][0]['evidence'][0].update(quote='Вигадана цитата'),
    lambda x:x['items'][0]['evidence'][0].update(id=999),
    lambda x:x['items'].append(copy.deepcopy(x['items'][0])),
    lambda x:x.update(items=[]),
    lambda x:x['items'][0].update(brands=[]),
    lambda x:x['items'][0].update(id=True),
    lambda x:x['items'][0].update(sentiment='certain'),
    lambda x:x['items'][0].update(evidence=[{'id':2,'quote':'Vodafone'}]),
    lambda x:x['items'][0].update(url='https://invented.invalid/'),
])
def test_rejects_invalid_model_output(sample,mutation):
    batch,output=sample
    mutation(output)
    with pytest.raises(ValueError):
        validate(output,batch)
