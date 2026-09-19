# Processor

Реалізація: [`../pipeline/processor.py`](../pipeline/processor.py), запуск із кореня `PYTHONPATH=services python -m pipeline.processor`.

Читає NATS JetStream `raw.item.created`, завантажує актуальний матеріал із `raw.items`. Окремо добирає з БД матеріали без актуального `core.processing_receipts` за версією тексту/ревізією workflow. Подвійна доставка безпечна: PostgreSQL advisory lock на item, один `core.mentions` на `raw_item_id`, upsert у транзакції.

Поточний аналіз — пояснювані правила `classification.py`: тематичність, спам/реклама, контекст коротких коментарів. Результати accepted/review/rejected, цитата з raw, посилання на батька та точний збіг довгих постів. Пізні батьки й зміни контексту запускають повторну обробку.

Processor не змінює `raw.items.processed_at`; квитанції належать `core`. Події `core.mention.created` поки немає: сайт читає БД. LLM, тональність, серйозність, інциденти та AI-бриф не реалізовані. Не заповнювати їх фіктивними оцінками.

Деталі: [архітектура](../../docs/ARCHITECTURE.md), [запуск](../../docs/DEV.md).
