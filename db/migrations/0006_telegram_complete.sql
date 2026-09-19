-- Additive Telegram contracts: keep the existing raw/event/feed API compatible.
alter table core.sources add column telegram_peer_id bigint;
update core.sources s set telegram_peer_id=r.peer_id from raw.source_state r where r.source_id=s.id;
create unique index source_telegram_identity on core.sources(telegram_peer_id) where telegram_peer_id is not null;
alter table raw.source_state add column source_type text not null default 'unknown'
 check(source_type in ('unknown','channel','supergroup','forum'));
alter table raw.source_state add column username text;
alter table raw.source_state add column linked_discussion_id bigint;
alter table raw.source_state add column last_success_at timestamptz;
create unique index raw_source_peer_identity on raw.source_state(peer_id) where peer_id is not null;

alter table raw.items drop constraint items_kind_check;
alter table raw.items add constraint items_kind_check check(kind in ('post','comment','group_message'));
alter table raw.items add column normalization_version text not null default 'normalize-v1';
alter table raw.items add column content_truncated boolean not null default false;
alter table raw.items add column topic_id bigint;
alter table raw.items add column canonical_item_id bigint references raw.items(id);
create index raw_physical_messages on raw.items(peer_id,message_id);

create table raw.item_versions (
 item_id bigint not null references raw.items(id) on delete cascade,
 version integer not null, text text not null, content_hash text not null,
 normalization_version text not null, observed_at timestamptz not null default now(),
 primary key(item_id,version)
);
insert into raw.item_versions(item_id,version,text,content_hash,normalization_version)
 select id,version,text,content_hash,normalization_version from raw.items where not deleted;

create table raw.metric_snapshots (
 id bigint generated always as identity primary key,
 item_id bigint not null references raw.items(id) on delete cascade,
 observed_at timestamptz not null default now(),
 views bigint check(views>=0), forwards bigint check(forwards>=0), replies bigint check(replies>=0),
 reactions jsonb, available jsonb not null default '{}',
 unique(item_id,observed_at)
);
create index metric_snapshots_item_time on raw.metric_snapshots(item_id,observed_at desc,id desc);

create table core.telegram_watch_policies (
 workflow_id bigint primary key references core.workflows(id) on delete cascade,
 active_days integer not null default 2 check(active_days between 1 and 24),
 sleep_days integer not null default 7 check(sleep_days between 2 and 90),
 archive_days integer not null default 24 check(archive_days between 2 and 365),
 active_seconds integer not null default 300 check(active_seconds between 30 and 86400),
 cooling_seconds integer not null default 3600 check(cooling_seconds between 60 and 604800),
 sleeping_seconds integer not null default 21600 check(sleeping_seconds between 300 and 604800),
 min_views_delta integer not null default 100 check(min_views_delta>=1),
 min_replies_delta integer not null default 1 check(min_replies_delta>=1),
 min_reactions_delta integer not null default 5 check(min_reactions_delta>=1),
 revision integer not null default 1,
 check(active_days<sleep_days and sleep_days<archive_days),
 check(active_seconds<=cooling_seconds and cooling_seconds<=sleeping_seconds)
);
create table core.telegram_watch_overrides (
 item_id bigint primary key references raw.items(id) on delete cascade,
 mode text not null check(mode in ('auto','pinned','paused')),
 reason text not null default '', updated_by text not null, updated_at timestamptz not null default now()
);
create table raw.watch_state (
 item_id bigint primary key references raw.items(id) on delete cascade,
 state text not null default 'active' check(state in ('active','cooling','sleeping','archived','paused','blocked','deleted')),
 next_check_at timestamptz default now(), last_checked_at timestamptz, last_activity_at timestamptz,
 quiet_checks integer not null default 0, reason text not null default 'Нове повідомлення',
 last_error text, policy_revision integer not null default 1,
 snapshot_id bigint references raw.metric_snapshots(id),
 lease_until timestamptz, lease_token text, override_applied_at timestamptz
);
create index watch_due on raw.watch_state(next_check_at) where next_check_at is not null;

create table raw.source_access (
 account_id bigint not null references core.telegram_accounts(id) on delete cascade,
 peer_id bigint not null, username text, source_type text not null,
 membership text not null, access_hash bigint, checked_at timestamptz not null default now(),
 primary key(account_id,peer_id)
);

-- Jobs contain source coordinates, never credentials or Telegram message text.
create table core.telegram_imports (
 id uuid primary key, workflow_id bigint not null references core.workflows(id) on delete cascade,
 account_id bigint not null references core.telegram_accounts(id),
 idempotency_key text not null unique, request_hash text not null,
 permission_note text not null, enabled boolean not null default true,
 created_by text not null, created_at timestamptz not null default now()
);
create table core.telegram_jobs (
 id bigint generated always as identity primary key,
 import_id uuid references core.telegram_imports(id) on delete cascade,
 account_id bigint not null references core.telegram_accounts(id),
 workflow_id bigint not null references core.workflows(id) on delete cascade,
 source_id bigint references core.sources(id),
 username text not null, kind text not null check(kind in ('resolve','join')),
 state text not null default 'queued' check(state in ('queued','running','resolved','joined','already_joined','approval_pending','flood_wait','failed','cancelled','paused')),
 result jsonb not null default '{}', attempts integer not null default 0,
 next_run_at timestamptz not null default now(), lease_until timestamptz, lease_token text,
 last_error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(import_id,username,kind)
);
create index telegram_jobs_due on core.telegram_jobs(account_id,next_run_at);

-- API uses narrow read models rather than access to raw message storage.
create view core.telegram_metrics as
 select m.*,i.source_id,i.kind,i.deleted,s.workflow_id
 from raw.metric_snapshots m join raw.items i on i.id=m.item_id join core.sources s on s.id=i.source_id;
create view core.telegram_watches as
 select w.*,i.source_id,i.kind,i.published_at,i.url,i.deleted,s.workflow_id,s.external_id,
 coalesce(o.mode,'auto') override_mode,coalesce(o.reason,'') override_reason,
 (select count(*)::int from raw.items r where r.source_id=i.source_id
   and r.thread_item_id=i.source_item_id and r.kind='comment' and not r.deleted) collected_replies
 from raw.watch_state w join raw.items i on i.id=w.item_id join core.sources s on s.id=i.source_id
 left join core.telegram_watch_overrides o on o.item_id=i.id;
create view core.telegram_item_metadata as
 select id,source_id,normalization_version,content_truncated,topic_id,canonical_item_id from raw.items;

-- Application roles exist in production; fresh developer databases can apply first.
do $$ begin
 if exists(select 1 from pg_roles where rolname='ufv_api') then
  grant select on core.telegram_metrics,core.telegram_watches,core.telegram_item_metadata to ufv_api;
  grant select,insert,update,delete on core.telegram_watch_policies,core.telegram_watch_overrides,core.telegram_imports,core.telegram_jobs to ufv_api;
  grant usage,select on sequence core.telegram_jobs_id_seq to ufv_api;
 end if;
 if exists(select 1 from pg_roles where rolname='ufv_collector') then
  grant select on core.telegram_watch_policies,core.telegram_watch_overrides to ufv_collector;
  grant select,update on core.telegram_jobs to ufv_collector;
  grant select,insert,update,delete on raw.item_versions,raw.metric_snapshots,raw.watch_state,raw.source_access to ufv_collector;
  grant usage,select on sequence raw.metric_snapshots_id_seq to ufv_collector;
 end if;
end $$;
