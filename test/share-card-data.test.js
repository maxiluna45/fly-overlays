const { test } = require('node:test');
const assert = require('node:assert/strict');

test('fmtLapTime formatea m:ss.mmm', async () => {
  const { fmtLapTime } = await import('../src/renderer/lib/share-card-data.js');
  assert.equal(fmtLapTime(92.345), '1:32.345');
  assert.equal(fmtLapTime(0), '—');
});

test('buildCardModel arma el modelo con badge PB cuando la vuelta es la mejor', async () => {
  const { buildCardModel } = await import('../src/renderer/lib/share-card-data.js');
  const lap = { lapTime: 92.3, valid: true, sectors: [28.4, 31.9, 32.0] };
  const m = buildCardModel({ lap, session: { car: 'F296', track: 'Interlagos' }, best: lap, displayName: 'Maxi' });
  assert.equal(m.time, '1:32.300');
  assert.equal(m.isPB, true);
  assert.equal(m.sectors.length, 3);
  assert.equal(m.driver, 'Maxi');
  assert.equal(m.car, 'F296');
});
