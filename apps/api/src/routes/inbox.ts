import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireSession, requirePermission, type AppEnv } from '../auth/middleware.js';
import { query } from './telegram-admin.js';
import { dashboardFilters } from '../lib/dashboard-filters.js';
import { telegramDetail } from '../lib/telegram-detail.js';

const states = ['pending', 'accepted', 'review', 'rejected', 'deleted'];
const fields = `id,source_id,workflow_id,account_id,external_id,channel_title,workflow_name,
  account_label,kind,text,url,published_at,fetched_at,edited_at,last_seen_at,version,
  deleted,mention_id,analyzed_at,state,reason,topic,source_kind,title,content_scope`;

export const inbox = new Hono<AppEnv>()
  .use(requireSession)
  .use(requirePermission({ incident: ['edit'] }));

inbox.get('/', async c => {
  const params = c.req.query();
  const args: unknown[] = [];
  const filters: string[] = [];
  const add = (value: unknown) => { args.push(value); return '$' + args.length; };
  for (const field of ['workflow_id', 'source_id']) {
    if (params[field] && params[field] !== 'all') {
      if (!/^\d+$/.test(params[field]!)) throw new HTTPException(400);
      filters.push(field + '=' + add(params[field]));
    }
  }
  if (params.q) filters.push('text ilike ' + add('%' + params.q.slice(0, 200) + '%'));
  if (params.kind) {
    if (!['post', 'comment','group_message'].includes(params.kind)) throw new HTTPException(400);
    filters.push('kind=' + add(params.kind));
  }
  const drilldownParams={...params};delete drilldownParams.source_id;delete drilldownParams.window;
  const extra=dashboardFilters(drilldownParams,add);
  if(extra.length)filters.push('id in (select d.raw_item_id from core.dashboard_items d where '+extra.join(' and ')+')');
  const base = ' from core.incoming_items' + (filters.length ? ' where ' + filters.join(' and ') : ' where true');
  const counts = await query('select state,count(*)::int count' + base + ' group by state', args);
  let selected = base;
  if (params.state && params.state !== 'all') {
    if (!states.includes(params.state)) throw new HTTPException(400);
    selected += ' and state=' + add(params.state);
  }
  if (params.before) {
    if (!/^\d+$/.test(params.before)) throw new HTTPException(400);
    selected += ' and id<' + add(params.before);
  }
  const items = await query('select ' + fields + selected + ' order by id desc limit 51', args);
  const sources = await query('select id,workflow_id,external_id,kind,title from core.sources order by external_id');
  return c.json({ items: items.slice(0, 50), counts, sources, next_before: items.length > 50 ? items[49].id : null });
});

inbox.get('/:id', async c => {
  if (!/^\d+$/.test(c.req.param('id'))) throw new HTTPException(400);
  const rows = await query('select * from core.incoming_items where id=$1', [c.req.param('id')]);
  if (!rows.length) throw new HTTPException(404);
  const item = rows[0];
  const parent = item.parent_item_id ? await query(
    'select ' + fields + ' from core.incoming_items where source_id=$1 and source_item_id=$2 and not deleted',
    [item.source_id, item.parent_item_id],
  ) : [];
  return c.json({ item, parent: parent[0] || null, telegram:item.source_kind==='telegram'?await telegramDetail(item.id):null });
});
