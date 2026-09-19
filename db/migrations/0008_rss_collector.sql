-- Independent of Telegram 0006/0007 work; configuration is API-owned, observed state collector-owned.
insert into core.modules(name,enabled) values ('rss',false) on conflict do nothing;
create table core.rss_sources (
 source_id bigint primary key references core.sources(id),
 poll_seconds integer not null default 300 check(poll_seconds between 120 and 86400),
 rights_status text not null default 'pending' check(rights_status in ('allowed','pending','blocked')),
 terms_url text not null, publisher text not null,
 revision integer not null default 1
);
create table raw.rss_state (
 source_id bigint primary key references core.sources(id),
 etag text, last_modified text, last_attempt_at timestamptz, last_success_at timestamptz,
 next_poll_at timestamptz not null default now(), lease_until timestamptz, lease_token text,
 status text not null default 'pending', last_error text, http_status integer,
 failures integer not null default 0, last_item_count integer not null default 0,
 last_new_count integer not null default 0, skipped_count integer not null default 0,
 observed_revision integer not null default 0
);
alter table raw.items add column content_scope text not null default 'message';
create view core.rss_status as
select s.id,s.title,s.external_id feed_url,s.workflow_id,s.enabled,s.permission_note,
 w.name workflow_name,w.enabled workflow_enabled,r.poll_seconds,r.rights_status,r.terms_url,r.publisher,
 st.status,st.last_error,st.http_status,st.last_attempt_at,st.last_success_at,st.next_poll_at,
 st.failures,st.last_item_count,st.last_new_count,st.skipped_count,
 (select count(*)::int from raw.items i where i.source_id=s.id) collected_count,
 (select count(*)::int from core.mentions m where m.source_id=s.id and m.decision='accepted' and not m.deleted) accepted_count
from core.sources s join core.rss_sources r on r.source_id=s.id
join core.workflows w on w.id=s.workflow_id left join raw.rss_state st on st.source_id=s.id
where s.kind='rss';

create or replace view core.incoming_items as
select i.id, i.source_id, s.workflow_id, s.account_id, s.external_id,
 coalesce(s.title,s.external_id) channel_title, w.name workflow_name,
 a.label account_label, i.kind, i.text, i.url, i.published_at, i.fetched_at,
 i.edited_at, i.last_seen_at, i.version, i.deleted, i.parent_item_id,
 i.source_item_id, i.thread_item_id, m.id mention_id, m.analyzed_at,
 case when i.deleted then 'deleted'
      when p.raw_item_id is null or p.version<>i.version or p.processor_revision<>w.processor_revision
        or m.raw_item_id is null or m.raw_version<>i.version then 'pending'
      else coalesce(r.decision,m.decision) end state,
 case when i.deleted then 'Видалено у джерелі.'
      when p.raw_item_id is null or p.version<>i.version or p.processor_revision<>w.processor_revision
        or m.raw_item_id is null or m.raw_version<>i.version then 'Очікує обробки поточної версії.'
      else m.reason end reason,
 m.category topic, s.kind source_kind, i.title, i.content_scope
from raw.items i
join core.sources s on s.id=i.source_id
join core.workflows w on w.id=s.workflow_id
left join core.telegram_accounts a on a.id=s.account_id
left join core.mentions m on m.raw_item_id=i.id
left join core.processing_receipts p on p.raw_item_id=i.id
left join core.review_decisions r on r.mention_id=m.id and r.raw_version=i.version;

-- Existing production roles; bootstrap also handles roles created after migrations.
do $$ begin
 if exists(select 1 from pg_roles where rolname='ufv_api') then
  grant select on core.rss_sources,core.rss_status to ufv_api;
  grant insert,update,delete on core.rss_sources to ufv_api;
 end if;
 if exists(select 1 from pg_roles where rolname='ufv_collector') then
  grant select on core.rss_sources to ufv_collector;
  grant select,insert,update,delete on raw.rss_state to ufv_collector;
 end if;
end $$;
