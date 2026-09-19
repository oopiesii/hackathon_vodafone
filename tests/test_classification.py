from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))
from pipeline.classification import classify, normalize


def test_context_spam_and_ambiguous_language():
    assert classify("У мене теж не працює", "Vodafone: збій мобільної мережі").decision == "accepted"
    assert classify("Казино з бонусом Vodafone", "Vodafone").decision == "rejected"
    assert classify("Промокод на інтернет").decision == "review"
    assert classify("Сьогодні футбол", "Vodafone: збій").decision == "review"
    assert classify("Сьогодні футбол").decision == "rejected"
    assert classify("Vodafone відновив послуги").decision == "accepted"
    assert classify("Домашній борщ").decision == "rejected"
    assert classify("Тарифи на автобус змінилися").decision == "review"


def test_contact_redaction_before_storage():
    clean = normalize("Зателефонуйте +380 67 123 45 67, user@example.com @some_person https://example.org/a")
    assert "123" not in clean and "example.com" not in clean and "@some" not in clean
    assert "https://" not in clean
