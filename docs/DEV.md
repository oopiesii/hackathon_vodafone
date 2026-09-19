# Локальна розробка

Потрібні Node.js ≥22, Python ≥3.11, Docker Compose або власні PostgreSQL/NATS. Запускати команди з кореня репозиторію. Production-конфігурація окрема, див. [DEPLOYMENT.md](DEPLOYMENT.md).

```bash
docker compose -f deploy/compose.dev.yml up -d
cp .env.example .env
```

Заповніть `.env`: локальний `DATABASE_URL=postgres://ufv:ufv@127.0.0.1:5433/ufv`, `NATS_URL=nats://127.0.0.1:4222`, `PUBLIC_URL=http://localhost:5173`, випадковий `BETTER_AUTH_SECRET` та 32-байтовий base64url `TG_SESSION_KEY`. Останній генерується `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`. Усі значення тримати поза Git.

```bash
npm ci
npm run db:migrate
npm run auth:create-admin -- you@example.com "Адміністратор"
npm run dev:api
# в іншому терміналі:
npm run dev:web
```

Відкривати `http://localhost:5173`; Vite проксіює `/api` на API. `PUBLIC_URL` повинен точно збігатися з origin браузера. Пароль першого адміна запитується інтерактивно, мінімум 12 символів. Інших користувачів створюють у «Користувачі». Самореєстрації немає.

Python-процеси читають environment, а не `.env` автоматично. Експортуйте `DATABASE_URL`, `NATS_URL`, `TG_SESSION_KEY` у їхньому терміналі або запускайте через налаштований service manager; використовуйте той самий ключ, що в API.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
PYTHONPATH=services .venv/bin/python -m pipeline.telegram
# в іншому терміналі з тими самими environment:
PYTHONPATH=services .venv/bin/python -m pipeline.processor
```

Collector не підключається до Telegram, доки admin не додасть сесію й не увімкне модуль. [Інструкція підключення](TELEGRAM.md).

## Перевірки

```bash
npm run typecheck
npm run build
.venv/bin/python -m pytest -q tests/test_classification.py
```

Після build `node --env-file=.env apps/api/dist/index.js` або `npm start -w @ufv/api` обслуговує і API, і зібраний React. Для такого запуску змініть `PUBLIC_URL` на адресу самого API; Vite вже не потрібен.

`tests/test_runtime.py` перевіряє реальні PostgreSQL, Hono/Better Auth і NATS; Telegram-мережа замінена контрольованими об'єктами. Для нього створити **окрему** БД `ufv_checks`, застосувати міграції з `DATABASE_URL` цієї БД, створити `admin@ufv.test`, підняти API на `http://127.0.0.1:18096` з відповідним `PUBLIC_URL`. NATS має окремі stream/subject, наприклад `UFV_CHECKS_RAW` / `checks.raw.item.created`.

Створити поза Git JSON-файл режиму 0600 з полями `DATABASE_URL` (власник тестової БД для reset fixtures), `PUBLIC_URL`, `ADMIN_PASSWORD`, `TG_SESSION_KEY`, `NATS_URL`, `UFV_NATS_STREAM`, `UFV_NATS_SUBJECT`. Передати його шлях через `UFV_TEST_ENV`:

```bash
UFV_TEST_ENV=/protected/path/test-env.json .venv/bin/python -m pytest -q tests/test_runtime.py
```

Тести видаляють fixture-дані лише в БД з назвою `ufv_checks`; перевіряють це до reset. Не підставляти production URL. Для перевірки прав API запустити його окремою роллю `ufv_api` з grants як у `deploy/bootstrap.py`; Python fixtures залишаються власником тестової БД. Без конфігурації інтеграційні тести пропускаються, що не є успішною інтеграційною перевіркою.

Браузерні сценарії перевірено Chromium/Playwright: вхід, роль, стрічка, адмінка Telegram (до редизайну — iframe), обмежений share, ширини 320/768/1024/1440. Скриншоти локально в ігнорованому `artifacts/`. Chrome DevTools MCP на цьому сервері недоступний; не стверджувати, що він був використаний.

## Дизайн-система

Редизайн 2026-09-19 за прямою вказівкою користувача: строгий нейтральний стиль на зразок shadcn/ui, без червоної гами. Tailwind/Radix не додавались: CSP сайту (`style-src 'self'`, `font-src 'self'`) і невеликий обсяг UI краще обслуговує власний CSS.

- `apps/web/src/styles/tokens.css` — кольори (світла/темна тема; `data-theme` на `<html>` перекриває системну), радіуси, тіні та **єдина шкала шрифтів `--f-*`**. Нові розміри додавати в шкалу, а не писати px у компонентах.
- `base.css` — елементи форм і таблиці; `ui.css` — кнопки, картки, позначки, сегменти, діалог; `layout.css` — каркас, бічна панель, сторінки.
- `components/ui.tsx` — `PageHeader`, `Card`, `Badge`, `Alert`, `Field`, `Switch`, `Tabs`, `Dialog`, `Empty`, `Stat`. Підписи станів і тем — `lib/labels.ts`, дати — `lib/format.ts`.
- Шрифт Inter (`@fontsource-variable/inter`) і значки `lucide-react` збираються в bundle; зовнішні CDN заборонені CSP.
- Колір стану несе значення лише разом із текстом позначки. Червоний лишився тільки для помилок і незворотних дій.
- Сітки з довільним вмістом оголошувати як `minmax(0,1fr)`: інакше довгий рядок (команда, сегменти) розтягує сторінку на мобільному.

Перед твердженням «виглядає правильно» зібрати bundle і подивитися знімки в headless Chromium (світла/темна тема, 1440/768/390 px). Скрипти та знімки останньої перевірки лежать локально в ігнорованому `artifacts/redesign-2026-09-19/`; API в них підставний, тому це перевірка вигляду й запитів, а не інтеграції.
