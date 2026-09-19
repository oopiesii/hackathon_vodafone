import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from 'hono/body-limit';
import { auth } from "./auth/auth.js";
import { env } from "./env.js";
import { rssAdmin } from './routes/rss-admin.js';
import { collectors } from "./routes/collectors.js";
import { feed, documents } from "./routes/feed.js";
import { telegramAdmin } from './routes/telegram-admin.js';
import { telegramControl } from './routes/telegram-control.js';
import { shared } from './routes/shared.js';
import { inbox } from './routes/inbox.js';
import { requireSession } from './auth/middleware.js';
import { query } from './routes/telegram-admin.js';
import { health } from "./routes/health.js";
import { me } from "./routes/me.js";
import { analysis } from './routes/analysis.js';
import { aiAdmin } from './routes/ai-admin.js';

// CORS навмисно немає: браузер завжди ходить на той самий origin (Vite-проксі в dev, reverse proxy в проді).
export const app = new Hono().basePath("/api");

app.use(logger());
app.use(secureHeaders());
app.use(bodyLimit({maxSize:65536}));
app.use(async(c,next)=>{
  if(!['GET','HEAD','OPTIONS'].includes(c.req.method)){
    const origin=c.req.header('origin');
    if((origin && origin!==env.PUBLIC_URL)||c.req.header('sec-fetch-site')==='cross-site')return c.json({error:'forbidden_origin'},403);
  }
  c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');await next();
});
app.use(csrf({ origin: env.PUBLIC_URL }));

app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));
app.route("/health", health);
app.route("/me", me);
app.route("/feed", feed);
app.route("/collectors", collectors);
app.route("/admin/rss", rssAdmin);
app.route('/admin',telegramAdmin);
app.route('/admin/telegram',telegramControl);
app.route('/documents',documents);
app.route('/shared',shared);
app.route('/inbox',inbox);
app.route('/analysis',analysis);
app.route('/admin/ai',aiAdmin);
app.get('/workflows',requireSession,async c=>c.json({items:await query('select id,name from core.workflows order by id')}));

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  // Відмови middleware (напр. csrf → 403) — не збій сервера.
  if (err instanceof HTTPException) return c.json({ error: err.status === 403 ? "forbidden" : err.message }, err.status);
  if('code' in err && ['23503','23505'].includes(String(err.code)))return c.json({error:'duplicate_or_linked_record'},409);
  console.error('API error',err.name);
  return c.json({ error: "internal" }, 500);
});
