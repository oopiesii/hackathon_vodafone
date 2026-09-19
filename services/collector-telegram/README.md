# Collector Telegram

Реалізація: [`../pipeline/telegram.py`](../pipeline/telegram.py), запуск із кореня `PYTHONPATH=services python -m pipeline.telegram`. Залежності в `requirements.txt`.

Collector сам читає конфігурацію `core.modules/workflows/telegram_accounts/sources`. Пише `raw.*`: мінімальні нормалізовані матеріали, membership публічних каналів/груп, курсори постів/обговорень, snapshots метрик, watch state, стан сесій і transactional outbox. Оновлює стан `core.telegram_jobs`, створених API. Вступ виконується тільки через явні admin join jobs, не за ключовими словами. Відстежує пости, групові повідомлення, вкладені коментарі, доступні редагування/видалення; зберігає FloodWait. Деталі й межі — [Telegram complete](../../docs/TELEGRAM_COMPLETE.md).

Контракт: `(source_id, source_item_id=peer:message)` унікальний; `parent_item_id` — прямий батько, `thread_item_id` — пост каналу. `fetched_at` — перше отримання, повторне спостереження — `last_seen_at`. Подія `raw.item.created` містить ID, не текст. Курсор пересувається після збереження.

Секрети сесій у PostgreSQL зашифровані AES-256-GCM, не Fernet. API й collector використовують однаковий `TG_SESSION_KEY`. Авторські профілі не зберігаються; функція нормалізації маскує контактні дані до запису.

Деталі: [архітектура](../../docs/ARCHITECTURE.md), [підключення та межі](../../docs/TELEGRAM.md).
