// Виключно синтетичні дані для локального Chromium; не імпортуються застосунком.
const end = '2026-09-19T20:00:00.000Z';
const start = '2026-09-18T20:00:00.000Z';
const href = '/feed?workflow_id=1&decision=visible&from=' + start + '&until=' + end;
const series = [2, 3, 5, 1, 3, 2, 4, 6, 8, 12, 9, 7];
const metric = (value, unit = 'матеріалів', note = 'Тестовий підрахунок матеріалів') => ({ value, unit, href, series, measured: 48, note });
export const dashboard = {
 version: 1, workflow_id: '1', window: '24h', start, end, timezone: 'Europe/Kyiv', generated_at: end, aggregated: false, visibility: 'accepted_review',
 brand_status: { level: 'attention', title: 'Перебої мобільного інтернету у Львові', reason: 'Синтетична перевірка: тема мережі у двох джерелах', negative_delta_pp: null, href },
 metrics: { mentions: metric(124), critical: metric(0), negative_share: metric(24, 'percent'), negative_reach: metric(42100, 'переглядів'), collection_lag: metric(83, 'seconds'), noise: {...metric(1234), href:'/inbox?workflow_id=1&state=rejected'} },
 counts: { accepted: 96, review: 28, collected: 1380, rejected: 1234, pending: 22 },
 hourly: Array.from({length:24}, (_, i) => { const count = series[i % 12]; return { at: new Date(Date.parse(start) + i * 3600000).toISOString(), count, topics: { network: Math.floor(count * .6), billing: count - Math.floor(count * .6) }, href }; }),
 topics: [{topic:'network',count:76,href},{topic:'billing',count:48,href}],
 sources: [{id:'1',title:'Синтетичний приклад · міські новини',kind:'telegram',count:46,href},{id:'2',title:'Тестова телеком-стрічка',kind:'rss',count:35,href},{id:'3',title:'Приклад · технології',kind:'rss',count:22,href},{id:'4',title:'Приклад · регіони',kind:'telegram',count:13,href},{id:'5',title:'Тестове джерело',kind:'telegram',count:8,href}],
 reactions: {negative:120,ironic:22,sad:14,positive:344,total:500,observed_items:48,negative_share:.24,href,note:'Евристика: іронічні й сумні реакції враховано окремо'},
 signals: [{id:'network',title:'Синтетичний приклад: перебої інтернету у Львові',topic:'network',brand:'vodafone',level:'m',count:9,sources:2,spread:3,action:'investigating',href,evidence:[],reason:'Тестовий сигнал'},{id:'billing',title:'Синтетичний приклад: запитання про новий тариф',topic:'billing',brand:'vodafone',level:'l',count:4,sources:2,spread:0,action:'none',href,evidence:[],reason:'Тестовий сигнал'}],
 spread: [{id:'1',count:3,source_count:2,third_repost_seconds:720,items_per_hour_first_6h:.5,href}],reach_anomalies:[],growth:[],complaints:{count:2,per_hour:1,href,note:'Правила'},
 lag_by_service:[{service:'telegram',median_seconds:83,measured:48,href},{service:'rss',median_seconds:180,measured:12,href}],
 freshness:[{service:'telegram',enabled:true,last_success_at:'2026-09-19T19:59:40.000Z',heartbeat_at:end},{service:'rss',enabled:true,last_success_at:'2026-09-19T19:57:00.000Z',heartbeat_at:end}],
 competitors:[{brand:'kyivstar',count:18,negative:2,href:href+'&brand=kyivstar'},{brand:'lifecell',count:12,negative:1,href:href+'&brand=lifecell'}],
 ai:{status:'waiting_key',label:'AI очікує ключ',summary:'За правилами: 124 тематичні матеріали. Найчастіше обговорюють мережу й покриття. Приклад для перевірки інтерфейсу, не реальні результати.',href},
 methodology:['Згадки — прийняті матеріали й матеріали на перевірці у вибраному напрямі.','Частка негативних реакцій — евристика. Сумні реакції обліковуються окремо.','Перепублікації не є незалежними підтвердженнями.','Ця сторінка використовує синтетичні дані лише в локальному браузерному сценарії.'],
};
