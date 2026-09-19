# Робота в ізольованій гілці

Гілка: `feat/telegram-complete`. Worktree: `/opt/ufv-worktrees/telegram-complete`.

Базовий commit `41d016c` — знімок наявної незакоміченої реалізації з `/opt/ufv`, не нова робота Telegram. Подальші commits містять окремий інкремент. Головний worktree, його індекс і production-процеси не змінювалися. Секрети, дампи Telegram, залежності та артефакти не входять до знімка.

Тестові PostgreSQL/NATS: контейнери `ufv-telegram-checks-db` і `ufv-telegram-checks-nats`, база `ufv_checks`, API порт 18196. Це окремі ресурси від інших агентів. Тимчасова конфігурація в `/tmp/ufv-telegram-checks`, не в Git.

Реалізовано: групи/коментарі, bulk-preview/add/join, стійкі jobs, агреговані метрики, кероване стеження за постами, модульні API/UI і контракти для аналізу. Поточні авторизація, ролі та feed залишаються базою інтеграції. Нові міграції: `0006_telegram_complete.sql` і `0007_telegram_watch_backfill.sql`; при інтеграції з паралельними гілками перевірити назви й залежності. Раніше застосовані міграції не змінено.

Детальний контракт і чесні межі: [TELEGRAM_COMPLETE.md](TELEGRAM_COMPLETE.md). Пороги watch policy — редаговані стартові припущення, а не виміряна точність. 2–24 дні застосовуються до старого поста/гілки, нові повідомлення джерела продовжують збиратися. LLM/інциденти/AI-бриф не підмінено правилами.

## Перевірки

- `npm ci` і `npm run build`: API/shared/web зібрані; TypeScript проходить.
- `39 passed`: справжні PostgreSQL 18, Hono/Better Auth та NATS JetStream; Telegram RPC замінені контрольованими об'єктами, зовнішнього вступу/публікацій немає.
- Перевірено idempotency, leases/stale workers, FloodWait/pause/resume, повторне підтвердження peer перед join, групи/форумні reply chains, курсори, edits/deletes, aggregate-only snapshots, lifecycle/ручний пріоритет, вимкнення збору, 401/403, scoped links і runtime DB grants.
- Chromium: 24 responsive перевірки Sources/bulk/watch/groups/inbox/feed на 320/768/1440 px, світла й темна теми; дії preview/queue/pause/resume, policy/pin, діалог метрик. Помилок консолі/HTTP немає. Виправлено переповнення grid на планшеті й metadata на вузькому екрані. Синтетичні дані лише в окремій ufv_checks.
- Live join двома реальними акаунтами й нові реальні коментарі **не перевірялися цією гілкою**. Другий акаунт має бути окремо авторизований власником.

## Інтеграція без конфлікту з паралельними агентами

1. Дивитися лише інкремент `git diff 41d016c feat/telegram-complete`, а не приймати знімок за нову реалізацію. Не копіювати весь worktree поверх `/opt/ufv` і не робити reset/clean.
2. Порівняти паралельні зміни в `apps/api/src/app.ts`, `routes/{feed,inbox,telegram-admin}.ts`, `apps/web/src/pages/{Feed,Incoming,Sources}.tsx`, `pages/telegram/*`, `styles/{layout,ui}.css`, `services/pipeline/{raw,telegram,processor,classification}.py`, `deploy/bootstrap.py`, `tests/test_runtime.py`, AGENTS/STATUS. Нові control/metrics/watch/jobs компоненти можна переносити окремо; імпорти й маршрути мають зберегти чужі additions.
3. Узгодити код головного worktree в його гілці, потім перенести feature commit(s) із `feat/telegram-complete`, вирішуючи конфлікти за змістом. Push/merge/production deployment цього інкременту не виконані.
4. Перед production-міграціями перевірити, що в `raw.source_state` немає кількох source_id з однаковим ненульовим peer_id. Нова унікальність навмисно зупинить міграцію при конфлікті; дані автоматично не видаляються.
5. Зібрати узгоджену версію, зробити резервну копію БД за чинною процедурою, застосувати нові міграції/grants. Зупинити старий collector перед запуском нового: одну StringSession не запускати одночасно у двох клієнтах.
6. Після deployment перевірити health, дві сесії/права джерел, одну групу, один канал із discussion, новий пост/вкладений коментар, метрики, ручний pause/pin і `/inbox` → feed. Тестові канали позначити явно; не змішувати синтетику з реальними результатами пітчу.

Під час фінального порівняння паралельний агент уже змінив `styles/layout.css`, `styles/ui.css`, AGENTS і STATUS. У layout він незалежно додав те саме `grid-template-columns:minmax(0,1fr)` — зберегти одну копію. Його інші відступи/сітки та новий опис нейтрального дизайну не відкочувати. Також у головному worktree змінилися API `index.ts`, `format.ts`, `AccountsTab.tsx`, ARCHITECTURE/DEV та інші документи; Telegram-інкремент їх не редагує. Ці зміни не переносилися назад із застарілого знімка.

Локальний тестовий API/сайт — `127.0.0.1:18196`, тільки loopback. Конфігурація тестового входу — root-only `/tmp/ufv-telegram-checks/env.json`. Це не production-паролі; не додавати файл до Git. Ресурси належать тільки цій гілці, назви вказані вище.

## Інтеграція виконана

2026-09-19 о 19:17 UTC інкремент c01f020 об’єднано з поточним головним деревом у feat/rss-collector та розгорнуто разом із RSS. Див. [RSS.md](RSS.md). Попередні твердження про відсутність deployment вище описують стан до цього релізу.
