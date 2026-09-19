-- Narrow, version-aware dashboard data. Raw storage and author identities are not exposed.
create table core.action_status (
 mention_id bigint primary key references core.mentions(id) on delete cascade,
 status text not null check(status in ('none','investigating','responding','resolved')),
 updated_by text not null, updated_at timestamptz not null default now()
);
create table core.refresh_requests (
 id bigint generated always as identity primary key,
 workflow_id bigint not null references core.workflows(id) on delete cascade,
 service text not null check(service in ('telegram','rss')),
 status text not null default 'pending' check(status in ('pending','running','completed','deferred','disabled','failed')),
 requested_by text not null, requested_at timestamptz not null default now(),
 started_at timestamptz, completed_at timestamptz, detail text not null default '',
 target_ids bigint[] not null default '{}'
);
create unique index refresh_one_pending on core.refresh_requests(workflow_id,service) where status in ('pending','running');

create view core.dashboard_items as
select i.id raw_item_id,m.id,s.id source_id,s.workflow_id,s.kind source_kind,
 coalesce(s.title,s.external_id) source_title,i.kind,i.url,i.published_at,i.fetched_at,m.analyzed_at,
 coalesce(i.published_at,i.fetched_at) event_at,i.content_hash,i.canonical_item_id,
 m.quote,m.category topic,m.brand,
 case when i.deleted or m.deleted then 'deleted'
      when m.id is null or m.raw_version<>i.version then 'pending'
      -- Human decisions for this exact version survive the deliberate workflow reprocess.
      when r.decision is not null then r.decision
      when p.raw_item_id is null or p.version<>i.version or p.processor_revision<>w.processor_revision then 'pending'
      else m.decision end decision,
 (m.quote ~* '(не працю|не работа|збій|сбой|зник.{0,16}(зв|інтернет|интернет)|немає.{0,16}(зв|інтернет)|нема.{0,16}(зв|інтернет)|відсутн.{0,16}(зв|інтернет)|скарг|жалоб|обур|возмущ|поган|плох|шахрай|мошенн|списал|списан|подорожч|подорожан|outage|network down)') negative,
 (m.quote ~* '(не працю|не работа|збій|сбой|зник.{0,16}(зв|інтернет|интернет)|немає.{0,16}(зв|інтернет)|нема.{0,16}(зв|інтернет)|відсутн.{0,16}(зв|інтернет)|outage|network down)') outage,
 coalesce(a.status,'none') action,
 ms.views,ms.forwards,ms.replies,ms.reactions,ms.observed_at metrics_observed_at,
 case when i.published_at is not null and i.fetched_at>=i.published_at
      then extract(epoch from i.fetched_at-i.published_at)::double precision end lag_seconds,
 case when i.kind<>'comment' then true else exists(
   select 1 from raw.items parent join raw.watch_state watch on watch.item_id=parent.id
   where parent.source_id=i.source_id and parent.source_item_id=i.thread_item_id
    and watch.state in ('active','cooling','sleeping','blocked') and not parent.deleted
 ) end watch_active
from raw.items i join core.sources s on s.id=i.source_id join core.workflows w on w.id=s.workflow_id
left join core.mentions m on m.raw_item_id=i.id
left join core.processing_receipts p on p.raw_item_id=i.id
left join core.review_decisions r on r.mention_id=m.id and r.raw_version=i.version
left join core.action_status a on a.mention_id=m.id
left join lateral (select views,forwards,replies,reactions,observed_at from raw.metric_snapshots
 where item_id=i.id order by observed_at desc,id desc limit 1) ms on true;

-- No text, URLs or author data in monthly aggregates. Exact latency samples retain
-- the true median; a median of daily medians would be mathematically incorrect.
create table core.daily_rollups (
 day date not null,workflow_id bigint not null references core.workflows(id) on delete cascade,
 source_id bigint not null references core.sources(id) on delete cascade,source_kind text not null,
 topic text not null,brand text not null,decision text not null,
 count integer not null,negative_count integer not null,negative_reach bigint not null,
 views_measured integer not null,reaction_negative bigint not null,reaction_ironic bigint not null,
 reaction_sad bigint not null,reaction_positive bigint not null,reactions_measured integer not null,
 lag_samples double precision[] not null,complaints integer not null,
 generated_at timestamptz not null default now(),
 primary key(day,workflow_id,source_id,topic,brand,decision)
);

create function core.refresh_dashboard_rollups() returns void language plpgsql security definer
set search_path=pg_catalog,core as $$
begin
 if not pg_try_advisory_xact_lock(727115) then return; end if;
 delete from core.daily_rollups;
 insert into core.daily_rollups(day,workflow_id,source_id,source_kind,topic,brand,decision,count,negative_count,
 negative_reach,views_measured,reaction_negative,reaction_ironic,reaction_sad,reaction_positive,reactions_measured,lag_samples,complaints)
 select (event_at at time zone 'Europe/Kyiv')::date,workflow_id,source_id,source_kind,coalesce(topic,'other'),coalesce(brand,'telecom'),decision,
 count(*)::int,count(*) filter(where negative)::int,
 coalesce(sum(views) filter(where negative and decision='accepted'),0)::bigint,
 count(views) filter(where negative and decision='accepted')::int,
 coalesce(sum(rx.neg),0),coalesce(sum(rx.ironic),0),coalesce(sum(rx.sad),0),coalesce(sum(rx.pos),0),
 count(reactions)::int,coalesce(array_agg(lag_seconds) filter(where lag_seconds is not null),'{}'),
 count(*) filter(where negative and kind='comment' and watch_active)::int
 from core.dashboard_items d
 left join lateral (
  select sum(value::bigint) filter(where key=any(array['👎','😡','🤬','🤮','💩','🤡'])) neg,
   sum(value::bigint) filter(where key=any(array['🤣','😁','😈'])) ironic,
   sum(value::bigint) filter(where key=any(array['😢','💔','😭'])) sad,
   sum(value::bigint) filter(where not(key=any(array['👎','😡','🤬','🤮','💩','🤡','🤣','😁','😈','😢','💔','😭']))) pos
  from jsonb_each_text(case when jsonb_typeof(d.reactions)='object' then d.reactions else '{}'::jsonb end) where value ~ '^\d+$'
 ) rx on true
 where event_at>=((now() at time zone 'Europe/Kyiv')::date-29)::timestamp at time zone 'Europe/Kyiv'
 and event_at<=now() and decision<>'deleted'
 and (kind<>'comment' or (watch_active and event_at>=now()-interval '7 days'))
 group by 1,2,3,4,5,6,7;
end $$;
revoke all on function core.refresh_dashboard_rollups() from public;
select core.refresh_dashboard_rollups();

do $$ begin
 if exists(select 1 from pg_roles where rolname='ufv_api') then
  grant select on core.dashboard_items,core.daily_rollups,core.action_status,core.refresh_requests to ufv_api;
  grant insert,update on core.action_status,core.refresh_requests to ufv_api;
  grant usage,select on sequence core.refresh_requests_id_seq to ufv_api;
 end if;
 if exists(select 1 from pg_roles where rolname='ufv_collector') then
  grant select,update on core.refresh_requests to ufv_collector;
 end if;
 if exists(select 1 from pg_roles where rolname='ufv_processor') then
  grant execute on function core.refresh_dashboard_rollups() to ufv_processor;
 end if;
end $$;
