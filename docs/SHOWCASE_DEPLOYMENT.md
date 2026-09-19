# Публікація showcase — 2026-09-19

Пряма вказівка користувача: опублікувати новий макет dashboard у `/showcase`.

**Адреса: https://hire.qpon/showcase/** — без входу. Це автономний демонстраційний знімок із підписаними припущеннями, локальним станом дій і демо-оновленням, не підключення до live Telegram/API.

Опубліковано `apps/web/public/showcase/index.html` без зміни його змісту. SHA-256: `e4ffb419501f69f91e166f0b32c0193960198fc6ee899b386884edd4c2a5f87f`. Файл, стилі, шрифт і скрипти самодостатні. Для цього маршруту чинний `apps/api/src/index.ts` задає окрему CSP: inline-ресурси дозволені, мережеві з'єднання заборонені. Основна CSP інших маршрутів збережена.

## Що розгорнуто

- Кандидат: `ufv-api:showcase-20260919T155257Z`, також позначений `ufv-api:local` для чинного Compose.
- Це додатковий шар поверх попереднього production-образу: лише `/app/apps/api/dist/index.js` і `/app/apps/web/dist/showcase/index.html`.
- TypeScript entrypoint перевірено й скомпільовано у тимчасовий каталог. Повний React-редизайн із головного worktree не публікувався. Ніяких міграцій або злиття `feat/telegram-complete`.
- Замінено тільки контейнер `ufv-api-1` через `up -d --no-deps --no-build api`. Ідентифікатори й час старту collector, processor, PostgreSQL, NATS і Caddy залишилися тими самими.
- Спільний Caddy і DNS не змінювалися. Чужі файли дизайну збережено; основний застосунок має попередній frontend.

## Перевірки

Кандидат спочатку перевірено в окремому контейнері на loopback; HTML і основна сторінка звірені побайтово. Після публікації:

- `/showcase`, `/showcase/`, `/showcase/index.html`: 200, точний HTML та потрібна CSP.
- Chromium: три вкладки, 1440/390 px, відсутність переповнення та помилок скриптів; сторінка не звертається до API.
- `https://hire.qpon/api/health`: 200; `/api/feed` без сесії: 401.
- `https://h1hs.com/api/health`: 200.

Тимчасовий preview-контейнер видалено після перевірки. Захищений тимчасовий env також прибрано. Локальні артефакти й release manifest лежать поза Git, у `/var/tmp/ufv-showcase-release-20260919T155257Z` та `/var/tmp/ufv-showcase-release-state.json`.

## Відкат лише цієї публікації

Попередній образ збережено як `ufv-api:pre-showcase-20260919T155257Z`. Не виконувати відкат поверх пізнішого deployment іншого агента; спершу перевірити поточний образ.

```bash
cd /opt/ufv
docker tag ufv-api:pre-showcase-20260919T155257Z ufv-api:local
docker compose --env-file /etc/ufv/production.env -f deploy/compose.yml up -d --no-deps --no-build api
```

Майбутній повний build API з головного worktree вже міститиме showcase, оскільки HTML знаходиться в `apps/web/public`, а CSP — у вихідному entrypoint. Перед таким build окремо перевірити готовність інших незакомічених змін.
