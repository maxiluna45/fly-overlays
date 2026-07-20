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
  assert.strictEqual(flagCodeForClub('Benelux'), 'nl');
  assert.strictEqual(flagCodeForClub('Scandinavia'), 'se');
  assert.strictEqual(flagCodeForClub('South America'), 'ar');
  assert.strictEqual(flagCodeForClub('Asia'), 'jp');
  assert.strictEqual(flagCodeForClub('International'), 'un');
});

test('alias y variantes de escritura se normalizan correctamente', () => {
  assert.strictEqual(flagCodeForClub('UK&I'), 'gb');
  assert.strictEqual(flagCodeForClub('Australia/NZ'), 'au');
  assert.strictEqual(flagCodeForClub('  central-eastern   europe  '), 'pl');
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
