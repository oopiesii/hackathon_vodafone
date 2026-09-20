import assert from 'node:assert/strict';
import test from 'node:test';
import { plural, quantity, brandName } from '../apps/web/src/lib/plural.ts';

const form = n => plural(n, 'згадка', 'згадки', 'згадок');

test('одинична форма лише для 1, 21, 101 — але не для 11', () => {
  for (const n of [1, 21, 31, 101, 1001]) assert.equal(form(n), 'згадка', `n=${n}`);
  assert.equal(form(11), 'згадок');
  assert.equal(form(111), 'згадок');
});

test('форма для 2–4 не поширюється на 12–14', () => {
  for (const n of [2, 3, 4, 22, 23, 24, 102]) assert.equal(form(n), 'згадки', `n=${n}`);
  for (const n of [12, 13, 14, 112, 113, 114]) assert.equal(form(n), 'згадок', `n=${n}`);
});

test('нуль і 5–20 дають родовий множини', () => {
  for (const n of [0, 5, 9, 10, 15, 20, 25, 100]) assert.equal(form(n), 'згадок', `n=${n}`);
});

test('відʼємні значення відмінюються за модулем', () => {
  assert.equal(form(-1), 'згадка');
  assert.equal(form(-3), 'згадки');
  assert.equal(form(-11), 'згадок');
});

test('quantity групує розряди й не лишає числа без пробілу', () => {
  const text = quantity(1338, 'матеріал', 'матеріали', 'матеріалів');
  assert.ok(text.endsWith('матеріалів'), text);
  assert.ok(!/\d{4}/.test(text), `розряди не згруповані: ${text}`);
  assert.equal(quantity(1, 'матеріал', 'матеріали', 'матеріалів'), '1 матеріал');
});

test('невідомий бренд не друкується як сире значення', () => {
  assert.equal(brandName('vodafone'), 'Vodafone');
  assert.equal(brandName('kyivstar'), 'Київстар');
  assert.equal(brandName('щось-нове'), 'Бренд не визначено');
});
