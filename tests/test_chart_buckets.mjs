import assert from 'node:assert/strict';
import test from 'node:test';
import { dailyBuckets } from '../apps/web/src/lib/chart-buckets.ts';

test('weekly display keeps Kyiv dates, total counts and exact partial-day proof bounds', () => {
  const start = '2026-09-12T20:35:00Z', end = '2026-09-19T20:35:00Z';
  const input = [
    {at:'2026-09-12T20:00:00Z',count:1,topics:{network:1}},
    {at:'2026-09-12T21:00:00Z',count:2,topics:{billing:2}},
    {at:'2026-09-13T00:00:00Z',count:3,topics:{network:2,billing:1}},
  ].map(b => ({...b,href:'/feed?workflow_id=7&decision=accepted&window=7d&from=old&until=old'}));
  const out = dailyBuckets(input, start, end);
  assert.deepEqual(out.map(b => [b.at,b.count,b.topics]), [
    ['2026-09-12',1,{network:1}],['2026-09-13',5,{billing:3,network:2}],
  ]);
  for (const bucket of out) {
    const u = new URL(bucket.href,'https://example.test');
    assert.equal(u.searchParams.get('from'),start);
    assert.equal(u.searchParams.get('until'),end);
    assert.equal(u.searchParams.get('day'),bucket.at);
    assert.equal(u.searchParams.get('workflow_id'),'7');
    assert.equal(u.searchParams.get('decision'),'accepted');
    assert.equal(u.searchParams.get('window'),'7d');
  }
});

test('repeated clock hour at Kyiv DST end stays in one day without losing counts', () => {
  const data = ['2026-10-25T00:00:00Z','2026-10-25T01:00:00Z'].map(at=>({at,count:1,topics:{network:1},href:'/feed?workflow_id=1'}));
  assert.deepEqual(dailyBuckets(data,'2026-10-24T22:00:00Z','2026-10-25T22:00:00Z').map(b=>[b.at,b.count]),[['2026-10-25',2]]);
  assert.deepEqual(dailyBuckets([],data[0].at,data[1].at),[]);
});
