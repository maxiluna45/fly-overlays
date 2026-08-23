const { test } = require('node:test');
const assert = require('node:assert/strict');

test('buildTrackSegments conecta puntos consecutivos y saltea huecos grandes', async () => {
  const { buildTrackSegments } = await import('../src/renderer/lib/track-render.js');
  const path = new Array(10).fill(null);
  path[0] = { x: 0, y: 0, hue: 200 };
  path[1] = { x: 1, y: 1, hue: 200 };
  path[2] = { x: 2, y: 2, hue: 200 };
  // hueco grande entre idx 2 y 9 (>6) → no se conecta
  path[9] = { x: 9, y: 9, hue: 0 };
  const segs = buildTrackSegments(path);
  assert.equal(segs.length, 2); // 0-1 y 1-2, no 2-9
  assert.ok('c1x' in segs[0] && 'x2' in segs[0]);
});

test('speedColor mapea min→azul y max→rojo', async () => {
  const { speedColor } = await import('../src/renderer/lib/track-render.js');
  assert.match(speedColor(0, 0, 100), /^hsl\(/);
  assert.notEqual(speedColor(0, 0, 100), speedColor(100, 0, 100));
});

test('autoMapRotation convierte TrackNorthOffset en grados de rotación del mapa', async () => {
  const { autoMapRotation } = await import('../src/renderer/lib/track-render.js');
  // Valores reales del YAML de sesiones propias.
  assert.equal(autoMapRotation(1.6113), 268);  // Spa
  assert.equal(autoMapRotation(1.8851), 252);  // Oschersleben
  assert.equal(autoMapRotation(0.4107), 336);  // Lime Rock
  assert.equal(autoMapRotation(0), 0);         // ya alineado al norte
  assert.equal(autoMapRotation(null), null);   // sin dato: el mapa queda norte arriba
  assert.equal(autoMapRotation(NaN), null);
});
