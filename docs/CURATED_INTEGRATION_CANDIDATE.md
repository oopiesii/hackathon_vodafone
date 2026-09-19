# Кандидат інтеграції семантичних агрегатів

База — `feat/night-ui` на `443c504`, ізольована гілка `feat/night-curated`. Підстава — доручення root інтегрувати новий семантичний відбір паралельної сесії з атомарними поколіннями нічного потоку. Головне дерево і production не змінювалися.

## Зовнішній snapshot

Файли скопійовано без змін під час активної зовнішньої сесії; на момент копіювання вони були pending external snapshot. Після завершення зовнішньої сесії root повідомив `main 581d0d7`; SHA повторно звірені й збігаються:

| Файл | SHA-256 |
|---|---|
| `0020_curated_dashboard.sql` | `fd192f124b239a305e4930b9eb193f05aad2798e5fb4e56b4225d24711bc011b` |
| `0021_curated_visible_items.sql` | `f2d6420a115dfb1feac67c8edce1e76f79ed668ac094f3b9243b82e8b482c9fc` |
| `0022_curated_candidate_lookup.sql` | `420094404966a6269fb2b6be40e7c66e179107eb797192bc680b6506b8ee9941` |

У `ufv_checks` усі три вже були застосовані іншою сесією; їхні SHA відповідають копіям. Цей потік не застосовував їх повторно й не змінював їхній вміст. Окремий snapshot-коміт потрібен лише для відтворюваності гілки; у злиту з `581d0d7` гілку слід переносити тільки новий compatibility-коміт.

## Контракт 0030

`core.daily_rollups` лишається фізичною таблицею. `refresh_dashboard_rollups()` обчислює її з `curated_items`, зберігає всі effective decisions для операторської coverage та публікує їх атомарно із `dashboard_rollup_state`. `curated_daily_rollups` тепер читає тільки фізичну таблицю, поточний workflow джерела й чистий стан покоління; містить accepted/review. API має читати coverage і агрегати одним запитом та приховувати весь підсумок, якщо покоління неповне. SQL і API слід розгортати разом: саме view відсікає брудне джерело, але повноту всього workflow забезпечує API.

Додаткові поля фізичного агрегату: `metrics_oldest_at`, `metrics_newest_at`, `rolling_7d_count`. Останнє — кількість матеріалів за рухомі 7 днів на час побудови покоління, а не сума 7 календарних днів; дозволяє показати Vodafone 7d без raw-запиту у місячному режимі. Час покоління має бути видимим. NEG та IRONIC збережені окремо; формулу частки SQL-кандидат не змінює, UI/API використовує NEG-only за новим контрактом користувача.

Збережено уточнену політику `docs/CURATED_DASHBOARD.md` із головної сесії: будь-який completed run вмикає семантичний gate для всього workflow; нові/застарілі матеріали та матеріали без актуальної дозволеної мітки стають pending, без повернення словникового шуму. Scope source_ids/source_kind обмежує застосування конкретної one-shot мітки. Continuous running run — окремий контракт: чинні llm_allowed/basis, enabled workflow/source, RSS rights та завершений receipt для конкретної версії/model/prompt. Це не вмикає жодного нового права на LLM.

Exact-version людське рішення має пріоритет, крім явного карантину test_source_ids, збереженого з нового продуктового контракту. Текст/контекст перевіряються за поточною версією. Поява missing parent, зміна/видалення/перенесення батьківського матеріалу та відкликання continuous-прав інвалідують залежні джерела.

Інвалідація охоплює labels/receipts, активацію й відкликання run та його scope/model/prompt, raw version/deletion/source changes, missing parent arrival, source workflow/rights/enabled та RSS rights. Функція бере state-locks у порядку source_id; агрегати не блокуються раніше стану. `0016` збережено: після перенесення джерела попередній workflow не бачить його чисел.

S2 `analyst_items.rule_decision` зберігає історичне ім’я поля, але повертає effective semantic decision; `analyst_rollups` — чисті покоління з чинними правами й поточним workflow. Це узгоджує `current_ai_summaries` із semantic invalidation; старе зведення не воскресає після перерахунку. API evidence lookup також потрібно переключити на curated view під час merge.

## Перевірки та межі

`tests/test_curated_rollups.py` використовує тільки захищений конфіг `ufv_checks`. Кожен тест застосовує ще не опублікований 0030 усередині транзакції та відкочує і схему, і власні дані. Жодного TRUNCATE й жодних викликів Telegram/LLM. Перевіряються scope/global gate, нові/stale матеріали, manual/quarantine, continuous receipt/rights, cross-source parent changes, missing parent, run transitions/label deletion, фізичні реакції/часи/7d, current workflow move, S2 semantic flip та execute privileges. План місячного SELECT містить тільки daily_rollups, sources і dashboard_rollup_state; API-role читає його після REVOKE на текстові views.

Це цільова SQL-перевірка, не production benchmark і не доказ відсутності всіх конкурентних конфліктів. Остаточна API/рольова інтеграція та браузерні перевірки належать merged UI/API гілці root. Нові helper functions SECURITY DEFINER мають фіксований search_path і закритий PUBLIC EXECUTE; права runtime не розширюються до raw або довільної інвалідації.

## Перевірений перерахунок і компроміс свіжості

Read-only профіль на production, без DDL/записів: 50 джерел, 85 555 raw-рядків. Початковий JOIN-перерахунок найбільшого джерела не вкладався в 4 s timeout. EXPLAIN показав повторні raw/context lookups. У фінальному варіанті спочатку вибираються ID заданого джерела за 30 днів, далі виконується параметризований lateral lookup з вузькою проєкцією; поточність контексту обчислюється один раз. План має 76 вузлів замість 170, без summary/evidence branches. Вимірювання всіх 50 SELECT: **9,174 s** сумарно, **3,267 s** максимум (28 919 raw-рядків), **0 timeout** за межею 4 s. Це час SELECT без запису агрегатів і не SLA. Continuous-частина у профілі вимкнена read-only CTE, бо production на момент вимірювання ще не мав 0012/analyst; прав або даних профіль не змінював.

Новий overload `refresh_dashboard_rollups(bigint)` перераховує одне джерело; legacy no-arg entry point лишається для ручного/тестового повного прогону. Runtime processor використовує `refresh_rollup_batch`: до 15 s за tick, декілька джерел поспіль, кожне окремою транзакцією з statement_timeout 5 s, lock_timeout 1 s і jit=off. Межа batch може перевищитися на тривалість останньої транзакції, тобто до приблизно 20 s. Timeout джерела дає 60 s backoff лише для нього; інші джерела продовжують оброблятися. Batch виконується через asyncio.to_thread, щоб не блокувати NATS-consumer. Bootstrap повторює SELECT rollup_state та EXECUTE вузького overload після створення runtime-ролі.

**Обрано агентом і погоджено root:** новий raw без зміни чинного accepted-доказу не робить існуючий generation брудним. Нове джерело отримує dirty state; поява missing parent негайно інвалідує залежні мітки. Нові pending/collected операторські числа можуть відставати до наступного покоління, тому API показує aggregate_updated_at/aggregation.generated_at. Це знімок на вказаний час, а не поточний повний лічильник. metric_snapshots та watch_state також входять через періодичний перерахунок — вони не мають тригерів постійного dirty для всього джерела.

Звичайний processor INSERT mention та незмінений повторний UPDATE не створюють dirty. Підтверджений зайвий шлях — retry після появи parent змінює словникове review→accepted, хоча effective semantic рішення лишається pending. Вузький guard пропускає тільки такий UPDATE без зміни версії/видалення/quote, без будь-якої AI-мітки й без людського рішення. Версія, вміст, видалення, review, labels та права мають попередню негайну інвалідацію. Regression викликає справжній process() для нового/повторного повідомлення, late-parent retry та наступного edit.

Фінально: **18 targeted tests passed**, Python compile і diff check успішні, secret scanner не знайшов типових секретів. 50-source SQL warmup завершує dirty_sources=0; тести worker перевіряють окремі транзакції, batch budget та відсутність starvation після timeout. Незалежний review AI-агента не знайшов High/Critical у SQL-контракті; performance/runtime доопрацювання передані на додатковий погляд. API-файли dashboard/feed/S2 у night-ui узгоджено й staged на доручення root; API typecheck пройшов. Merge-коміт належить root.

## Повний merged backend regression

У night-ui після інтеграції `c4c16b0` і main security fixes застосовано 0030 **тільки на ufv_checks**; checksum міграції тепер зафіксовано, файл незмінний. Повний TypeScript typecheck/build пройшов. Початковий backend-прогін: 127 passed, 4 dashboard/actions HTTP timeouts за 5 s; API завершував запити за 6–7 s. Контрольний прогін тих самих п’яти тестів із jit=off пройшов за 4,60 s. Додано `options: '-c jit=off'` лише до appPool, без ALTER ROLE чи глобальної настройки PostgreSQL; auth pool не змінено. Повторний повний прогін без PGOPTIONS: **131 passed in 30,32 s**.

Bootstrap перевірено за точними SQL-рядками з поточного deploy/bootstrap.py: чотири dashboard grants двічі застосовані до нових тимчасових ролей (нова/наявна роль). Перевірені фактичні ufv_api/collector/processor privileges; тимчасовий processor справді виконав overload. Зайві API DELETE і collector INSERT не надані. Усі тимчасові ролі та зміни відкочено; production bootstrap не запускався.

Повторення на цій машині з night-ui (захищені конфіги поза Git, без виводу секретів):

```sh
npm run typecheck
npm run build
/opt/ufv/.venv/bin/python /tmp/ufv-night-api-setup.py
/opt/ufv/.venv/bin/python /tmp/ufv-night-api-test-run.py tests
/opt/ufv/.venv/bin/python /tmp/check-curated-bootstrap-grants.py
```

Runner використовує API runtime-роль на `http://127.0.0.1:18203`, а fixtures — власника виключно ufv_checks; після тестів сервер зупиняється. Для acceptance root підготовлено `/tmp/ufv-night-acceptance-run.py`: запускає built API, scripts/check_curated_dashboard.py із правильними UFV_TEST_ENV/UFV_CHECK_ORIGIN та завершує сервер. Production-вимірювання живих dashboard 24h/7d/30d після релізу належать root; цей потік не розгортав сервіс.
