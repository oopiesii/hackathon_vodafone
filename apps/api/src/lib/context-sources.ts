// Зовнішні контекстні сигнали. Читаються наживо з публічних джерел і кешуються лише в пам'яті процесу:
// у БД нічого не потрапляє, збирачі й міграції не потрібні. Збій джерела не ламає дашборд — блок отримує available:false.
// Імена авторів відгуків відкидаються під час розбору; у відповідь API вони не потрапляють.

const IODA = 'https://api.ioda.inetintel.cc.gatech.edu/v2';
const OPERATORS = [
  { id: 'vodafone', name: 'Vodafone', asn: 21497, app: 1178894933 },
  { id: 'kyivstar', name: 'Київстар', asn: 15895, app: 771788824 },
  { id: 'lifecell', name: 'lifecell', asn: 34058, app: 580080545 },
] as const;
type OperatorId = (typeof OPERATORS)[number]['id'];

export const cache = new Map<string, { at: number; value: unknown }>();
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  try {
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    // Застарілий кеш кращий за порожній блок; позначку свіжості інтерфейс бере з fetched_at.
    if (hit) return hit.value as T;
    throw error;
  }
}
async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json', 'user-agent': 'ufv-monitor/1.0 (+https://hire.qpon)' } });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  return response.json();
}
async function getText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'text/html', 'user-agent': 'ufv-monitor/1.0 (+https://hire.qpon)' } });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('upstream_too_large');
  return text;
}
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };

// ---------- Зв'язність мереж операторів (IODA, Georgia Tech) ----------
type Series = { source: 'bgp' | 'ping-slash24'; from: number; step: number; values: (number | null)[] };
const SOURCES: Series['source'][] = ['ping-slash24', 'bgp'];
const LEVELS = { normal: 0.9, degraded: 0.5 }; // частка від медіани вікна; евристика, не поріг IODA

async function operatorSignals(asn: number, from: number, until: number): Promise<Series[]> {
  const body = await getJson(`${IODA}/signals/raw/asn/${asn}?from=${from}&until=${until}&maxPoints=288`);
  const rows: any[] = Array.isArray(body?.data?.[0]) ? body.data[0] : body?.data ?? [];
  return rows.filter((r) => SOURCES.includes(r?.datasource) && Array.isArray(r.values))
    .map((r) => ({ source: r.datasource, from: Number(r.from), step: Number(r.step), values: r.values.map((v: unknown) => (typeof v === 'number' ? v : null)) }));
}
function describe(series: Series[]) {
  return SOURCES.flatMap((source) => {
    const s = series.find((x) => x.source === source);
    const known = s?.values.filter((v): v is number => v !== null) ?? [];
    if (!s || known.length < 12) return [];
    const base = median(known), last = known.at(-1)!, low = Math.min(...known);
    // Останні точки IODA ще добираються, тому «зараз» — медіана трьох останніх, а не одна точка.
    const now = median(known.slice(-3));
    const ratio = base ? now / base : 1;
    return [{ source, from: s.from, step: s.step, baseline: base, last, lowest: low, ratio,
      level: ratio >= LEVELS.normal ? 'normal' : ratio >= LEVELS.degraded ? 'degraded' : 'outage',
      percent: s.values.map((v) => (v === null || !base ? null : Math.round((v / base) * 1000) / 10)) }];
  });
}
export async function networkContext(window: '24h' | '7d') {
  const until = Math.floor(Date.now() / 1000), from = until - (window === '7d' ? 7 : 1) * 86400;
  const operators = await Promise.all(OPERATORS.map(async (op) => {
    try { return { id: op.id, name: op.name, asn: op.asn, signals: describe(await operatorSignals(op.asn, from, until)) }; }
    catch { return { id: op.id, name: op.name, asn: op.asn, signals: [] }; }
  }));
  if (!operators.some((o) => o.signals.length)) throw new Error('no_signals');
  let events: { source: string; start: string; minutes: number; score: number }[] = [];
  try {
    const body = await getJson(`${IODA}/outages/events?entityType=asn&entityCode=${OPERATORS[0].asn}&from=${until - 30 * 86400}&until=${until}`);
    events = (body?.data ?? []).slice(0, 10).map((e: any) => ({ source: String(e.datasource), start: new Date(Number(e.start) * 1000).toISOString(), minutes: Math.round(Number(e.duration) / 60), score: Math.round(Number(e.score)) }));
  } catch { /* перелік подій необов'язковий */ }
  return { window, from: new Date(from * 1000).toISOString(), until: new Date(until * 1000).toISOString(), operators, events, thresholds: LEVELS };
}

// ---------- Раптові зміни зв'язності по областях (IODA, усі оператори разом) ----------
// Показник порівнює «зараз» із медіаною ЦІЄЇ Ж доби, тому бачить лише раптові збої. Хронічні руйнування він не показує:
// у прифронтових областях знижений рівень уже є «звичним». Порівняння з лютим 2022 перевірено й відкинуто як ненадійне:
// воно дає ~50% і для тилових областей (змінилися адресний простір провайдерів і методика зондування).
// Без Криму, Севастополя та Луганщини: українські оператори там не працюють, тож для цього дашборда ряд нерелевантний.
const REGIONS: Record<string, string> = {
  4377: 'м. Київ', 4366: 'Київська', 4360: 'Львівська', 4373: 'Харківська', 4367: 'Одеська', 4371: 'Дніпропетровська', 4376: 'Запорізька',
  4354: 'Миколаївська', 4378: 'Херсонська', 4372: 'Донецька', 4370: 'Сумська', 4355: 'Чернігівська', 4375: 'Полтавська', 4364: 'Черкаська',
  4365: 'Кіровоградська', 4368: 'Вінницька', 4369: 'Житомирська', 4359: 'Хмельницька', 4356: 'Рівненська', 4363: 'Волинська',
  4361: 'Тернопільська', 4358: 'Івано-Франківська', 4357: 'Чернівецька', 4362: 'Закарпатська',
};
// Орієнтовний перелік областей з активними бойовими діями: лише для застереження в інтерфейсі, не для розрахунків.
const FRONTLINE = new Set(['4372', '4376', '4378', '4373', '4370', '4371']);
export async function regionsContext() {
  const until = Math.floor(Date.now() / 1000), from = until - 86400;
  const body = await getJson(`${IODA}/signals/raw/region/${Object.keys(REGIONS).join(',')}?from=${from}&until=${until}&maxPoints=96&datasource=ping-slash24`);
  const rows: any[] = (body?.data ?? []).flatMap((g: unknown) => (Array.isArray(g) ? g : [g]));
  const regions = rows.flatMap((r) => {
    const name = REGIONS[String(r?.entityCode)];
    const values: (number | null)[] = Array.isArray(r?.values) ? r.values.map((v: unknown) => (typeof v === 'number' ? v : null)) : [];
    const known = values.filter((v): v is number => v !== null);
    if (!name || known.length < 12) return [];
    const base = median(known), ratio = base ? median(known.slice(-3)) / base : 1;
    const lowest = Math.min(...known), lowestIndex = values.indexOf(lowest);
    return [{ code: String(r.entityCode), name, ratio, level: ratio >= LEVELS.normal ? 'normal' : ratio >= LEVELS.degraded ? 'degraded' : 'outage',
      lowest: base ? lowest / base : 1, lowest_at: new Date((Number(r.from) + lowestIndex * Number(r.step)) * 1000).toISOString(),
      percent: values.map((v) => (v === null || !base ? null : Math.round((v / base) * 1000) / 10)) }];
  }).sort((a, b) => a.ratio - b.ratio);
  if (!regions.length) throw new Error('no_regions');
  for (const region of regions) Object.assign(region, { frontline: FRONTLINE.has(region.code) });
  return { from: new Date(from * 1000).toISOString(), until: new Date(until * 1000).toISOString(), regions, thresholds: LEVELS };
}

// ---------- Відгуки App Store (офіційні публічні сторінки Apple) ----------
const mask = (text: string) => text
  .replace(/\b[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}\b/g, '[email вилучено]')
  .replace(/(?<!\w)\+?\d[\d ()-]{8,}\d(?!\w)/g, '[номер вилучено]')
  .replace(/\s+/g, ' ').trim();

type AppleReview = { id: string; rating: number; date: string; version: string; title: string; text: string };

/**
 * Apple припинила наповнювати старий customerreviews RSS, але офіційна публічна
 * сторінка App Store віддає ті самі видимі відгуки у serialized-server-data.
 * Авторів і відповіді розробника навмисно не повертаємо й не кешуємо.
 */
export function parseAppStoreReviewsPage(html: string): AppleReview[] {
  const script = html.match(/<script\b[^>]*\bid=(?:["']serialized-server-data["']|serialized-server-data)[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!script) throw new Error('apple_page_without_data');
  const root = JSON.parse(script) as any;
  const items = root?.data?.[0]?.data?.shelfMapping?.allProductReviews?.items;
  if (!Array.isArray(items)) throw new Error('apple_page_without_reviews');
  const seen = new Set<string>();
  return items.flatMap((item: any) => {
    const review = item?.review;
    const id = String(review?.id ?? '');
    const rating = Number(review?.rating);
    const date = String(review?.date ?? '').slice(0, 10);
    if (!/^\d+$/.test(id) || seen.has(id) || !Number.isInteger(rating) || rating < 1 || rating > 5 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    seen.add(id);
    return [{ id, rating, date, version: '', title: mask(String(review?.title ?? '')).slice(0, 120), text: mask(String(review?.contents ?? '')).slice(0, 400) }];
  }).sort((a: AppleReview, b: AppleReview) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

async function appReviews(op: (typeof OPERATORS)[number]) {
  const pageUrl = `https://apps.apple.com/ua/app/id${op.app}?see-all=reviews&platform=iphone`;
  const [page, lookup] = await Promise.all([
    getText(pageUrl),
    getJson(`https://itunes.apple.com/lookup?id=${op.app}&country=ua`).catch(() => null),
  ]);
  const store = lookup?.results?.[0];
  if (Number(store?.trackId) !== op.app) throw new Error('apple_app_identity_mismatch');
  const reviews = parseAppStoreReviewsPage(page);
  const distribution = [1, 2, 3, 4, 5].map((stars) => ({ stars, count: reviews.filter((r) => r.rating === stars).length }));
  const negative = reviews.filter((r) => r.rating <= 2).length;
  const days = new Map<string, { date: string; negative: number; other: number }>();
  for (const r of reviews) { const d = days.get(r.date) ?? { date: r.date, negative: 0, other: 0 }; r.rating <= 2 ? d.negative++ : d.other++; days.set(r.date, d); }
  return {
    id: op.id as OperatorId, name: op.name, app_id: op.app, url: pageUrl, source: 'apple_app_store' as const,
    sample: reviews.length, negative, negative_share: reviews.length ? negative / reviews.length : null,
    average: reviews.length ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length : null,
    period: { from: reviews.at(-1)?.date ?? null, to: reviews[0]?.date ?? null },
    store_rating: typeof store?.averageUserRating === 'number' ? store.averageUserRating : null,
    store_count: typeof store?.userRatingCount === 'number' ? store.userRatingCount : null,
    distribution, daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    recent_negative: op.id === 'vodafone' ? reviews.filter((r) => r.rating <= 2).slice(0, 6) : [],
  };
}
// Офіційна сторінка може бути тимчасово недоступна. Останній успішний зріз кожного
// оператора тримаємо окремо й показуємо з явною позначкою часу, а не втрачаємо.
type AppSnapshot = Awaited<ReturnType<typeof appReviews>>;
const lastGoodReviews = new Map<string, { at: number; app: AppSnapshot }>();

function emptyApp(op: (typeof OPERATORS)[number]) {
  return { id: op.id as OperatorId, name: op.name, app_id: op.app, url: `https://apps.apple.com/ua/app/id${op.app}?see-all=reviews&platform=iphone`, source: 'apple_app_store' as const,
    sample: 0, negative: 0, negative_share: null, average: null, period: { from: null as string | null, to: null as string | null },
    store_rating: null as number | null, store_count: null as number | null,
    distribution: [1, 2, 3, 4, 5].map((stars) => ({ stars, count: 0 })), daily: [] as AppSnapshot['daily'], recent_negative: [] as AppSnapshot['recent_negative'] };
}

export async function reviewsContext() {
  const apps = await Promise.all(OPERATORS.map(async (op) => {
    let fresh: AppSnapshot | null = null;
    for (let attempt = 0; attempt < 2 && !fresh; attempt++) {
      try {
        const app = await appReviews(op);
        if (app.sample > 0) fresh = app;
      } catch { /* тимчасова мережева помилка не повинна прибирати останній чесний зріз */ }
      if (!fresh && attempt === 0) await new Promise((r) => setTimeout(r, 400));
    }
    if (fresh) {
      lastGoodReviews.set(op.id, { at: Date.now(), app: fresh });
      return fresh;
    }
    const kept = lastGoodReviews.get(op.id);
    // Оператора не можна мовчки прибирати: зниклий рядок читається як «у нього немає скарг».
    return kept ? { ...kept.app, stale_at: new Date(kept.at).toISOString() } : { ...emptyApp(op), unavailable: 'empty' as const };
  }));
  if (!apps.some((a) => a.sample > 0)) throw new Error('no_reviews');
  return { apps };
}

/** Фонове оновлення офіційного зрізу, щоб перший перегляд дашборда не чекав Apple. */
export function startReviewsPolling(intervalMs = 20 * 60_000) {
  const tick = () => { reviewsContext().then((value) => cache.set('reviews', { at: Date.now(), value })).catch(() => {}); };
  setTimeout(tick, 5_000);
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}
