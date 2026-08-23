const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/renderer/lib/incidents.js');

test('incidentLevel: sin dato no hay semáforo', async () => {
  const { incidentLevel } = await load();
  assert.equal(incidentLevel(null), null);
  assert.equal(incidentLevel(undefined), null);
  assert.equal(incidentLevel(-1), null); // lo que devuelve iRacing para los rivales
});

test('incidentLevel: cortes absolutos', async () => {
  const { incidentLevel } = await load();
  assert.equal(incidentLevel(0), 'clean');
  assert.equal(incidentLevel(1), 'clean');
  assert.equal(incidentLevel(2), 'warn');
  assert.equal(incidentLevel(3), 'warn');
  assert.equal(incidentLevel(4), 'risk');
  assert.equal(incidentLevel(22), 'risk');
});

test('incidentLevel: el límite de la sesión adelanta el rojo', async () => {
  const { incidentLevel } = await load();
  // Con límite 4x, 2 incidentes ya es la mitad del presupuesto.
  assert.equal(incidentLevel(2, { limit: 4 }), 'risk');
  // Con límite 17x los cortes absolutos siguen mandando.
  assert.equal(incidentLevel(2, { limit: 17 }), 'warn');
  assert.equal(incidentLevel(1, { limit: 17 }), 'clean');
  assert.equal(incidentLevel(9, { limit: 17 }), 'risk');
});

test('incidentColor y incidentTitle', async () => {
  const { incidentColor, incidentTitle, INCIDENT_COLORS } = await load();
  assert.equal(incidentColor(5), INCIDENT_COLORS.risk);
  assert.equal(incidentColor(-1), null);
  assert.match(incidentTitle('Piloto', 3, { limit: 17 }), /3x en esta sesión de 17/);
  assert.equal(incidentTitle('Piloto', -1), '');
});
