"""Explainable first-version rules. No LLM calls or author profiling."""
import hashlib
import re
import unicodedata
from dataclasses import dataclass

VERSION = 'rules-v2'
NORMALIZATION_VERSION = 'normalize-v2'
MAX_TEXT_LENGTH = 65536
TOPICS = {
    'mobile': ('vodafon', 'водафон', 'київстар', 'киевстар', 'kyivstar', 'lifecell', 'лайфсел',
               'мобільн', 'мобильн', 'телефоні', 'телефони', 'телеком', 'telecom', 'роумін', 'роумин',
               'стільников', 'сотов', 'sim-карт', 'esim', 'базова станц', 'базової станц', '5g', '4g', 'lte'),
    'internet': ('інтернет', 'интернет', 'internet', 'wi-fi', 'wifi', 'оптоволок', 'провайдер',
                 'гігабіт', 'гигабит', 'ftth', 'gpon'),
    'billing': ('тариф', 'списан', 'списал', 'поповнен', 'пополнен', 'абонплат', 'рахунк', 'баланс'),
    'support': ('підтримк', 'поддержк', 'контакт-центр', 'кол-центр', 'call center'),
    'network': ('покритт', 'покрыти', 'мереж', 'связ', "зв'яз", 'зв’яз', 'звяз', 'сигнал', 'network'),
}
TELECOM = re.compile('|'.join(re.escape(x) for v in TOPICS.values() for x in v), re.I)
SPAM = re.compile(r'казино|casino|\b1xbet\b|ставки на спорт|крипто.{0,20}(зароб|зараб)|'
                  r'(зароб|зараб).{0,30}(день|долар|доллар)|інтим|интим|накрут[кч]|'
                  r'пиши.{0,12}(лс|личк|приват)|гарантован.{0,15}дохід', re.I)
AD = re.compile(r'#реклама|#ad\b|на правах реклам|промокод|купуй|купите|замовляй|заказывай|'
                r'платне розміщення|платное размещение|рекламна інтеграція', re.I)
CONTEXT_REPLY = re.compile(r'^(у (мене|нас|меня)|теж|також|тоже|аналогічно|аналогично|'
                           r'підтверджую|подтверждаю|не працює|не работает|досі|до сих пор|'
                           r'вже працює|уже работает|відновил|восстановил|знову|опять|'
                           r'працює|работает|така сама|та же|same here|still down)', re.I)


def normalize(text: str) -> str:
    text = unicodedata.normalize('NFKC', text or '')
    text = re.sub(r'[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]', '', text)
    # Telegram text is not HTML; preserve comparisons and quoted angle brackets.
    text = re.sub(r'(?i)(?<!\w)@(?:vodafone_ua|vodafoneukraine)\b', 'Vodafone', text)
    text = re.sub(r'\b[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}\b', '[email вилучено]', text)
    text = re.sub(r'(?<!\w)\+?\d[\d ()-]{8,}\d(?!\w)', '[номер вилучено]', text)
    text = re.sub(r'(?<!\w)@[A-Za-z0-9_]{3,}', '[згадку акаунта вилучено]', text)
    text = re.sub(r'https?://\S+', '[посилання в тексті вилучено]', text)
    return re.sub(r'\s+', ' ', text).strip()[:MAX_TEXT_LENGTH]


def content_hash(text: str) -> str:
    return hashlib.sha256(text.casefold().encode()).hexdigest()


@dataclass
class Verdict:
    decision: str
    reason: str
    topic: str = 'other'
    brand: str = 'telecom'


def classify(text: str, parent: str = '', filter_spam: bool = True) -> Verdict:
    lower = text.casefold()
    parent_lower = parent.casefold()
    brand = next((name for name, variants in (
        ('vodafone', ('vodafon', 'водафон')), ('kyivstar', ('kyivstar', 'київстар', 'киевстар')),
        ('lifecell', ('lifecell', 'лайфсел'))) if any(v in lower for v in variants)), 'telecom')
    topic = next((key for key in ('billing', 'support', 'internet', 'network', 'mobile')
                  if any(v in lower for v in TOPICS[key])), 'other')
    if not text:
        return Verdict('rejected', 'Немає тексту: медіа без підпису не аналізуємо.')
    if SPAM.search(text):
        reporting = re.search(r'блокув|заблок|заборон|запрет|шахрай|мошенн|розслід|расслед|скарг|жалоб|кібер|кибер', text, re.I)
        if reporting and TELECOM.search(text):
            return Verdict('review', 'Можливе повідомлення про шахрайство або блокування; потрібна перевірка.', topic, brand)
        return Verdict('rejected' if filter_spam else 'review', 'Ознаки спаму за правилами.', topic, brand)
    if AD.search(text):
        return Verdict('review', 'Можлива реклама: потрібна перевірка людиною.', topic, brand)
    if TELECOM.search(text):
        if topic in ('billing', 'support') and brand == 'telecom' and not any(v in lower for k in ('mobile','internet','network') for v in TOPICS[k]) and not TELECOM.search(parent):
            return Verdict('review', 'Тариф або підтримка без явного зв’язку з телекомом.', topic, brand)
        return Verdict('accepted', 'Є тематичні слова; класифікація правилами, не оцінка кризи.', topic, brand)
    if parent and TELECOM.search(parent) and CONTEXT_REPLY.search(text) and len(text) < 500:
        pv = classify(parent, filter_spam=filter_spam)
        if pv.decision == 'accepted':
            return Verdict('accepted', 'Коротка відповідь стосується тематичного батьківського повідомлення.', pv.topic, pv.brand)
    if parent and TELECOM.search(parent):
        return Verdict('review', 'Тематичний контекст є, зв’язок самого коментаря неясний.')
    return Verdict('rejected', 'Не знайдено зв’язку з телеком-тематикою.')
