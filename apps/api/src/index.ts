import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { closeDb } from "./db/pool.js";
import { env } from "./env.js";
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { fileURLToPath } from 'node:url';

const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";
// /showcase — один самодостатній HTML (стилі, скрипт і шрифт вбудовано), тому inline дозволено лише там.
// Натомість сторінці заборонено будь-які мережеві запити: вона не може звернутися до /api навіть із cookie сесії.
const SHOWCASE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const isShowcase = (path: string) => path === '/showcase' || path.startsWith('/showcase/');

const serverApp = new Hono();
serverApp.use(async(c,next)=>{
  c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');
  c.header('X-Robots-Tag','noindex, nofollow');
  c.header('Content-Security-Policy',isShowcase(c.req.path)?SHOWCASE_CSP:APP_CSP);
  await next();
});
serverApp.route('/',app);
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
serverApp.use('*',serveStatic({root:webRoot}));
serverApp.get('*',serveStatic({root:webRoot,path:'index.html'}));

const server = serve({ fetch: serverApp.fetch, hostname: env.HOST, port: env.PORT }, (info) => {
  console.log(`api: http://${info.address}:${info.port}/api (public origin ${env.PUBLIC_URL})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
  });
}
