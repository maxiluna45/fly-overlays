const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildIflyLap, parseIflyLapText, IFLY_LAP_VERSION } = require('../src/main/ifly-lap');

const sampleLap = {
  lap: 5,
  lapTime: 92.345,
  valid: true,
  sectors: [28.4, 31.9, 32.045],
  micros: new Array(24).fill(1.2),
  samples: [{ th: 1, br: 0, st: 0.1, sp: 55.5, g: 4, rpm: 7200, t: 0.5, gLat: 0.2, gLon: -0.1, yaw: 0.01, lat: -34.1, lon: -58.2 }, null],
};
const sampleSession = {
  track: 'Interlagos', trackKey: 'interlagos gp', trackIdIr: 219, carIdIr: 133,
  car: 'Ferrari 296 GT3', sessionType: 'Practice', trackLength: 4.309, sectorPcts: [0.33, 0.66],
};

test('buildIflyLap arma el objeto v1 con lap y meta', () => {
  const o = buildIflyLap(sampleLap, sampleSession, { driver: 'Maxi', exportedAt: 1000, appVersion: '0.7.5' });
  assert.equal(o.format, 'iflylap');
  assert.equal(o.version, IFLY_LAP_VERSION);
  assert.equal(o.track, 'Interlagos');
  assert.equal(o.carIdIr, 133);
  assert.equal(o.lap.lapTime, 92.345);
  assert.equal(o.meta.driver, 'Maxi');
});

test('round-trip: parseIflyLapText devuelve una sesión con la vuelta original', () => {
  const o = buildIflyLap(sampleLap, sampleSession, { driver: 'Maxi', exportedAt: 1000, appVersion: '0.7.5' });
  const s = parseIflyLapText(JSON.stringify(o));
  assert.equal(s.track, 'Interlagos');
  assert.equal(s.car, 'Ferrari 296 GT3');
  assert.equal(s.trackLength, 4.309);
  assert.equal(s.laps.length, 1);
  assert.deepEqual(s.laps[0].samples, sampleLap.samples);
  assert.equal(s.laps[0].lapTime, 92.345);
  assert.equal(s.laps[0].source, 'ifly');
});

test('parseIflyLapText rechaza format/version inválidos y JSON corrupto', () => {
  assert.throws(() => parseIflyLapText('{"format":"otro","version":1}'), /formato/i);
  assert.throws(() => parseIflyLapText('{"format":"iflylap","version":999}'), /versión|version/i);
  assert.throws(() => parseIflyLapText('no-json'), /JSON/);
});
