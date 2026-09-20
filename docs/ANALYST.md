# Постійний AI-шар: S1 і S2

**Оновлено й перевірено 20.09.2026 о 06:15 UTC:** analyst image `night-20260920T061300Z` працює в режимі **`active`** через локальний runtime bridge, модель `claude-opus-5`; `last_error=null`. Усі 68 увімкнених Telegram і 12 RSS із підтвердженим `rights_status=allowed` дозволені для AI. П'ять RSS, заблокованих умовами видавців, лишаються вимкненими й не передаються моделі. Підстава — пряме доручення користувача передати весь наявний Telegram-текст без профілів авторів і завершити постійний конвеєр.

Catch-up тепер передає до 20 матеріалів одним запитом, але зберігає окрему перевірену мітку й receipt для кожної версії. Вибір іде від найновіших матеріалів, тому живий шлях не чекає завершення історичної черги. Погодинна захисна межа runtime встановлена в `10000` item; це обмеження обсягу, не оцінка грошової вартості. Міграції `0032`–`0033` замінили повільну інвалідацію прав на statement-level обробку; масове дозволення 72 джерел у production завершилося за 2,35 с.

У production також збережено окремий історичний шлях: завершений разовий Gemini/AGY-прогін Telegram і curated-класифікацію з міграцій 0020–0022. Його результати використовуються в dashboard/feed; це не постійний `analyst` і не новий S2. Див. [ANALYSIS_ONCE.md](ANALYSIS_ONCE.md) та [CURATED_DASHBOARD.md](CURATED_DASHBOARD.md).

Цей документ описує розгорнутий окремий Python-сервіс `analyst`, його права, збереження й інтеграцію. Разові скрипти та незалежний processor `rules-v2` збережено. Якщо runtime вимкнути або ключ стане недоступним, семантична брама workflow лишається закритою для нових pending-матеріалів і не підміняється словниковим fallback.

## Контракти

- `services/analyst/provider.py`: `NullProvider`, `AnthropicProvider`, `OpenAICompatibleProvider`. Останній використовує `/chat/completions` із JSON Schema; Anthropic — `/messages` та локальну перевірку схеми. Жодних tools, subprocess або завантаження URL із тексту. API провайдерів перевірено локальним HTTP mock; реальних платних запитів у цьому інкременті не було.
- `S1-label`: окремий durable NATS consumer `analyst-v1`, тема `raw.item.created`; доганяння з БД кожні 5 секунд. У модель потрапляє тільки нормалізований текст і прямий reply context. Щоденний UTC run у `core.analysis_runs`, мітки — у `core.analysis_labels`, версія `ufv-relevance-v1`. Схема й exact-quote validator дослівно перенесені з `scripts/analyze_once_agy.py`; окремий тест підтверджує їхню тотожність. Нові мітки фізично не переписують rules-рішення чи ручні рішення. Після інтеграції 0030 актуальна S1-мітка бере участь в ефективному curated-відборі; це не лише додаткова анотація.
- `S2-summary`: вікна `24h`, `7d`, `30d`, перевірка розкладу кожні 5 секунд, запуск раз на 15 хвилин або після нового `refresh_requests.requested_at`. День/тиждень — агрегати дозволеного входу та до 20 доказів із effective `accepted`. Після 0030 історична назва `analyst_items.rule_decision` означає ефективне curated-рішення, а не лише словникову оцінку. Місяць — **лише фізичні `daily_rollups` через дозволений `analyst_rollups`**, 30 календарних днів Europe/Kyiv; модель повертає незмінні `aggregate_facts`, жодних item-цитат. Перевіряються точні агрегати та відсутність нових чисел у тексті. `body.provenance` формує код, а не модель. За відсутності даних/ключа/ліміту або відмови валідатора працює позначене шаблонне зведення з доступних агрегатів. Неповне покоління не показується як нуль чи готове зведення.
- `core.ai_summaries`: workflow, window, window_start/end, model, mode `ai|rules`, body, evidence_ids, input_versions, source_ids, generated_at. Для читання використовувати **`core.current_ai_summaries`**: view відсіює змінені/видалені докази, вимкнені джерела й відкликані дозволи. Зведення є знімком на `generated_at`, не поточним фактом про мережу.
- `GET /api/admin/ai/status`: heartbeat, mode `waiting_key|active|rate_limited|error`, model, безпечний last_error, limit_per_hour, items_last_hour, last_label_at/last_summary_at, sources із llm_allowed/llm_basis/rights_status. Лише admin. Ключі, endpoint та credentials не повертаються.
- `PUT /api/admin/ai/sources/:id`: `{llm_allowed:boolean,llm_basis:string}`. Увімкнення вимагає підставу 10–1000 символів; RSS також `rights_status=allowed`. Зміна й підстава атомарно потрапляють у audit. Viewer/analyst отримують 403. UI не є межею прав.

## Ефективний відбір і розгорнуті 0030–0031

Розгорнуті 0020–0022 ввели global gate: наявність completed analysis run у workflow переводить весь його основний відбір у семантичний режим. Нові або застарілі записи стають `pending`, навіть якщо старі словникові правила приймали їх. Чинне ручне рішення має пріоритет для тієї самої версії, крім явного карантину `test_source_ids`. Без завершеного прогону workflow може використовувати позначені правила.

Розгорнута `0030_curated_atomic_rollups.sql` зберігає цю policy й додає постійний шлях: `scope.mode=continuous`, run `running|complete`, завершений `analyst_receipts` для raw version/model/prompt, чинні `llm_allowed`/basis, enabled workflow/source та RSS rights. One-shot мітки окремо перевіряються за workflow і scope source_ids/source_kind. `relevant` → `accepted`, `review` → `review`, інші результати → `rejected`; версії переданого контексту та поява раніше відсутнього parent перевіряються повторно. Саме ефективне рішення використовують curated feed, метрики та S2 provenance. Відсутність runtime-ключа не робить нові записи автоматично `accepted`.

Для місяця 0030 публікує фізичні атомарні покоління з effective decisions, окремими NEG/IRONIC, часом спостереження метрик та `rolling_7d_count`. Читання місячного dashboard/S2 не має звертатися до текстів чи labels. Числа, зокрема rolling 7d, стосуються часу покоління; цей час має бути видимим. Поки хоча б одне джерело потрібного scope dirty/без покоління, API приховує повний підсумок, а S2 відкладає виклик.

Це змінило попередній місячний live-view з 0020–0022: production тепер читає фізичні покоління. Coverage і агрегати API читає одним snapshot; S2 evidence lookup використовує curated-класифікацію. Invalidation охоплює labels/receipts/run, review/edit/delete, права, source move і залежний контекст.

Розгорнута `0031_legacy_rss_semantic_scope.sql` підтримує старий completed RSS-прогін зі scope `rss=allowed` без поля `source_ids`. Виняток вимагає RSS-джерело, чинний `rights_status=allowed`, відсутній або RSS `source_kind`; порожній scope, blocked, явно порожній/null `source_ids` і Telegram не проходять. Це сумісність історичних результатів, а не дозвіл на нові Telegram-виклики.

## Читання S2 в dashboard

S2 — окреме зведення за період, а не історичний one-shot brief на `/analysis`. У розгорнутому UI є підпис режиму, час, модель, спостереження з дослівними доказами та межі покриття. API перевіряє scope, актуальність, вікно й доступні читачеві evidence; URL походять зі сховища. Місячне зведення посилається на scope/період агрегатів і не вигадує item-цитат.

Поточний вхід S2 може містити лічильники rejected/pending/review дозволених джерел. Viewer не отримує такий змішаний body навіть після приховування окремих цитат: API повертає рольовий шаблонний fallback. Повний body доступний viewer лише коли весь модельний вхід був accepted та непорожній. Відсутність свіжого heartbeat означає непідтверджений стан сервісу; збережене зведення має власний час і не доводить, що сервіс зараз працює.

Наявний production curated UI уже показує «Vodafone: згадки за 7 днів» і NEG-only; ці функції не залежать від запуску нового S2. Частка негативних реакцій не включає IRONIC чи SAD і не дорівнює тональності всіх абонентів.

## Брама дозволів і безпека

Поточний стан після прямого доручення 20.09: `llm_allowed=true` для 68 увімкнених Telegram і 12 доступних RSS; п'ять RSS із непідтвердженими/заблокованими правами мають `enabled=false`, `llm_allowed=false`. Endpoint `POST /api/admin/ai/sources/allow-all` повторює саме цю межу, вимагає письмову підставу та пише аудит для кожного зміненого джерела.

Міграція `0012_analyst.sql` адитивна. Нові джерела типово мають `llm_allowed=false`; адміністратор або окреме пряме доручення мають явно змінити gate з підставою. Для RSS прапорець не обходить `rights_status`: `blocked` і `pending` не дозволяються масовою дією.

`0015_analyst_freshness.sql` доповнює покоління агрегатів із `0014_dashboard_coverage.sql`. Покриття, числа й докази S2 читаються в одному repeatable-read snapshot. Місячний виклик відкладається без витрат ліміту, якщо хоча б одне дозволене джерело dirty або ще не має покоління агрегатів. Після HTTP звіряється `invalidated_at`; зміна під час виклику відкидає весь результат. `body.provenance.source_states` фіксує timestamp покоління та інвалідації. Новий review/edit/delete приховує старе зведення негайно; наступний recompute не повертає старий модельний текст. Періодичний recompute без інвалідації не переписує історичний час зведення. Після невдалого snapshot сервіс перевіряє готовність знову через 5 секунд; модельні відмови лишаються на 15-хвилинному backoff.

`ufv_analyst` читає `core.analyst_items` і `core.analyst_rollups` із перевіркою прав без доступу до `raw.items`, авторизації чи `telegram_accounts`. Запис дозволений лише в результати/стан analyst. Зі старих `analysis_labels` роль може читати тільки run/item/version, не тексти. Права однаково задають `deploy/analyst_grants.py` і міграція. Модель не бачить URL, профілів авторів, акаунтів або Telegram-секретів; текст додатково проходить чинне маскування контактів.

Кожний payload явно названий недовіреними даними. Промпт забороняє виконувати вбудовані інструкції. Вихід — суворий JSON із перевіркою exact quotes і ID; посилання слід брати зі сховища. Валідатор не доводить семантичну правильність висновку; точність і впевненість не калібровані.

Зовнішній endpoint — HTTPS і явний allowlist host: стандартно `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`; додатковий хост вимагає захищеної runtime-конфігурації. `local-runtime` окремо дозволяє HTTP лише до явно названого loopback/приватного/Docker-gateway хоста; production використовує `host.docker.internal`. Redirects і ambient proxy вимкнено, timeout зовнішнього провайдера 45 с, локального bridge 180 с, відповідь до 1 MiB, output до 5000 tokens.

Ліміт `UFV_LLM_MAX_ITEMS_PER_HOUR` атомарний у PostgreSQL й переживає restart. S1 коштує одну одиницю; S2 день/тиждень — число переданих матеріалів, агрегатне місячне зведення — одну одиницю запиту. Помилкові запити теж витрачають ліміт. Це ліміт обсягу, **не гарантована межа витрат у валюті**. Повтор S1: до 3 спроб, не частіше 15 хвилин; S2 зберігає розклад спроб, щоб не повторювати відмову кожні 5 секунд.

S1 обрізає нормалізований item до 40 KB і прямий контекст до 16 KB, зберігає `label.input_truncated`; цитати перевіряються в реально переданому фрагменті. S2 — до 20 фрагментів по 2,4 KB; provenance містить обсяг зразка. Відсутній/пізній батьківський контекст, нова версія item/батька потребують повторної розмітки. Настрої коментарів не є настроями всіх абонентів.

## Runtime та розгортання

Сервіс розгорнуто через локальний runtime bridge. API має тег `night-20260920T060931Z`, analyst — `night-20260920T061300Z`, processor — `night-20260920T062943Z`. Telegram/RSS collectors залишились на `night-20260919T221752Z` і під час цього інкременту не перезапускалися. Bridge URL, token та provider зберігаються лише у захищеному `/etc/ufv/production.env`; runtime override містить тільки погодинну межу й не дублює секрет.

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

Для зміни без restart є захищений `/etc/ufv/analyst/runtime.env` (0640), змонтований readonly. Він містить тільки явні `UFV_LLM_*` перевизначення, перечитується в кожному циклі й перед NATS-item. Зараз там задано лише `UFV_LLM_MAX_ITEMS_PER_HOUR=10000`. Записуйте файл атомарно зі збереженням власника/прав; монтується каталог, тому rename видно контейнеру. Для негайного вимкнення запитів — `UFV_LLM_PROVIDER=null`; уже відправлений запит відкликати неможливо. Не записувати ключ у CLI-аргументи, shell history, Git або журнали.

Healthcheck перевіряє свіжий heartbeat (до 5 хвилин), незалежно від наявності ключа. Окремий heartbeat продовжується під час очікування HTTP. При недоступності NATS працює DB catch-up. Сервіс не перезапускає collectors і не змінює Caddy.

## Відкат цього релізу

Для відкату останнього analyst-пакета використовувати його окремий manifest; processor/collectors лишаються поточними:

```sh
deploy/night-release.sh --rollback /var/lib/ufv/releases/night-20260920T061300Z.json
```

Схема залишається адитивно оновленою. Старі manifests 21:53/22:15 повертають API без належної перевірки покриття й після 0030 не є безпечним відкатом. Bridge для неповного місяця повертає український HTTP 503, а не часткові успішні числа. Деталі — [ROLLBACK_BRIDGE_REVIEW.md](ROLLBACK_BRIDGE_REVIEW.md). Наведення команди не означає, що відкат виконано.

## Перевірка інкременту

Наведені перевірки підтверджують контракти коду й післярелізне приймання поточного пакета. Загалом пройдено 136 backend-тестів, після злиття — 6 цільових S2/query-тестів і curated acceptance. Повний production-огляд: 80/80 комбінацій і 156 розглянутих PNG. Два чисті кола фази 2 не виконано до паузи. Ці результати не є оцінкою якості реальної моделі.

У `ufv_checks`: ролі, gate, аудит, synthetic RSS, HTTP mocks OpenAI-compatible/Anthropic, S1 upsert+dedup+parent version, відхилення невалідного JSON/цитат, S2 day/month, місяць при **відкликаному SELECT на analyst_items**, відкликання джерела приховує summary, NATS→mock→label, живий subprocess без ключа→heartbeat+rules summaries. Окремо перевірено review → приховування day/month, dirty → жодного модельного виклику, recompute → старий текст не повернувся; інвалідація всередині HTTP → результат не записаний. **27 тестів пройдено.** Тестові credentials мають redacted repr. Без реальних LLM-запитів, без Telegram-авторизації, без production fixtures.

Перед повним релізом злитий backend на 0031 пройшов **133 тести**. Після релізу root підтвердив: analyst healthy/`waiting_key`, Telegram gate вимкнений; dashboard **24h — 0, 7d — 33, 30d — 34, Vodafone 7d — 2**, джерела/конкуренти/переходи/документи узгоджені. Після останніх виправлень місячний API-запит — **0,413 с**, день — **1,071 с**, тиждень — **4,760 с**. Це контрольні числа й окремі вимірювання, не стабільна затримка чи SLA. Модельні шляхи цього сервісу перевірялися mocks; реального runtime-виклику з платним ключем не заявлено.

Команди: `npm run typecheck`, `npm run build`; `UFV_TEST_ENV=/protected/ufv-checks.json python -m pytest tests/test_analyst.py tests/test_analyst_runtime.py tests/test_analysis_once.py -q`; `docker build -f deploy/Dockerfile.analyst -t ufv-analyst:night-check .`. Runtime-тести серіалізувати з іншими suites: спільна `ufv_checks` використовується їхніми reset fixtures.

Security review за локальним skill `security-audit`: **Pass after fixes**, залишковий ризик **Medium** через невиміряну модельну семантику й точність маскування контактів. Перевірено ізоляцію БД, prompt/output boundaries, cap/retries, safe errors, секрети, endpoint allowlist та server-side permission. Під час тестів виправлено upsert, який потребував зайвого SELECT на label; права не розширено. Secret scanner для `services/analyst` — без common secret patterns. Реальний контракт обраної комерційної моделі та її квоти потребують окремої перевірки після дозволеного додавання ключа.

Для інтеграції 0030–0031 виконано окремі SQL-регресії `tests/test_curated_rollups.py`: scoped one-shot/continuous, точні версії, права й контекст, інвалідація поколінь, S2 та відсутність текстових відношень у місячному read path. Їхній результат не слід додавати до числа 27 як повторну оцінку якості моделі.

У production 19.09 о 21:53 UTC розгорнуті security-виправлення: окремий клієнтський кеш для сеансу й підтверджених прав; незмінний share scope після redeem; binding shared `/me`/feed/documents до ідентифікатора посилання. Пізня широка cookie не має розширювати вузький зріз. Перевірено 7 auth-cache сценаріїв, 4 браузерні cookie-race сценарії та 2 API-регресії на `ufv_checks`; докладніше [AUTH_CACHE_REVIEW.md](AUTH_CACHE_REVIEW.md). Production-приймання того security-інкременту пройдено; analyst і 0030 у ньому ще не розгорталися. Повний реліз 22:19:12 UTC включає ці виправлення; для відкату тепер застосовується лише актуальний manifest із розділу відкату вище.

S3/S4/S6/S7, автоматичні інциденти й чат на живих даних не реалізовані цим пакетом. UI Network/Threads та калькулятор із WP3/WP4 — окремі демонстраційні можливості, а не модельна телеметрія чи виміряні збитки. Ці UI-можливості вже розгорнуті, зовнішні Network/Threads-інтеграції не підключено. Поточний пакет I6 завершено; передача й залишкові задачі записані в MORNING_HANDOFF. Подальша робота чекає нового доручення користувача.
