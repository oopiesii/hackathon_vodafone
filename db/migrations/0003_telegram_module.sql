-- Runtime configuration belongs to the API; observed state belongs to the collector.
create table core.workflows (
 id bigint generated always as identity primary key, name text not null,
 enabled boolean not null default false, comments_enabled boolean not null default true,
 filter_spam boolean not null default true, poll_seconds integer not null default 30 check(poll_seconds between 15 and 3600),
 history_days integer not null default 7 check(history_days between 1 and 90),
 processor_revision integer not null default 1, created_at timestamptz not null default now()
);
insert into core.workflows(name) values ('Vodafone та український телеком');
create table core.modules (name text primary key, enabled boolean not null default false);
insert into core.modules values ('telegram',false);
create table core.telegram_accounts (
 id bigint generated always as identity primary key, label text not null, api_id integer not null,
 api_hash text not null, session text not null, session_fingerprint text not null unique,
 enabled boolean not null default true, revision integer not null default 1
);
alter table core.sources add column workflow_id bigint not null default 1 references core.workflows(id);
alter table core.sources add column account_id bigint references core.telegram_accounts(id);
alter table core.sources add column permission_note text not null default '';
alter table core.sources add column history_since timestamptz not null default now();
create table raw.account_status (
 account_id bigint primary key references core.telegram_accounts(id) on delete cascade,
 status text not null default 'pending', last_error text, cooldown_until timestamptz, checked_at timestamptz
);
create table raw.memberships (
 account_id bigint not null references core.telegram_accounts(id) on delete cascade,
 peer_id bigint not null, username text not null, title text not null, observed_at timestamptz not null default now(),
 primary key(account_id,peer_id)
);
create table raw.source_state (
 source_id bigint primary key references core.sources(id), peer_id bigint, title text,
 post_cursor bigint not null default 0, status text not null default 'pending', last_error text,
 last_polled_at timestamptz
);
create table raw.threads (
 id bigint generated always as identity primary key, source_id bigint not null references core.sources(id),
 post_id bigint not null, discussion_id bigint, root_id bigint, comment_cursor bigint not null default 0,
 status text not null default 'resolve', last_error text, last_polled_at timestamptz,
 unique(source_id,post_id)
);
alter table raw.items add column peer_id bigint;
alter table raw.items add column message_id bigint;
alter table raw.items add column kind text not null default 'post' check(kind in ('post','comment'));
alter table raw.items add column thread_item_id text;
alter table raw.items add column edited_at timestamptz;
alter table raw.items add column version integer not null default 1;
alter table raw.items add column deleted boolean not null default false;
alter table raw.items add column last_seen_at timestamptz not null default now();
create table raw.outbox (
 id bigint generated always as identity primary key, item_id bigint not null references raw.items(id),
 version integer not null, published_at timestamptz, unique(item_id,version)
);
create index raw_outbox_pending on raw.outbox(id) where published_at is null;
create table core.processing_receipts (
 raw_item_id bigint primary key references raw.items(id), version integer not null,
 processor_revision integer not null, processed_at timestamptz not null default now()
);
alter table core.mentions add column kind text not null default 'post';
alter table core.mentions add column decision text not null default 'review' check(decision in ('accepted','review','rejected'));
alter table core.mentions add column reason text not null default '';
alter table core.mentions add column brand text not null default 'telecom';
alter table core.mentions add column context_id bigint references core.mentions(id);
alter table core.mentions add column duplicate_of bigint references core.mentions(id);
alter table core.mentions add column fetched_at timestamptz;
alter table core.mentions add column edited_at timestamptz;
alter table core.mentions add column content_hash text;
alter table core.mentions add column raw_version integer not null default 1;
alter table core.mentions add column deleted boolean not null default false;
create table core.review_decisions (
 mention_id bigint primary key references core.mentions(id), decision text not null check(decision in ('accepted','review','rejected')),
 raw_version integer not null, reviewed_by text not null, reviewed_at timestamptz not null default now()
);
create table auth.share_links (
 id bigint generated always as identity primary key, workflow_id bigint not null references core.workflows(id),
 name text not null, token_hash text not null unique, scope text not null check(scope in ('summary','posts','full')),
 channel_ids jsonb not null default '[]', topics jsonb not null default '[]',
 expires_at timestamptz not null, revoked boolean not null default false, created_by text not null,
 created_at timestamptz not null default now()
);
create table auth.share_sessions (
 token_hash text primary key, share_id bigint not null references auth.share_links(id), expires_at timestamptz not null
);
create table core.audit (
 id bigint generated always as identity primary key, occurred_at timestamptz not null default now(),
 actor_id text not null, action text not null, object_type text not null, object_id bigint
);
create table raw.service_status (name text primary key, heartbeat_at timestamptz not null default now(), detail text not null);
create table core.service_status (name text primary key, heartbeat_at timestamptz not null default now(), detail text not null);
