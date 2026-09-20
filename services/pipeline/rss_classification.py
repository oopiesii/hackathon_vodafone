"""News need telecom anchors: generic 'network', 'support', 'tariff' are insufficient."""
import re
from .classification import classify, Verdict
ANCHOR = re.compile(r'vodafon|водафон|київстар|киевстар|kyivstar|lifecell|лайфсел|укртелеком|інтертелеком|'
    r'телеком|telecom|роумін|роумин|стільников|сотов|esim|sim-карт|базов.{0,12}станц|'
    r'мобільн.{0,25}(зв.яз|інтернет|оператор|мереж)|мобильн.{0,25}(связ|интернет|оператор)|'
    r'(інтернет|интернет).{0,25}(провайдер|доступ|збій|відключ|покрит|тариф)|'
    r'(провайдер|доступ|збій|відключ|покрит|тариф).{0,25}(інтернет|интернет)|'
    r'оптоволок|оптичн.{0,12}мереж|gpon|ftth|starlink|старлінк|\b[45]g\b|\blte\b',re.I)


def classify_rss(text, filter_spam=True):
    verdict = classify(text, filter_spam=filter_spam)
    if not ANCHOR.search(text):
        return Verdict('rejected','В RSS-анонсі немає явного зв’язку з телекомом; повний текст не отримано.')
    if verdict.decision == 'accepted':
        verdict.reason = 'Телеком-тематика в заголовку/анонсі RSS. Повний текст не аналізувався; це не оцінка кризи.'
    elif verdict.decision == 'rejected' and verdict.topic == 'other' and 'Не знайдено' in verdict.reason:
        return Verdict('accepted','Є явна згадка телеком-інфраструктури в RSS-анонсі.', 'network')
    return verdict
