# Розгортання на сервері

## Поточна схема

`/opt/ufv` належить `deploy:deploy`. Збережено TS-каркас Claude, файли перенесено зі scratchpad без `.env`, `node_modules` та `dist`. Старий окремий прототип FastAPI/SQLite виведено з активного дерева; резервна копія — `/var/backups/ufv-before-integration/`. Його авторизація не використовується.

Compose-проєкт `ufv`: постійний PostgreSQL 18, NATS 2 JetStream, TS API/React, Python collector і processor. PostgreSQL/NATS доступні тільки в окремій Docker-мережі. `127.0.0.1:8095` — локальний порт API; Caddy звертається до `ufv-api:8080` через спільну `warblan_app`. Collector має окремий вихід у мережу Telegram, processor не має зовнішнього доступу.

Volumes `ufv_pgdata`, `ufv_natsdata` переживають перезапуск контейнерів. **Не виконувати `down -v` для робочого середовища.** Автоматичний backup БД ще не налаштований; постійний volume його не замінює.

Секрети root-only: `/etc/ufv/production.env`. Перший адмін: `admin@hire.qpon`; початковий випадковий пароль у `/etc/ufv/admin-bootstrap.txt` (0600). Після входу доступна зміна пароля. Тестові паролі зі scratchpad у публічну БД не перенесені. Не копіювати захищені файли в Git.

## Оновлення вже налаштованого сервера

```bash
cd /opt/ufv
npm ci
npm run build
.venv/bin/pip install -r requirements.txt
# від root:
docker compose --env-file /etc/ufv/production.env -f deploy/compose.yml up -d postgres nats
.venv/bin/python deploy/bootstrap.py
docker compose --env-file /etc/ufv/production.env -f deploy/compose.yml build api collector
docker compose --env-file /etc/ufv/production.env -f deploy/compose.yml up -d
```

`bootstrap.py` читає захищений env, знаходить адресу контейнера PostgreSQL, застосовує SQL/Better Auth-міграції, видає мінімальні runtime grants та створює першого адміна тільки за його відсутності. Паролі не передаються аргументами shell. Скрипт призначений для цієї конфігурації сервера; на новому сервері спершу створити захищені секрети та зовнішню proxy-мережу.

```bash
docker compose --env-file /etc/ufv/production.env -f deploy/compose.yml ps
docker compose --env-file /etc/ufv/production.env -f deploy/compose.yml logs --tail 80 collector processor
curl --fail https://hire.qpon/api/health
```

`/api/health` перевіряє API/БД. Свіжі heartbeat collector/processor, помилки Telegram і прогрес обговорень перевіряти в адмінці. `running` контейнера не доводить успішний збір Telegram.

## Домен і Caddy

DNS `hire.qpon` уже вказує на цей сервер; змінювати Cloudflare-зону для перенаправлення застосунку не потрібно. Маршрут змінено у спільному `/opt/warblan/deploy/Caddyfile.hire`: apex обслуговує тільки UFV, wildcard hire повертає 404 і не веде до профілів Warblan. Інші доменні блоки збережено. HTTPS використовує наявний механізм Caddy/Cloudflare DNS-01; нові ключі в цей репозиторій не переносились.

Фактичний шаблон блока збережено в `deploy/Caddyfile.vodafone.fragment`; це фрагмент для спільного Caddy, не повний standalone-конфіг. Не запускати його як повний Caddyfile й не перезаписувати ним чужі маршрути. Перед reload перевірити цілий кандидат через `caddy validate`. Резервна копія початкового спільного файла — `/var/backups/ufv-before-integration/Caddyfile.hire.before-vodafone`.

Після оновлення перевірити `https://hire.qpon/`, `/api/health`, відмову `/api/feed` без сесії та здоров'я `https://h1hs.com/api/health`. Майбутні deploy Warblan мають зберігати окремий UFV-блок. На цьому сервері виконується reload Caddy без перебудови стороннього застосунку.

Зупинка тільки UFV: `docker compose --env-file /etc/ufv/production.env -f deploy/compose.yml stop`. Для відкату версії зберігати попередні образи; повернення домену до Warblan не є бажаним штатним відкатом за поточним дорученням користувача.
