// Ізоляція кешу перевіряється локальним bundle та синтетичним HTTP, без БД/секретів.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { dashboard } from '../tests/fixtures/dashboard.mjs';
const require = createRequire('/opt/ufv/.codex/skills/design-check/');
const { chromium } = require('playwright-core');
const root = resolve('apps/web/dist'), out = resolve('artifacts/auth-cache');
await mkdir(out, { recursive: true });
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2' };
let signed = true, sessionId = 'first', role = 'admin', identity = 'admin', sessionRole = 'admin';
let privateDelay = false, meFailed = false, share = 'broad', adminRequests = 0;
let releasePrivate = () => {}, releaseViewer = () => {};
let pendingViewer = Promise.resolve(), pendingPrivate = Promise.resolve();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'), path = url.pathname;
  const user = { id: identity, email: `${identity}@example.test`, name: identity, role };
  if (path.startsWith('/api/')) {
    let data;
    if (path === '/api/auth/get-session') data = signed ? { session: { id: sessionId, userId: identity, expiresAt: '2099-01-01T00:00:00Z' }, user: { ...user, role: sessionRole } } : null;
    if (path === '/api/auth/sign-out') { signed = false; data = { success: true }; }
    if (path === '/api/auth/sign-in/email') {
      signed = true; sessionId = 'second'; role = sessionRole = identity = 'viewer';
      data = { redirect: false, token: 'synthetic-test', user: { ...user, id: identity, role } };
    }
    if (path === '/api/me') {
      if (meFailed) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"unavailable"}'); return; }
      data = { user, permissions: role === 'viewer' ? { incident: ['view'] } : { incident: ['view', 'edit'], collector: ['read', 'manage'], user: ['list'] } };
    }
    if (path === '/api/workflows') data = { items: [{ id: '1', name: 'Синтетичний напрям' }] };
    if (path === '/api/admin/refresh') data = { requests: [] };
    if (path === '/api/dashboard') {
      if (role === 'viewer') {
        await pendingViewer;
        res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"unavailable"}'); return;
      }
      adminRequests++;
      if (privateDelay) await pendingPrivate;
      data = structuredClone(dashboard); data.ai.summary = 'PRIVATE_ADMIN_REVIEW_MARKER';
    }
    if (path === '/api/shared/redeem') {
      let body = ''; for await (const chunk of req) body += chunk;
      share = JSON.parse(body).token === 'synthetic-narrow' ? 'narrow' : 'broad'; data = { success: true, scope_id: share };
    }
    if (path === '/api/shared/me') {
      if (share === 'invalid') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"invalid_or_expired_link"}'); return; }
      data = { name: 'Синтетичне посилання', scope: 'full', workflow_id: '1', scope_id: share };
    }
    if (path === '/api/shared/feed') {
      if (share === 'narrow') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"unavailable"}'); return; }
      data = { items: [{ id: '1', source_kind: 'telegram', kind: 'post', text: 'SHARED_BROAD_PRIVATE_MARKER', summary: '', source_url: 'https://example.test/evidence', published_at: dashboard.end, channel_title: 'Тест' }], total: { count: 1, last_processed_at: dashboard.end }, kinds: [{ kind: 'post', count: 1 }], topics: [], next_before: null, summary_only: false, telegram_enabled: true };
    }
    res.writeHead(data === undefined ? 404 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data ?? null)); return;
  }
  try { const file = extname(path) ? join(root, path) : join(root, 'index.html'); const body = await readFile(file); res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
}).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const base = `http://127.0.0.1:${server.address().port}`;
const checks = [], errors = [];
function monitor(page) { page.on('pageerror', error => errors.push(error.message)); }
async function noPrivate(page) {
  assert.equal(await page.getByText('PRIVATE_ADMIN_REVIEW_MARKER').count(), 0);
  assert.equal(await page.getByText('Відсіяний шум', { exact: true }).count(), 0);
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); monitor(page);
  await page.goto(base); await page.getByText('PRIVATE_ADMIN_REVIEW_MARKER').waitFor();
  // A request from the retired administrator must remain isolated even if it
  // finishes after the viewer's replacement request has failed.
  privateDelay = true; pendingPrivate = new Promise(resolve => { releasePrivate = resolve; });
  const previous = adminRequests;
  await page.getByRole('button', { name: /^Оновити (зараз|дані)$/ }).click();
  await page.waitForFunction(() => document.querySelector('.dashboard-data')?.getAttribute('aria-busy') === 'true');
  assert.ok(adminRequests > previous);
  await page.getByRole('button', { name: 'Вийти', exact: true }).click();
  await page.getByRole('button', { name: 'Увійти', exact: true }).waitFor();
  pendingViewer = new Promise(resolve => { releaseViewer = resolve; });
  await page.getByLabel('Пошта', { exact: true }).fill('viewer@example.test');
  await page.getByLabel('Пароль', { exact: true }).fill('synthetic-password');
  const viewerRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/dashboard');
  await page.getByRole('button', { name: 'Увійти', exact: true }).click();
  await viewerRequest;
  await page.getByText('Збираємо показники з дозволених матеріалів…').waitFor();
  await noPrivate(page); checks.push('admin → logout → viewer: delayed response has no administrator cache');
  releaseViewer(); await page.getByText('Не вдалося оновити дашборд.', { exact: false }).waitFor();
  await noPrivate(page); checks.push('viewer failed GET has no administrator cache');
  releasePrivate(); privateDelay = false; await page.waitForTimeout(100);
  await noPrivate(page); checks.push('late retired request cannot repopulate viewer cache');
  await page.screenshot({ path: join(out, 'viewer-failed.png'), fullPage: true });
  await page.close();

  // /me may change permissions without changing the Better Auth session or id.
  signed = true; sessionId = 'same-session'; role = sessionRole = identity = 'admin';
  const downgraded = await browser.newPage(); monitor(downgraded);
  await downgraded.clock.install(); await downgraded.goto(base); await downgraded.getByText('PRIVATE_ADMIN_REVIEW_MARKER').waitFor();
  role = 'viewer'; await downgraded.clock.fastForward(61000);
  await downgraded.getByText('Не вдалося оновити дашборд.', { exact: false }).waitFor();
  await noPrivate(downgraded); checks.push('same session permission downgrade gets a new data cache');
  meFailed = true; await downgraded.clock.fastForward(61000);
  await downgraded.getByText('Не вдалося підтвердити права доступу.', { exact: false }).waitFor();
  await noPrivate(downgraded);
  await downgraded.setViewportSize({ width: 390, height: 844 });
  assert.equal(await downgraded.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await downgraded.screenshot({ path: join(out, 'permission-error-mobile.png'), fullPage: true });
  checks.push('failed permission refresh unmounts private data');
  await downgraded.close(); meFailed = false;

  // Native hash navigation is the same document: a global client / once-only
  // share component would otherwise retain the previous broader feed.
  const publicPage = await browser.newPage(); monitor(publicPage);
  await publicPage.goto(base + '/view#synthetic-broad'); await publicPage.getByText('SHARED_BROAD_PRIVATE_MARKER').waitFor();
  const previousTimeOrigin = await publicPage.evaluate(() => performance.timeOrigin);
  await publicPage.goto(base + '/view#synthetic-narrow');
  await publicPage.getByText('Не вдалося виконати запит. (503)', { exact: true }).waitFor();
  assert.equal(await publicPage.evaluate(() => performance.timeOrigin), previousTimeOrigin);
  assert.equal(share, 'narrow'); assert.equal(await publicPage.getByText('SHARED_BROAD_PRIVATE_MARKER').count(), 0);
  checks.push('same-document share change does not inherit broad-link data');
  await publicPage.screenshot({ path: join(out, 'shared-narrow-failed.png'), fullPage: true });
  await publicPage.close();
  share = 'invalid';
  const invalidPage = await browser.newPage({ viewport: { width: 390, height: 844 } }); monitor(invalidPage);
  await invalidPage.goto(base + '/view');
  const invalid = invalidPage.getByText('Посилання недійсне, відкликане або його строк минув.', { exact: true });
  await invalid.waitFor(); assert.equal(await invalid.count(), 1);
  assert.equal(await invalidPage.getByText('Посилання недійсне або відкликане.', { exact: false }).count(), 0);
  assert.equal(await invalidPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await invalidPage.screenshot({ path: join(out, 'shared-invalid-mobile.png'), fullPage: true });
  checks.push('invalid shared link reports one error without duplicate wording');
  await invalidPage.close();
  assert.deepEqual(errors, []);
  for (const check of checks) console.log('PASS ' + check);
} finally { releaseViewer(); releasePrivate(); await browser.close(); server.close(); }
