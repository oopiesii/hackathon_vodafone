"""Authorize a Telegram account and register it directly in the UFV website."""
import argparse
import asyncio
import getpass
import json
import re
from pathlib import Path

from telethon import TelegramClient
from telethon.sessions import StringSession
from telegram_setup import decrypt, register_session, saved_api_credentials, save_recovery, server_config


async def main(args):
    config = server_config()
    recovered = None
    if args.recover_file:
        recovered = json.loads(decrypt(Path(args.recover_file).read_text(), config['key']))
        StringSession(recovered['session'])
    credentials = (recovered['api_id'], recovered['api_hash']) if recovered and recovered.get('api_id') and recovered.get('api_hash') else None
    if credentials is None and not args.new_api:
        credentials = saved_api_credentials(config)
    if credentials:
        api_id, api_hash = credentials
        print('Використовую API-доступ, уже збережений у системі.')
    else:
        api_id = int(input('Telegram API ID: ').strip())
        api_hash = getpass.getpass('API hash (приховано): ').strip()
    if api_id <= 0 or not re.fullmatch(r'[a-fA-F0-9]{32}', api_hash):
        raise ValueError('Перевірте API ID/hash: авторизація ще не почалася.')
    # Preflight before asking for a login code.
    import psycopg
    with psycopg.connect(config['url']) as conn:
        conn.execute('select id from core.telegram_accounts limit 1')
        if args.account:
            row = conn.execute('select session is not null from core.telegram_accounts where id=%s', (args.account,)).fetchone()
            if not row:
                raise ValueError('Такого місця акаунта немає')
            if row[0] and not (args.import_file or recovered):
                raise ValueError('Тут уже збережено сесію. Використайте інше порожнє місце.')
    client = None
    fallback = None
    try:
        if recovered:
            session = recovered['session']
        elif args.import_file:
            session = Path(args.import_file).expanduser().read_text().strip()
            # Recovery reuses authorization and never requests another OTP.
            StringSession(session)
        else:
            memory = StringSession()
            memory.save_entities = False
            client = TelegramClient(memory, api_id, api_hash)
            await client.start(phone=lambda: getpass.getpass('Номер телефону (приховано): '),
                               code_callback=lambda: getpass.getpass('Код Telegram (приховано): '),
                               password=lambda: getpass.getpass('Пароль 2FA (приховано): '))
            session = client.session.save()
        fallback = save_recovery(config, session, api_id, api_hash)
        # Disconnect before the collector starts using the same authorization.
        if client:
            await client.disconnect()
            client = None
        result = register_session(config, session, api_id, api_hash, args.account)
        fallback.unlink()
        fallback = None
        print(f"Готово: {result['label']} (#{result['id']}) додано безпосередньо до сайту.")
        print('https://hire.qpon/sources/telegram?tab=accounts — копіювати сесію вручну не потрібно.')
        print('Канали для збору задаються окремо в налаштуваннях Telegram.')
    except BaseException:
        if fallback:
            print(f'Авторизацію збережено зашифровано: {fallback}. Повторний код не потрібен.')
            print(f'Повторіть зі --recover-file {fallback}' + (f' --account {args.account}' if args.account else ''))
        raise
    finally:
        if client:
            await client.disconnect()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Вхід у Telegram → автоматичне підключення до UFV')
    parser.add_argument('--account', type=int, help='ID порожнього місця на сайті; за замовчуванням перше вільне')
    recovery = parser.add_mutually_exclusive_group()
    recovery.add_argument('--import-file', help='Імпортувати наявну StringSession без повторної авторизації')
    recovery.add_argument('--recover-file', help='Повторити запис із зашифрованої резервної копії без нового коду')
    parser.add_argument('--new-api', action='store_true', help='Ввести інші API ID/hash замість збережених')
    try:
        asyncio.run(main(parser.parse_args()))
    except (KeyboardInterrupt, EOFError):
        print('\nПідключення перервано.')
        raise SystemExit(1)
    except Exception as error:
        print(str(error) if isinstance(error, ValueError) else f'Підключення не завершено ({type(error).__name__}); секрети не виводяться.')
        raise SystemExit(1)
