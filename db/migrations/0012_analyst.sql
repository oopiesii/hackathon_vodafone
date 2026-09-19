-- Постійний analyst відокремлено від правил і від разових analysis runs.
alter table core.sources add column llm_allowed boolean not null default false;
alter table core.sources add column llm_basis text;
alter table core.sources add constraint sources_llm_basis_required
 check(not llm_allowed or (llm_basis is not null and length(trim(llm_basis)) >= 10));
update core.sources s set llm_allowed=true,
 llm_basis='Дозволений RSS-анонс; нічне доручення 19.09.2026; підстава джерела: ' || coalesce(s.permission_note,'')
from core.rss_sources r where r.source_id=s.id and r.rights_status='allowed' and s.kind='rss';

create view core.analyst_items with (security_barrier=true) as
select i.id,i.source_id,s.workflow_id,i.source_item_id,i.parent_item_id,i.kind,
 i.text,i.version,i.published_at,i.fetched_at,i.content_scope,
 coalesce(r.decision,m.decision,'pending') rule_decision,m.category topic,m.brand
from raw.items i join core.sources s on s.id=i.source_id
join core.workflows w on w.id=s.workflow_id
left join core.rss_sources rs on rs.source_id=s.id
left join core.mentions m on m.raw_item_id=i.id and m.raw_version=i.version and not m.deleted
left join core.review_decisions r on r.mention_id=m.id and r.raw_version=i.version
where not i.deleted and s.enabled and w.enabled and s.llm_allowed
 and length(trim(s.llm_basis)) >= 10 and (s.kind<>'rss' or rs.rights_status='allowed');

create view core.analyst_rollups with (security_barrier=true) as
select d.* from core.daily_rollups d join core.sources s on s.id=d.source_id
join core.workflows w on w.id=s.workflow_id left join core.rss_sources r on r.source_id=s.id
where s.enabled and w.enabled and s.llm_allowed and length(trim(s.llm_basis))>=10
 and (s.kind<>'rss' or r.rights_status='allowed');

create table core.analyst_receipts (
 raw_item_id bigint primary key references raw.items(id),
 raw_version integer not null, parent_id bigint, parent_version integer,
 model text not null, prompt_version text not null,
 status text not null check(status in ('complete','error')),
 attempts integer not null default 1, error_code text,
 retry_at timestamptz not null default now(), analyzed_at timestamptz not null default now()
);
create table core.analyst_budget (
 hour timestamptz primary key, used integer not null check(used>=0)
);
create table core.analyst_state (
 singleton boolean primary key default true check(singleton),
 heartbeat_at timestamptz not null default now(),
 mode text not null check(mode in ('waiting_key','active','rate_limited','error')),
 model text, last_error text, limit_per_hour integer not null default 60,
 last_label_at timestamptz, last_summary_at timestamptz
);
create table core.ai_summaries (
 id bigint generated always as identity primary key,
 workflow_id bigint not null references core.workflows(id),
 "window" text not null check("window" in ('24h','7d','30d')),
 window_start timestamptz not null, window_end timestamptz not null,
 model text not null, mode text not null check(mode in ('ai','rules')),
 body jsonb not null, evidence_ids bigint[] not null default '{}',
 input_versions jsonb not null default '[]',
 source_ids bigint[] not null default '{}',
 generated_at timestamptz not null default now(),
 check(window_start<window_end)
);
create table core.analyst_summary_schedule (
 workflow_id bigint not null references core.workflows(id),
 "window" text not null check("window" in ('24h','7d','30d')),
 attempted_at timestamptz not null default now(),
 config_version text not null,
 primary key(workflow_id,"window")
);
create index ai_summaries_window on core.ai_summaries(workflow_id,"window",generated_at desc);
-- Withdrawn permissions, deletion or edit immediately hide the corresponding summary.
create view core.current_ai_summaries with (security_barrier=true) as
select a.* from core.ai_summaries a where not exists (
 select 1 from jsonb_array_elements(a.input_versions) v
 left join core.analyst_items i on i.id=(v->>'id')::bigint and i.workflow_id=a.workflow_id
 where i.id is null or i.version<>(v->>'version')::integer
) and not exists (
 select 1 from unnest(a.source_ids) sid
 left join core.sources s on s.id=sid
 left join core.rss_sources r on r.source_id=s.id
 where s.id is null or not s.enabled or not s.llm_allowed
  or (s.kind='rss' and r.rights_status is distinct from 'allowed')
);
-- Grant basis is retained in audit independently of subsequent source edits.
alter table core.audit add column detail jsonb not null default '{}';

do $$ begin
 if exists(select 1 from pg_roles where rolname='ufv_api') then
  grant select on core.analyst_state,core.analyst_budget,core.ai_summaries,core.current_ai_summaries to ufv_api;
 end if;
 if exists(select 1 from pg_roles where rolname='ufv_analyst') then
  grant usage on schema core to ufv_analyst;
  grant select on core.analyst_items,core.analyst_rollups,core.refresh_requests,core.analyst_receipts,core.analysis_runs,
   core.analyst_budget,core.analyst_state,core.ai_summaries,core.current_ai_summaries,core.analyst_summary_schedule to ufv_analyst;
  grant select(run_id,raw_item_id,raw_version) on core.analysis_labels to ufv_analyst;
  grant insert,update on core.analyst_receipts,core.analysis_runs,core.analysis_labels,
   core.analyst_budget,core.analyst_state,core.ai_summaries,core.analyst_summary_schedule to ufv_analyst;
  grant usage,select on sequence core.ai_summaries_id_seq to ufv_analyst;
 end if;
end $$;
