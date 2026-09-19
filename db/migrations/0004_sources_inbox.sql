-- Prepared account slots are configuration, not authorized Telegram sessions.
alter table core.telegram_accounts alter column api_id drop not null;
alter table core.telegram_accounts alter column api_hash drop not null;
alter table core.telegram_accounts alter column session drop not null;
alter table core.telegram_accounts alter column session_fingerprint drop not null;
alter table core.telegram_accounts add constraint telegram_credentials_complete check (
 (api_id is null and api_hash is null and session is null and session_fingerprint is null and not enabled)
 or (api_id is not null and api_hash is not null and session is not null and session_fingerprint is not null)
);

-- Narrow read model for an authorized operator's incoming dashboard.
-- The API can select the view; it still has no direct access to raw.items.
create view core.incoming_items as
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
 m.category topic
from raw.items i
join core.sources s on s.id=i.source_id
join core.workflows w on w.id=s.workflow_id
left join core.telegram_accounts a on a.id=s.account_id
left join core.mentions m on m.raw_item_id=i.id
left join core.processing_receipts p on p.raw_item_id=i.id
left join core.review_decisions r on r.mention_id=m.id and r.raw_version=i.version;
