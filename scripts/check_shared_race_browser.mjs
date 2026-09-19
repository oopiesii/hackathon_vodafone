// Real browser cookies + deliberately reordered synthetic redeem responses.
// No database, external request, real link, or secret is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
const { chromium } = createRequire('/opt/ufv/.codex/skills/design-check/')('playwright-core');
const root = resolve('apps/web/dist'), out = resolve('artifacts/auth-cache');
await mkdir(out, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
let releaseBroad, receivedBroad;
const broadPending = new Promise(resolve => { releaseBroad = resolve; });
const broadStarted = new Promise(resolve => { receivedBroad = resolve; });
const observed = [], errors = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'), path = url.pathname;
  if (path.startsWith('/api/')) {
    let data;
    const cookie = req.headers.cookie || '';
    const scope = cookie.includes('ufv_share=narrow') ? 'narrow' : cookie.includes('ufv_share=broad') ? 'broad' : 'none';
    const expected = req.headers['x-ufv-share-scope'];
    if (path === '/api/shared/redeem') {
      let body = ''; for await (const chunk of req) body += chunk;
      const target = JSON.parse(body).token;
      if (target === 'broad') { receivedBroad(); await broadPending; }
      res.setHeader('Set-Cookie', `ufv_share=${target}; HttpOnly; SameSite=Strict; Path=/`);
      data = { ok: true, scope_id: target };
    } else if (path.startsWith('/api/shared/')) {
      observed.push({ path, scope, expected, query: url.search });
      if ((expected !== undefined || !path.endsWith('/me')) && expected !== scope) {
        res.writeHead(409, { 'content-type': 'application/json' }); res.end('{"error":"share_scope_changed"}'); return;
      }
      if (path === '/api/shared/me') data = { name: 'Синтетичне посилання', scope: 'full', workflow_id: '1', scope_id: scope };
      if (path === '/api/shared/feed') data = {
        items: [{ id: '1', source_kind: 'telegram', kind: 'post', text: scope === 'broad' ? 'BROAD_SECRET_MARKER' : 'NARROW_MARKER', summary: '', source_url: 'https://example.test', published_at: '2026-09-19T00:00:00Z', channel_title: 'Synthetic' }],
        total: { count: 1, last_processed_at: null }, kinds: [{ kind: 'post', count: 1 }], topics: [], next_before: null, summary_only: false, telegram_enabled: true,
      };
    }
    res.writeHead(data ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(data || { error: 'not_found' })); return;
  }
  try { const file = extname(path) ? join(root, path) : join(root, 'index.html'); const body = await readFile(file); res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
}).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const warning = 'Доступ за посиланням змінився. Відкрийте потрібне посилання знову.';
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/view#broad'); await broadStarted;
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  await page.goto(base + '/view#narrow'); await page.getByText('NARROW_MARKER', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
  assert.ok(observed.some(request => request.path.endsWith('/me') && request.scope === 'narrow' && request.expected === 'narrow'));
  const stale = page.waitForResponse(response => response.url().endsWith('/shared/redeem') && response.request().postDataJSON().token === 'broad');
  releaseBroad(); await stale;
  await page.getByRole('button', { name: 'Оновити', exact: true }).click();
  await page.getByText(warning, { exact: true }).waitFor();
  assert.equal(await page.getByText('BROAD_SECRET_MARKER', { exact: true }).count(), 0);
  assert.ok(observed.some(request => request.path.endsWith('/feed') && request.scope === 'broad' && request.expected === 'narrow'));
  await page.screenshot({ path: join(out, 'shared-race-blocked.png'), fullPage: true });
  console.log('PASS late broad Set-Cookie cannot broaden a narrow feed');
  await page.getByRole('button', { name: 'Контекст і доказ', exact: true }).click();
  assert.ok(observed.some(request => request.path.includes('/documents/') && request.scope === 'broad' && request.expected === 'narrow'));
  console.log('PASS evidence request preserves the redeemed scope');
  const meCount = observed.filter(request => request.path.endsWith('/me')).length;
  const filterResponse = page.waitForResponse(response => response.url().includes('/shared/feed?') && new URL(response.url()).searchParams.get('q') === 'Vodafone');
  await page.getByPlaceholder('Vodafone, збій, інтернет…').fill('Vodafone');
  assert.equal((await filterResponse).status(), 409);
  assert.equal(observed.filter(request => request.path.endsWith('/me')).length, meCount);
  assert.equal(await page.getByText('BROAD_SECRET_MARKER', { exact: true }).count(), 0);
  assert.ok(observed.some(request => request.query.includes('q=Vodafone') && request.expected === 'narrow'));
  console.log('PASS query navigation keeps the original narrow binding without unbound /me');
  // Opening the intended link again deliberately re-establishes its cookie.
  await page.goto(base + '/view#narrow'); await page.getByText('NARROW_MARKER', { exact: true }).waitFor();
  assert.equal(await page.getByText('BROAD_SECRET_MARKER', { exact: true }).count(), 0);
  assert.equal(await page.getByText(warning, { exact: true }).count(), 0);
  console.log('PASS reopening the same link restores its intended scope');
  await page.screenshot({ path: join(out, 'shared-race-recovered.png'), fullPage: true });
  assert.deepEqual(errors, []);
} finally { releaseBroad(); await browser.close(); server.close(); }
