# Постійний AI-шар: S1 і S2

Підстава — [PLAN_NIGHT.md](PLAN_NIGHT.md), WP8a, і прямий нічний запуск користувача. Це окремий Python-сервіс `analyst`; разові AGY-прогони та незалежний processor `rules-v2` не змінено. Відсутність ключа є робочим станом, не помилкою.

## Контракти

- `services/analyst/provider.py`: `NullProvider`, `AnthropicProvider`, `OpenAICompatibleProvider`. Останній використовує `/chat/completions` із JSON Schema; Anthropic — `/messages` та локальну перевірку схеми. Жодних tools, subprocess або завантаження URL із тексту. API провайдерів перевірено локальним HTTP mock; реальних платних запитів у цьому інкременті не було.
- `S1-label`: окремий durable NATS consumer `analyst-v1`, тема `raw.item.created`; доганяння з БД кожні 5 секунд. У модель потрапляє тільки нормалізований текст і прямий reply context. Щоденний UTC run у `core.analysis_runs`, мітки — у `core.analysis_labels`, версія `ufv-relevance-v1`. Схема й exact-quote validator дослівно перенесені з `scripts/analyze_once_agy.py`; окремий тест підтверджує їхню тотожність. Нові мітки не переписують rules-рішення чи ручні рішення.
- `S2-summary`: вікна `24h`, `7d`, `30d`, перевірка розкладу кожні 5 секунд, запуск раз на 15 хвилин або після нового `refresh_requests.requested_at`. День/тиждень — агрегати дозволеного входу та до 20 прийнятих правилами доказів. Місяць — **лише `daily_rollups`**, 30 календарних днів Europe/Kyiv; модель повертає незмінні `aggregate_facts`, жодних item-цитат. Перевіряються точні агрегати та відсутність нових чисел у тексті. `body.provenance` формує код, а не модель. За відсутності даних/ключа/ліміту або відмови валідатора працює зведення правил.
- `core.ai_summaries`: workflow, window, window_start/end, model, mode `ai|rules`, body, evidence_ids, input_versions, source_ids, generated_at. Для читання використовувати **`core.current_ai_summaries`**: view відсіює змінені/видалені докази, вимкнені джерела й відкликані дозволи. Зведення є знімком на `generated_at`, не поточним фактом про мережу.
- `GET /api/admin/ai/status`: heartbeat, mode `waiting_key|active|rate_limited|error`, model, безпечний last_error, limit_per_hour, items_last_hour, last_label_at/last_summary_at, sources із llm_allowed/llm_basis/rights_status. Лише admin. Ключі, endpoint та credentials не повертаються.
- `PUT /api/admin/ai/sources/:id`: `{llm_allowed:boolean,llm_basis:string}`. Увімкнення вимагає підставу 10–1000 символів; RSS також `rights_status=allowed`. Зміна й підстава атомарно потрапляють у audit. Viewer/analyst отримують 403. UI не є межею прав.

## Брама дозволів і безпека

Міграція `0012_analyst.sql` адитивна. Типово `sources.llm_allowed=false`; тільки вже дозволені RSS увімкнено на підставі нічного доручення. **Telegram автоматично не вмикається.** Нові джерела також типово false. Для RSS сама зміна прапорця не обходить `blocked` чи `pending`.

`ufv_analyst` читає `core.analyst_items` і `core.analyst_rollups` із перевіркою прав без доступу до `raw.items`, авторизації чи `telegram_accounts`. Запис дозволений лише в результати/стан analyst. Зі старих `analysis_labels` роль може читати тільки run/item/version, не тексти. Права однаково задають `deploy/analyst_grants.py` і міграція. Модель не бачить URL, профілів авторів, акаунтів або Telegram-секретів; текст додатково проходить чинне маскування контактів.

Кожний payload явно названий недовіреними даними. Промпт забороняє виконувати вбудовані інструкції. Вихід — суворий JSON із перевіркою exact quotes і ID; посилання слід брати зі сховища. Валідатор не доводить семантичну правильність висновку; точність і впевненість не калібровані.

Endpoint — HTTPS і явний allowlist host: стандартно `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`; додатковий хост вимагає захищеної runtime-конфігурації. Redirects і ambient proxy вимкнено, timeout 45 с, відповідь до 1 MiB, output до 5000 tokens. Локальний HTTP дозволений лише через явний test-only параметр Python `Config`, якого немає серед runtime-змінних.

Ліміт `UFV_LLM_MAX_ITEMS_PER_HOUR` атомарний у PostgreSQL й переживає restart. S1 коштує одну одиницю; S2 день/тиждень — число переданих матеріалів, агрегатне місячне зведення — одну одиницю запиту. Помилкові запити теж витрачають ліміт. Це ліміт обсягу, **не гарантована межа витрат у валюті**. Повтор S1: до 3 спроб, не частіше 15 хвилин; S2 зберігає розклад спроб, щоб не повторювати відмову кожні 5 секунд.

S1 обрізає нормалізований item до 40 KB і прямий контекст до 16 KB, зберігає `label.input_truncated`; цитати перевіряються в реально переданому фрагменті. S2 — до 20 фрагментів по 2,4 KB; provenance містить обсяг зразка. Відсутній/пізній батьківський контекст, нова версія item/батька потребують повторної розмітки. Настрої коментарів не є настроями всіх абонентів.

## Runtime та розгортання

`deploy/bootstrap.py` генерує окремий `DB_ANALYST_PASSWORD` у захищеному production.env, якщо він відсутній, створює login-роль і grants. Спершу bootstrap, потім Compose: `DB_ANALYST_PASSWORD` обов'язковий. Сервіс запускається non-root, readonly root filesystem, без capabilities, тільки backend/egress, 256 MiB; Telegram credentials й усі production.env у контейнер не монтуються.

Канонічні параметри в `/etc/ufv/production.env`:

```dotenv
UFV_LLM_PROVIDER=null
UFV_LLM_MODEL=
UFV_LLM_API_KEY=
UFV_LLM_MAX_ITEMS_PER_HOUR=60
UFV_LLM_BASE_URL=
UFV_LLM_ALLOWED_HOSTS=
```

Після встановлення провайдера (`anthropic` або `openai-compatible`), моделі та ключа достатньо перестворити **лише analyst**, образ збирати не треба:

```sh
docker compose --env-file /etc/ufv/production.env -f deploy/compose.yml up -d --no-deps --force-recreate analyst
```

Для зміни без restart є захищений `/etc/ufv/analyst/runtime.env` (root:10001, 0640; каталог 0750), змонтований readonly. Він містить тільки явні `UFV_LLM_*` перевизначення, перечитується в кожному циклі й перед NATS-item. Початково порожній. Записуйте файл атомарно зі збереженням власника/прав; монтується каталог, тому rename видно контейнеру. Для негайного вимкнення запитів — `UFV_LLM_PROVIDER=null`; уже відправлений запит відкликати неможливо. Не записувати ключ у CLI-аргументи, shell history, Git або журнали.

Healthcheck перевіряє свіжий heartbeat (до 5 хвилин), незалежно від наявності ключа. Окремий heartbeat продовжується під час очікування HTTP. При недоступності NATS працює DB catch-up. Сервіс не перезапускає collectors і не змінює Caddy.

## Перевірка інкременту

У `ufv_checks`: ролі, gate, аудит, synthetic RSS, HTTP mocks OpenAI-compatible/Anthropic, S1 upsert+dedup+parent version, відхилення невалідного JSON/цитат, S2 day/month, місяць при **відкликаному SELECT на analyst_items**, відкликання джерела приховує summary, NATS→mock→label, живий subprocess без ключа→heartbeat+rules summaries. Тестові credentials мають redacted repr. Без реальних LLM-запитів, без Telegram-авторизації, без production fixtures.

Команди: `npm run typecheck`, `npm run build`; `UFV_TEST_ENV=/protected/ufv-checks.json python -m pytest tests/test_analyst.py tests/test_analyst_runtime.py tests/test_analysis_once.py -q`; `docker build -f deploy/Dockerfile.analyst -t ufv-analyst:night-check .`. Runtime-тести серіалізувати з іншими suites: спільна `ufv_checks` використовується їхніми reset fixtures.

Security review за [security-audit SKILL.md](../.codex/skills/security-audit/SKILL.md): **Pass after fixes**, залишковий ризик **Medium** через невиміряну модельну семантику й точність маскування контактів. Перевірено ізоляцію БД, prompt/output boundaries, cap/retries, safe errors, секрети, endpoint allowlist та server-side permission. Під час тестів виправлено upsert, який потребував зайвого SELECT на label; права не розширено. Secret scanner для `services/analyst` — без common secret patterns. Реальний контракт обраної комерційної моделі та її квоти потребують окремої перевірки після дозволеного додавання ключа.

S3/S4/S6/S7 і автоматичні інциденти не реалізовані цим пакетом. Підключення результатів до dashboard/UI та production smoke — інтеграційний етап головного агента.
