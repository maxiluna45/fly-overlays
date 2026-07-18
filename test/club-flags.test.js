const test = require('node:test');
const assert = require('node:assert');
const { flagCodeForClub } = require('../src/renderer/lib/club-flags');

test('clubes internacionales con país único → ISO2', () => {
  assert.strictEqual(flagCodeForClub('Brazil'), 'br');
  assert.strictEqual(flagCodeForClub('Brasil'), 'br');   // variante localizada
  assert.strictEqual(flagCodeForClub('Australia'), 'au');
  assert.strictEqual(flagCodeForClub('Canada'), 'ca');
  assert.strictEqual(flagCodeForClub('Finland'), 'fi');
  assert.strictEqual(flagCodeForClub('France'), 'fr');
  assert.strictEqual(flagCodeForClub('Italy'), 'it');
});

test('estados/regiones de EE.UU. → us', () => {
  for (const club of ['Michigan', 'Texas', 'Florida', 'California', 'New York',
    'Ohio', 'Plains', 'Midwest', 'Mid-South', 'New England', 'Virginias', 'West']) {
    assert.strictEqual(flagCodeForClub(club), 'us', `${club} debería ser us`);
  }
});

test('clubes multipaís con país dominante representativo', () => {
  assert.strictEqual(flagCodeForClub('UK and I'), 'gb');
  assert.strictEqual(flagCodeForClub('Iberia'), 'es');
  assert.strictEqual(flagCodeForClub('DE-AT-CH'), 'de');
});

test('clubes pan-regionales sin país único → null (no inventar bandera)', () => {
  for (const club of ['Benelux', 'Scandinavia', 'Central-Eastern Europe',
    'Asia', 'International', 'South America']) {
    assert.strictEqual(flagCodeForClub(club), null, `${club} debería ser null`);
  }
});

test('normalización robusta: mayúsculas, espacios, acentos', () => {
  assert.strictEqual(flagCodeForClub('  brazil  '), 'br');
  assert.strictEqual(flagCodeForClub('TEXAS'), 'us');
  assert.strictEqual(flagCodeForClub('uk and i'), 'gb');
});

test('entradas vacías o desconocidas → null', () => {
  assert.strictEqual(flagCodeForClub(''), null);
  assert.strictEqual(flagCodeForClub(null), null);
  assert.strictEqual(flagCodeForClub(undefined), null);
  assert.strictEqual(flagCodeForClub('Club Inexistente'), null);
});
