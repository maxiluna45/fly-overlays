const test = require('node:test');
const assert = require('node:assert');
const { formatLine, parseLine, createThrottle } = require('../src/main/log-format');

test('formatLine arma el formato del contrato', () => {
  const date = new Date('2026-07-17T14:03:01.123Z');
  const line = formatLine({ scope: 'irsdk', level: 'warn', date, text: 'hola | {"a":1}' });
  assert.strictEqual(line, '[2026-07-17T14:03:01.123Z] [WARN] [irsdk] hola | {"a":1}');
});

test('parseLine es inverso de formatLine', () => {
  const date = new Date('2026-07-17T14:03:01.123Z');
  const line = formatLine({ scope: 'overlay:radar', level: 'error', date, text: 'boom' });
  const parsed = parseLine(line);
  assert.strictEqual(parsed.level, 'ERROR');
  assert.strictEqual(parsed.scope, 'overlay:radar');
  assert.strictEqual(parsed.text, 'boom');
  assert.strictEqual(parsed.ts, '2026-07-17T14:03:01.123Z');
});

test('parseLine devuelve null en líneas de continuación (stack traces)', () => {
  assert.strictEqual(parseLine('    at Object.<anonymous> (foo.js:1:1)'), null);
});

test('createThrottle deja pasar la primera vez y respeta la ventana', () => {
  const t = createThrottle();
  assert.strictEqual(t.shouldLog('k', 1000, 5000), true);   // primera
  assert.strictEqual(t.shouldLog('k', 2000, 5000), false);  // dentro de ventana
  assert.strictEqual(t.shouldLog('k', 6001, 5000), true);   // pasó la ventana
  assert.strictEqual(t.shouldLog('otra', 2000, 5000), true);// key distinta
});
