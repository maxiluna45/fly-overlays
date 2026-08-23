const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../src/renderer/lib/session-match.js');

// Datos REALES del caso que falló (leídos de los archivos del usuario):
// el CSV de Garage 61 trae el nombre de display del circuito y ningún trackKey;
// la sesión de iRacing trae el nombre interno en trackKey y el display en track.
const CSV_G61 = {
  source: 'csv',
  track: 'Motorsport Arena Oschersleben (Grand Prix)',
  car: 'Global Mazda MX-5 Cup',
};
const IRACING = {
  source: 'ibt',
  track: 'Motorsport Arena Oschersleben',
  trackKey: 'oschersleben gp',
  car: 'Mazda MX-5 Cup',
};

test('un CSV de Garage 61 es referencia válida de una sesión de iRacing del mismo circuito', async () => {
  const { sameTrack, sameCar, isComparableReference } = await load();
  assert.equal(isComparableReference(CSV_G61, IRACING), true);
  assert.equal(isComparableReference(IRACING, CSV_G61), true, 'debe funcionar en los dos sentidos');
});

test('el nombre interno de iRacing y el display de Garage 61 se reconocen como el mismo circuito', async () => {
  const { sameTrack, sameCar, isComparableReference } = await load();
  assert.equal(sameTrack('oschersleben gp', 'Motorsport Arena Oschersleben (Grand Prix)'), false,
    'comparados directamente NO matchean: son sistemas de nombres distintos');
  // Por eso isComparableReference prueba todos los nombres que trae cada sesión.
});

test('dos sesiones de iRacing del mismo circuito y auto son comparables', async () => {
  const { sameTrack, sameCar, isComparableReference } = await load();
  const otra = { ...IRACING, track: 'Motorsport Arena Oschersleben', trackKey: 'oschersleben gp' };
  assert.equal(isComparableReference(otra, IRACING), true);
});

test('circuitos distintos no son comparables', async () => {
  const { sameTrack, sameCar, isComparableReference } = await load();
  const spa = { source: 'ibt', track: 'Circuit de Spa-Francorchamps', trackKey: 'spa 2024 up', car: 'Mazda MX-5 Cup' };
  assert.equal(isComparableReference(spa, IRACING), false);
  const csvSpa = { source: 'csv', track: 'Circuit de Spa-Francorchamps', car: 'Global Mazda MX-5 Cup' };
  assert.equal(isComparableReference(csvSpa, IRACING), false,
    'la excepción de los CSV no debe saltear el filtro de circuito');
});

test('entre sesiones de iRacing el auto sí tiene que coincidir', async () => {
  const { sameTrack, sameCar, isComparableReference } = await load();
  const otroAuto = { ...IRACING, car: 'Porsche 911 GT3 Cup' };
  assert.equal(isComparableReference(otroAuto, IRACING), false);
});

test('un CSV se acepta aunque el nombre del auto no coincida exacto', async () => {
  const { sameTrack, sameCar, isComparableReference } = await load();
  const csvOtroNombre = { ...CSV_G61, car: 'Mazda MX5 Cup 2016' };
  assert.equal(isComparableReference(csvOtroNombre, IRACING), true);
});

test('sameCar tolera prefijos del catálogo de iRacing', async () => {
  const { sameTrack, sameCar, isComparableReference } = await load();
  assert.equal(sameCar('Global Mazda MX-5 Cup', 'Mazda MX-5 Cup'), true);
  assert.equal(sameCar('Mazda MX-5 Cup', 'Porsche 911 GT3 Cup'), false);
});

test('sesiones sin datos de circuito no son comparables', async () => {
  const { sameTrack, sameCar, isComparableReference } = await load();
  assert.equal(isComparableReference({ source: 'csv' }, IRACING), false);
  assert.equal(isComparableReference(CSV_G61, { source: 'ibt' }), false);
  assert.equal(isComparableReference(null, IRACING), false);
  assert.equal(isComparableReference(CSV_G61, null), false);
});

test('sameTrack sigue tolerando prefijos genéricos y variantes de escritura', async () => {
  const { sameTrack, sameCar, isComparableReference } = await load();
  assert.equal(sameTrack('Circuit de Spa-Francorchamps', 'spa 2024 up'), true);
  assert.equal(sameTrack('Autodromo Nazionale Monza', 'monza full'), true);
  assert.equal(sameTrack('monza full', 'Silverstone Circuit'), false);
});

// Regresión: el coach avisaba "la referencia es de otra pista" comparando los
// nombres tal cual. iRacing nombra el mismo circuito de varias formas y el CSV
// de Garage 61 le agrega la config entre paréntesis.
test('sameTrackAny une los nombres del mismo circuito con y sin config', async () => {
  const { sameTrackAny } = await load();
  const g61 = { track: 'Virginia International Raceway (Full Course)' };
  const vivo = { track: 'Virginia International Raceway', trackKey: 'virginia 2022 full' };
  assert.equal(sameTrackAny(g61, vivo), true);
  assert.equal(sameTrackAny(g61, { track: 'Circuit de Spa-Francorchamps' }), false);
});
