import { Hono } from 'hono';
import { requireSession, type AppEnv } from '../auth/middleware.js';
import { cache, cached, networkContext, regionsContext, reviewsContext } from '../lib/context-sources.js';

// Контекстні сигнали для дашборда: зовнішня зв'язність мереж операторів і відгуки App Store.
// Дані читаються наживо з кешем у пам'яті (див. lib/context-sources.ts); недоступність джерела повертає available:false, а не помилку.
export const context = new Hono<AppEnv>().use(requireSession);
context.get('/network', async (c) => {
  const window = c.req.query('window') === '7d' ? '7d' : '24h';
  try { const data = await cached(`network:${window}`, 5 * 60_000, () => networkContext(window)); return c.json({ available: true, fetched_at: new Date(cache.get(`network:${window}`)!.at).toISOString(), ...data }); }
  catch { return c.json({ available: false, reason: 'Зовнішнє джерело вимірювань зараз недоступне з сервера.' }); }
});
context.get('/reviews', async (c) => {
  try { const data = await cached('reviews', 30 * 60_000, reviewsContext); return c.json({ available: true, fetched_at: new Date(cache.get('reviews')!.at).toISOString(), ...data }); }
  catch { return c.json({ available: false, reason: 'Фід відгуків App Store зараз недоступний з сервера.' }); }
});
context.get('/regions', async (c) => {
  try { const data = await cached('regions', 10 * 60_000, regionsContext); return c.json({ available: true, fetched_at: new Date(cache.get('regions')!.at).toISOString(), ...data }); }
  catch { return c.json({ available: false, reason: 'Зовнішнє джерело вимірювань зараз недоступне з сервера.' }); }
});
