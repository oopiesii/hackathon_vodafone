import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcile } from '../apps/web/src/lib/dashboard-layout.ts';

const DEFAULTS = ['network', 'reviews', 'regions', 'now', 'summary'];

test('порожній збережений порядок дає типовий вигляд', () => {
  assert.deepEqual(reconcile([], DEFAULTS), DEFAULTS);
});

test('збережений порядок зберігається, а зниклі блоки відкидаються', () => {
  const stored = ['summary', 'regions', 'видалений-блок', 'now', 'network', 'reviews'];
  assert.deepEqual(reconcile(stored, DEFAULTS), ['summary', 'regions', 'now', 'network', 'reviews']);
});

test('повтори в сховищі не подвоюють блок', () => {
  assert.deepEqual(reconcile(['now', 'now', 'network'], DEFAULTS).filter(id => id === 'now').length, 1);
});

test('новий блок з\'являється на своєму типовому місці, а не в кінці', () => {
  // Користувач налаштував вигляд до появи «regions»; після оновлення блок має бути третім.
  const stored = ['network', 'reviews', 'now', 'summary'];
  assert.deepEqual(reconcile(stored, DEFAULTS), ['network', 'reviews', 'regions', 'now', 'summary']);
  assert.equal(reconcile(stored, DEFAULTS).length, DEFAULTS.length);
});

test('жоден збережений порядок не приховує наявний блок', () => {
  for (const stored of [[], ['summary'], ['зайве'], DEFAULTS.slice().reverse()]) {
    assert.deepEqual([...reconcile(stored, DEFAULTS)].sort(), [...DEFAULTS].sort());
  }
});

test('нові блоки зберігають типовий порядок між собою', () => {
  // Збережено лише два блоки; решта має зʼявитись у своєму типовому порядку.
  const out = reconcile(['summary', 'now'], DEFAULTS);
  const fresh = out.filter(id => id !== 'summary' && id !== 'now');
  assert.deepEqual(fresh, DEFAULTS.filter(id => id !== 'summary' && id !== 'now'));
});

test('збережене сусідство не розривається новими блоками', () => {
  const out = reconcile(['summary', 'now'], DEFAULTS);
  assert.equal(out.indexOf('now'), out.indexOf('summary') + 1, `порядок: ${out.join(', ')}`);
});

test('порожній збережений порядок не змінює типовий', () => {
  assert.deepEqual(reconcile([], DEFAULTS), DEFAULTS);
  assert.deepEqual(reconcile(['зайве'], DEFAULTS), DEFAULTS);
});
