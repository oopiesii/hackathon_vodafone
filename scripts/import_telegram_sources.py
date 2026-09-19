"""Join explicitly supplied Telegram channels and register usable ones as UFV sources.

The script is intentionally server-local: it reads the encrypted session and API
credentials from the protected UFV configuration and never prints them.  It is
safe to re-run after a FloodWait; existing sources are enabled rather than
duplicated.
"""
import argparse
import asyncio
import re
import sys
from collections import Counter

import psycopg
from psycopg.rows import dict_row
from telethon import TelegramClient, functions, types
from telethon.errors import FloodWaitError, RPCError
from telethon.sessions import StringSession

from telegram_setup import decrypt, server_config


PUBLIC_URL = re.compile(
    r"(?:https?://)?(?:t\.me|telegram\.me)/(?:s/)?(@?[A-Za-z][A-Za-z0-9_]{3,31})(?:/\d+)?",
    re.IGNORECASE,
)
INVITE_URL = re.compile(
    r"(?:https?://)?(?:t\.me|telegram\.me)/(?:joinchat/|\+)([A-Za-z0-9_-]+)",
    re.IGNORECASE,
)


def parse_targets(text):
    """Return public usernames and private invite hashes in first-seen order."""
    public, invites, seen_public, seen_invites = [], [], set(), set()
    for match in PUBLIC_URL.finditer(text):
        username = match.group(1).lstrip("@").lower()
        if username not in seen_public:
            public.append(username)
            seen_public.add(username)
    for match in INVITE_URL.finditer(text):
        invite = match.group(1)
        if invite not in seen_invites:
            invites.append(invite)
            seen_invites.add(invite)
    return public, invites


def register_source(conn, username, account_id, workflow_id, history_days, note):
    row = conn.execute(
        "select id from core.sources where kind='telegram' and lower(external_id)=lower(%s) for update",
        (username,),
    ).fetchone()
    if row:
        source_id = row["id"]
        conn.execute(
            """update core.sources set workflow_id=%s, account_id=%s, permission_note=%s,
               enabled=true where id=%s""",
            (workflow_id, account_id, note, source_id),
        )
        action = "source_import_enabled"
    else:
        source_id = conn.execute(
            """insert into core.sources(kind,external_id,workflow_id,account_id,permission_note,enabled,history_since)
               values('telegram',%s,%s,%s,%s,true,now()-make_interval(days=>%s)) returning id""",
            (username, workflow_id, account_id, note, history_days),
        ).fetchone()["id"]
        action = "source_import_created"
    conn.execute(
        "insert into core.audit(actor_id,action,object_type,object_id) values('server-cli',%s,'channel',%s)",
        (action, source_id),
    )
    return action


async def import_sources(args, public, invites):
    config = server_config()
    with psycopg.connect(config["url"], row_factory=dict_row) as conn:
        account = conn.execute(
            "select * from core.telegram_accounts where id=%s and enabled=true for update", (args.account,)
        ).fetchone()
        workflow = conn.execute(
            "select id from core.workflows where id=%s and enabled=true", (args.workflow,)
        ).fetchone()
    if not account or not account["session"] or not account["api_id"] or not account["api_hash"]:
        raise ValueError("Обраний Telegram-акаунт не має активної авторизованої сесії")
    if not workflow:
        raise ValueError("Обраний workflow не існує або вимкнений")

    session = StringSession(decrypt(account["session"], config["key"]))
    session.save_entities = False
    client = TelegramClient(session, account["api_id"], decrypt(account["api_hash"], config["key"]),
                            flood_sleep_threshold=0, request_retries=1, connection_retries=2,
                            sequential_updates=True, device_model="Vodafone monitoring prototype")
    outcomes = []
    note = "Явно надано адміністратором для тестового Telegram-моніторингу, 2026-09-19."
    try:
        await client.connect()
        if not await client.is_user_authorized():
            raise ValueError("Сесія Telegram більше не авторизована")
        interrupted = False
        for username in public:
            with psycopg.connect(config["url"], row_factory=dict_row) as conn:
                already_registered = conn.execute(
                    "select id from core.sources where kind='telegram' and lower(external_id)=lower(%s)",
                    (username,),
                ).fetchone()
                if already_registered:
                    action = register_source(conn, username, args.account, args.workflow, args.history_days, note)
            if already_registered:
                outcomes.append((username, action))
                continue
            while True:
                try:
                    entity = await client.get_entity(username)
                    if not isinstance(entity, types.Channel) or not entity.broadcast or not entity.username:
                        outcomes.append((username, "skipped_not_public_channel"))
                        break
                    try:
                        await client(functions.channels.JoinChannelRequest(entity))
                    except RPCError as error:
                        if type(error).__name__ != "UserAlreadyParticipantError":
                            raise
                    with psycopg.connect(config["url"], row_factory=dict_row) as conn:
                        action = register_source(conn, entity.username.lower(), args.account, args.workflow,
                                                 args.history_days, note)
                    outcomes.append((username, action))
                    break
                except FloodWaitError as error:
                    if args.wait_on_flood and error.seconds <= args.max_flood_wait:
                        outcomes.append((username, f"flood_wait_{error.seconds}s_retrying"))
                        await asyncio.sleep(error.seconds + 1)
                        continue
                    outcomes.append((username, f"flood_wait_{error.seconds}s"))
                    interrupted = True
                    break
                except RPCError as error:
                    outcomes.append((username, type(error).__name__))
                    break
                except ValueError as error:
                    outcomes.append((username, str(error)))
                    break
            if interrupted:
                break
        if not interrupted:
            for invite in invites:
                try:
                    checked = await client(functions.messages.CheckChatInviteRequest(invite))
                    if isinstance(checked, types.ChatInviteAlready):
                        entity = checked.chat
                    else:
                        result = await client(functions.messages.ImportChatInviteRequest(invite))
                        entity = result.chats[0] if result.chats else None
                    if isinstance(entity, types.Channel) and entity.broadcast and entity.username:
                        with psycopg.connect(config["url"], row_factory=dict_row) as conn:
                            action = register_source(conn, entity.username.lower(), args.account, args.workflow,
                                                     args.history_days, note)
                        outcomes.append(("+" + invite, action))
                    else:
                        outcomes.append(("+" + invite, "joined_not_collectable"))
                except FloodWaitError as error:
                    outcomes.append(("+" + invite, f"flood_wait_{error.seconds}s"))
                    break
                except RPCError as error:
                    outcomes.append(("+" + invite, type(error).__name__))
    finally:
        await client.disconnect()
    return outcomes


def main():
    parser = argparse.ArgumentParser(description="Приєднати явно надані Telegram-джерела та увімкнути їх в UFV")
    parser.add_argument("--account", type=int, default=1)
    parser.add_argument("--workflow", type=int, default=1)
    parser.add_argument("--history-days", type=int, default=7, choices=range(1, 91))
    parser.add_argument("--wait-on-flood", action="store_true", help="Продовжити після короткої паузи Telegram")
    parser.add_argument("--max-flood-wait", type=int, default=60, choices=range(1, 301),
                        help="Найдовша пауза, яку дозволено чекати з --wait-on-flood")
    parser.add_argument("--dry-run", action="store_true", help="Лише перевірити та порахувати адреси зі stdin")
    args = parser.parse_args()
    public, invites = parse_targets(sys.stdin.read())
    if not public and not invites:
        raise SystemExit("Не знайдено Telegram-адрес у stdin")
    if args.dry_run:
        print(f"public_channels={len(public)} private_invites={len(invites)}")
        print("\n".join(public + ["+" + item for item in invites]))
        return
    outcomes = asyncio.run(import_sources(args, public, invites))
    counts = Counter(result for _, result in outcomes)
    print(f"targets={len(public) + len(invites)} processed={len(outcomes)}")
    print(" ".join(f"{result}={count}" for result, count in sorted(counts.items())))
    for target, result in outcomes:
        if result not in {"source_import_created", "source_import_enabled"}:
            print(f"{target}: {result}")


if __name__ == "__main__":
    main()
