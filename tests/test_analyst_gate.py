"""Вартовий зведень: без БД і мережі; провайдер замінено контрольованим об'єктом."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
from analyst import gate


class Provider:
    def __init__(self, answer):
        self.answer, self.calls = answer, []

    def complete_json(self, prompt, schema, payload):
        self.calls.append(payload)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


COUNTS = {'total': 191, 'accepted': 4, 'sources': 8, 'undated': 0}
VERSIONS = [{'id': 1, 'version': 1, 'rule_decision': 'accepted'}, {'id': 2, 'version': 3, 'rule_decision': 'accepted'}]
PREVIOUS = {'body': {'headline': 'Спокійно', 'observations': [{'text': 'Тарифи'}], 'provenance': {'counts': COUNTS}}, 'input_versions': VERSIONS}
ITEMS = [{'id': 1, 'kind': 'post', 'text': 'старе'}, {'id': 2, 'kind': 'post', 'text': 'старе'}, {'id': 3, 'kind': 'post', 'text': 'нове: збій у Харкові'}]


def test_first_summary_is_always_written():
    assert gate.needs_new_summary(Provider({'regenerate': 'no', 'reason': ''}), None, COUNTS, VERSIONS, ITEMS)


def test_identical_inputs_skip_without_calling_the_model():
    provider = Provider({'regenerate': 'yes', 'reason': 'не має викликатися'})
    assert not gate.needs_new_summary(provider, PREVIOUS, dict(COUNTS), list(reversed(VERSIONS)), ITEMS)
    assert provider.calls == []


def test_model_decides_and_sees_only_new_items():
    changed = {**COUNTS, 'total': 192, 'accepted': 5}
    keep, renew = Provider({'regenerate': 'no', 'reason': 'те саме'}), Provider({'regenerate': 'yes', 'reason': 'нова тема'})
    assert not gate.needs_new_summary(keep, PREVIOUS, changed, VERSIONS + [{'id': 3, 'version': 1, 'rule_decision': 'accepted'}], ITEMS)
    assert gate.needs_new_summary(renew, PREVIOUS, changed, VERSIONS, ITEMS)
    assert [i['id'] for i in keep.calls[0]['current']['new_items']] == [3]
    assert keep.calls[0]['previous']['headline'] == 'Спокійно'


def test_edited_item_counts_as_change():
    edited = [{'id': 1, 'version': 2, 'rule_decision': 'accepted'}, VERSIONS[1]]
    assert not gate.same_inputs(PREVIOUS, COUNTS, edited)


def test_no_key_or_any_failure_falls_back_to_regenerating():
    changed = {**COUNTS, 'total': 200}
    assert gate.needs_new_summary(None, PREVIOUS, changed, VERSIONS, ITEMS)
    assert gate.needs_new_summary(Provider(None), PREVIOUS, changed, VERSIONS, ITEMS)
    assert gate.needs_new_summary(Provider(RuntimeError('provider_timeout')), PREVIOUS, changed, VERSIONS, ITEMS)
    assert gate.needs_new_summary(Provider({'regenerate': 'так', 'reason': ''}), PREVIOUS, changed, VERSIONS, ITEMS)


def test_gate_is_off_by_default(monkeypatch):
    monkeypatch.delenv('UFV_SUMMARY_GATE', raising=False)
    assert not gate.enabled()
    monkeypatch.setenv('UFV_SUMMARY_GATE', '1')
    assert gate.enabled()
