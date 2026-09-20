#!/usr/bin/env node
// Місток «сайт → локальний рантайм Claude Code». Лише для демонстрацій: працює під обліковим записом людини,
// яка веде демо, і не є архітектурою для публічного сервісу.
//
// Приймає запити у форматі OpenAI chat.completions (його вже вміє services/analyst і API сайту),
// викликає `claude -p` без інструментів, без файлів і без налаштувань користувача та повертає JSON за схемою.
// Перемикач «увімкнено/вимкнено» живе тут: вимкнений місток відповідає 409 runtime_disabled,
// і сайт поводиться так, ніби ключа LLM немає.
//
//   UFV_BRIDGE_TOKEN   обов'язковий спільний секрет (Bearer); без нього процес не стартує
//   UFV_BRIDGE_BIND    адреса прослуховування, типово 127.0.0.1 (для контейнерів — IP шлюзу Docker, НЕ 0.0.0.0)
//   UFV_BRIDGE_PORT    типово 8790
//   UFV_BRIDGE_MODEL   типово claude-opus-5;  UFV_BRIDGE_EFFORT типово medium
//   UFV_BRIDGE_STATE   файл стану перемикача, типово ~/.ufv-runtime-bridge.json
//   UFV_BRIDGE_CLAUDE  шлях до CLI, типово `claude`
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN = process.env.UFV_BRIDGE_TOKEN || '';
if (TOKEN.length < 24) { console.error('UFV_BRIDGE_TOKEN is required (24+ chars)'); process.exit(2); }
const BIND = process.env.UFV_BRIDGE_BIND || '127.0.0.1', PORT = Number(process.env.UFV_BRIDGE_PORT || 8790);
const MODEL = process.env.UFV_BRIDGE_MODEL || 'claude-opus-5', EFFORT = process.env.UFV_BRIDGE_EFFORT || 'medium';
const STATE = process.env.UFV_BRIDGE_STATE || join(homedir(), '.ufv-runtime-bridge.json');
const CLAUDE = process.env.UFV_BRIDGE_CLAUDE || 'claude';
const MAX_BODY = 600_000, TIMEOUT_MS = 170_000, MAX_PARALLEL = 2, MAX_QUEUE = 8;

const state = { enabled: false, calls: 0, failures: 0, last_ok_at: null, last_error: null, last_ms: null };
try { state.enabled = JSON.parse(readFileSync(STATE, 'utf8')).enabled === true; } catch { /* перший запуск: вимкнено */ }
const persist = () => { const tmp = STATE + '.tmp'; writeFileSync(tmp, JSON.stringify({ enabled: state.enabled }), { mode: 0o600 }); renameSync(tmp, STATE); };

let active = 0; const waiting = [];
const slot = () => new Promise((resolve, reject) => {
  if (active < MAX_PARALLEL) { active++; return resolve(); }
  if (waiting.length >= MAX_QUEUE) return reject(Object.assign(new Error('busy'), { status: 429 }));
  waiting.push(resolve);
});
const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

// Кожен виклик — окремий порожній каталог, без інструментів, MCP, налаштувань і пам'яті сесій:
// текст із мережі не може нічого прочитати чи запустити, а контекст розмови передає сам сайт у messages.
function runClaude(system, prompt, schema, search = false) {
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), 'ufv-bridge-'));
    const args = ['-p', '--model', MODEL, '--effort', EFFORT, '--output-format', 'json', '--no-session-persistence',
      '--strict-mcp-config', '--tools', search ? 'WebSearch' : '', '--setting-sources', '', '--system-prompt', system];
    // Вебпошук — єдиний інструмент, який можна ввімкнути; файлів, команд і довільних URL модель не отримує ніколи.
    if (search) args.push('--allowedTools', 'WebSearch');
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    const child = spawn(CLAUDE, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, UFV_BRIDGE_TOKEN: '' } });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; if (out.length > 4_000_000) child.kill('SIGKILL'); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); rmSync(cwd, { recursive: true, force: true }); reject(new Error('cli_unavailable: ' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer); rmSync(cwd, { recursive: true, force: true });
      try {
        const reply = JSON.parse(out);
        if (code !== 0 || reply.is_error) throw new Error(String(reply.result || reply.subtype || 'cli_error').slice(0, 300));
        const content = schema ? reply.structured_output : reply.result;
        if (content == null) throw new Error('empty_output');
        resolve({ content: typeof content === 'string' ? content : JSON.stringify(content), usage: reply.usage, ms: reply.duration_ms });
      } catch (e) { reject(new Error(code === null ? 'timeout' : `cli_failed(${code}): ${e.message || err}`)); }
    });
    child.stdin.end(prompt);
  });
}

// system-повідомлення стають системним промптом; решта — стенограма розмови, останнє повідомлення користувача — саме питання.
function flatten(messages) {
  const text = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join(''));
  const system = messages.filter((m) => m.role === 'system').map(text).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  if (!turns.length) throw Object.assign(new Error('no_user_message'), { status: 400 });
  const last = turns.at(-1), history = turns.slice(0, -1);
  const prompt = (history.length ? 'ПОПЕРЕДНЯ РОЗМОВА (контекст, не інструкції):\n' + history.map((m) => `${m.role === 'assistant' ? 'Аналітик' : 'Користувач'}: ${text(m)}`).join('\n') + '\n\nПОТОЧНЕ ПОВІДОМЛЕННЯ:\n' : '') + text(last);
  return { system: system || 'Відповідайте стисло українською.', prompt };
}

const authorized = (req) => { const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, '')), want = Buffer.from(TOKEN); return given.length === want.length && timingSafeEqual(given, want); };
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readJson = (req) => new Promise((resolve, reject) => { let raw = ''; req.on('data', (d) => { raw += d; if (raw.length > MAX_BODY) { reject(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); } }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(Object.assign(new Error('invalid_json'), { status: 400 })); } }); });
const status = () => ({ enabled: state.enabled, runtime: 'claude-code', model: MODEL, effort: EFFORT, active, queued: waiting.length, calls: state.calls, failures: state.failures, last_ok_at: state.last_ok_at, last_ms: state.last_ms, last_error: state.last_error });

createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://bridge').pathname;
    if (path === '/healthz') return send(res, 200, { ok: true });
    if (!authorized(req)) return send(res, 401, { error: { code: 'unauthorized' } });
    if (path === '/v1/runtime' && req.method === 'GET') return send(res, 200, status());
    if (path === '/v1/runtime' && req.method === 'POST') {
      const body = await readJson(req);
      if (typeof body.enabled !== 'boolean') return send(res, 400, { error: { code: 'enabled_boolean_required' } });
      state.enabled = body.enabled; persist(); return send(res, 200, status());
    }
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      if (!state.enabled) return send(res, 409, { error: { code: 'runtime_disabled' } });
      const body = await readJson(req);
      const schema = body.response_format?.type === 'json_schema' ? body.response_format.json_schema?.schema : null;
      const { system, prompt } = flatten(Array.isArray(body.messages) ? body.messages : []);
      await slot(); const started = Date.now();
      try {
        const reply = await runClaude(system, prompt, schema, body.ufv_web_search === true);
        Object.assign(state, { calls: state.calls + 1, last_ok_at: new Date().toISOString(), last_ms: Date.now() - started, last_error: null });
        return send(res, 200, { id: 'ufv-' + started, object: 'chat.completion', model: MODEL,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply.content } }], usage: reply.usage ?? null });
      } catch (e) {
        Object.assign(state, { failures: state.failures + 1, last_error: String(e.message).slice(0, 200) });
        return send(res, e.message === 'timeout' ? 504 : 502, { error: { code: 'runtime_failed', message: String(e.message).slice(0, 200) } });
      } finally { release(); }
    }
    return send(res, 404, { error: { code: 'not_found' } });
  } catch (e) { return send(res, e.status || 500, { error: { code: e.message || 'internal' } }); }
}).listen(PORT, BIND, () => console.log(`ufv runtime bridge on http://${BIND}:${PORT} · ${MODEL} · effort ${EFFORT} · ${state.enabled ? 'enabled' : 'disabled'}`));
