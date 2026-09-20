import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireSession, requirePermission, type AppEnv } from '../auth/middleware.js';
import { askAnalyst, cachedWebMentions, runtimeStatus, searchWebMentions, setRuntime, RuntimeError } from '../lib/runtime-bridge.js';
import { query } from './telegram-admin.js';

// Перемикач локального рантайму Claude Code (лише демо) і чат аналітика поверх нього.
const toggle = z.object({ enabled: z.boolean() }).strict();
const ask = z.object({
  question: z.string().trim().min(2).max(500),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(1500) }).strict()).max(8).default([]),
  facts: z.object({ headline: z.string().max(400), window: z.string().max(40), facts: z.array(z.string().max(400)).max(20), advice: z.array(z.string().max(500)).max(10) }).strict(),
}).strict();

export const runtimeAdmin = new Hono<AppEnv>().use('*', requireSession, requirePermission({ collector: ['manage'] }))
  .get('/', async (c) => c.json(await runtimeStatus()))
  .post('/', async (c) => {
    const body = toggle.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new HTTPException(422, { message: 'Потрібне поле enabled.' });
    try {
      const status = await setRuntime(body.data.enabled);
      await query("insert into core.audit(actor_id,action,object_type) values($1,$2,'llm_runtime')", [c.get('user').id, body.data.enabled ? 'local_runtime_enabled' : 'local_runtime_disabled']);
      return c.json(status);
    } catch (error) {
      const code = error instanceof RuntimeError ? error.code : 'runtime_unreachable';
      throw new HTTPException(code === 'not_configured' ? 409 : 502, { message: code === 'not_configured' ? 'Місток локального рантайму не налаштовано на сервері.' : 'Місток локального рантайму не відповідає.' });
    }
  });

export const analystChat = new Hono<AppEnv>().use('*', requireSession)
  .get('/runtime', async (c) => { const s = await runtimeStatus(); return c.json({ enabled: s.enabled && s.reachable, model: s.model ?? null }); })
  .post('/ask', async (c) => {
    const body = ask.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new HTTPException(422, { message: 'Некоректне питання.' });
    try { return c.json(await askAnalyst(body.data.question, body.data.history, body.data.facts)); }
    catch (error) {
      const code = error instanceof RuntimeError ? error.code : 'runtime_failed';
      return c.json({ error: code }, code === 'runtime_disabled' || code === 'not_configured' ? 409 : 502);
    }
  });

// Свіжі згадки з інтернету: GET віддає останній результат із пам'яті процесу, POST запускає новий пошук (до ~90 с).
analystChat.get('/web-mentions', requirePermission({ incident: ['edit'] }), (c) => c.json(cachedWebMentions()));
analystChat.post('/web-mentions', requirePermission({ incident: ['edit'] }), async (c) => {
  try { return c.json({ result: await searchWebMentions(), searching: false }); }
  catch (error) {
    const code = error instanceof RuntimeError ? error.code : 'runtime_failed';
    return c.json({ error: code }, code === 'runtime_disabled' || code === 'not_configured' ? 409 : 502);
  }
});
