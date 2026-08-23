const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const load = () => import('../src/renderer/lib/changelog.js');

const SAMPLE = `# Changelog

Texto de preámbulo que no es una release y debe ignorarse.

## [0.8.0] - 2026-08-22

### Agregado
- Vista de Changelog.
- Otra cosa nueva.

### Corregido
- Un bug con texto
  que sigue en la línea de abajo.

## [0.7.6] - 2026-07-23

### Cambiado
- Algo cambió.
`;

test('extrae las releases en el orden del archivo', async () => {
  const { parseChangelog, formatReleaseDate } = await load();
  const rel = parseChangelog(SAMPLE);
  assert.equal(rel.length, 2);
  assert.equal(rel[0].version, '0.8.0');
  assert.equal(rel[1].version, '0.7.6');
});

test('extrae la fecha de cada release', async () => {
  const { parseChangelog, formatReleaseDate } = await load();
  const [first] = parseChangelog(SAMPLE);
  assert.equal(first.date, '2026-08-22');
});

test('agrupa los ítems por tipo de cambio', async () => {
  const { parseChangelog, formatReleaseDate } = await load();
  const [first] = parseChangelog(SAMPLE);
  assert.deepEqual(first.groups.map((g) => g.title), ['Agregado', 'Corregido']);
  assert.equal(first.groups[0].items.length, 2);
  assert.equal(first.groups[0].items[0], 'Vista de Changelog.');
});

test('une los ítems que continúan en la línea siguiente', async () => {
  const { parseChangelog, formatReleaseDate } = await load();
  const [first] = parseChangelog(SAMPLE);
  const corregido = first.groups.find((g) => g.title === 'Corregido');
  assert.equal(corregido.items[0], 'Un bug con texto que sigue en la línea de abajo.');
});

test('el preámbulo no se cuela como release ni como ítem', async () => {
  const { parseChangelog, formatReleaseDate } = await load();
  const rel = parseChangelog(SAMPLE);
  const texto = JSON.stringify(rel);
  assert.ok(!texto.includes('preámbulo'), 'el preámbulo no debe aparecer en las releases');
});

test('una release sin fecha se parsea con date null', async () => {
  const { parseChangelog, formatReleaseDate } = await load();
  const rel = parseChangelog('## [1.0.0]\n\n### Agregado\n- Algo.\n');
  assert.equal(rel.length, 1);
  assert.equal(rel[0].version, '1.0.0');
  assert.equal(rel[0].date, null);
});

test('tolera versiones sin corchetes', async () => {
  const { parseChangelog, formatReleaseDate } = await load();
  const rel = parseChangelog('## 2.1.0 - 2026-01-05\n\n### Agregado\n- Algo.\n');
  assert.equal(rel[0].version, '2.1.0');
  assert.equal(rel[0].date, '2026-01-05');
});

test('entradas vacías o basura no explotan', async () => {
  const { parseChangelog, formatReleaseDate } = await load();
  assert.deepEqual(parseChangelog(''), []);
  assert.deepEqual(parseChangelog(null), []);
  assert.deepEqual(parseChangelog('nada que parsear'), []);
});

test('ítems sueltos sin encabezado de grupo se agrupan bajo un grupo sin título', async () => {
  const { parseChangelog, formatReleaseDate } = await load();
  const [rel] = parseChangelog('## [1.2.3] - 2026-02-02\n- Un cambio sin sección.\n');
  assert.equal(rel.groups.length, 1);
  assert.equal(rel.groups[0].title, null);
  assert.equal(rel.groups[0].items[0], 'Un cambio sin sección.');
});

test('formatReleaseDate muestra la fecha en DD/MM/AAAA', async () => {
  const { parseChangelog, formatReleaseDate } = await load();
  assert.equal(formatReleaseDate('2026-08-22'), '22/08/2026');
  assert.equal(formatReleaseDate(null), '');
  assert.equal(formatReleaseDate('cualquier cosa'), 'cualquier cosa');
});

test('el CHANGELOG.md real del repo parsea y su primera release es la del package.json', async () => {
  const { parseChangelog, formatReleaseDate } = await load();
  const md = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf-8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  const rel = parseChangelog(md);
  assert.ok(rel.length > 0, 'el CHANGELOG.md del repo debe tener al menos una release');
  assert.equal(rel[0].version, pkg.version,
    'la release más nueva del CHANGELOG.md debe coincidir con la versión del package.json');
});
