-- Existing materials must acquire the same lifecycle as newly collected ones.
insert into raw.watch_state(item_id,last_activity_at)
 select id,fetched_at from raw.items where kind in ('post','group_message') and not deleted
 on conflict(item_id) do nothing;
-- Rule/context changes invalidate old processor receipts without duplicating items.
update core.workflows set processor_revision=processor_revision+1;

create index raw_thread_members on raw.items(source_id,thread_item_id) where not deleted;
create index raw_reply_parent on raw.items(source_id,parent_item_id) where not deleted;
create or replace view core.telegram_watches as
 select w.*,i.source_id,i.kind,i.published_at,i.url,i.deleted,s.workflow_id,s.external_id,
 coalesce(o.mode,'auto') override_mode,coalesce(o.reason,'') override_reason,
 (select count(*)::int from raw.items r where r.source_id=i.source_id and r.id<>i.id
   and (r.thread_item_id=i.source_item_id or r.parent_item_id=i.source_item_id)
   and r.kind in ('comment','group_message') and not r.deleted) collected_replies
 from raw.watch_state w join raw.items i on i.id=w.item_id join core.sources s on s.id=i.source_id
 left join core.telegram_watch_overrides o on o.item_id=i.id;
