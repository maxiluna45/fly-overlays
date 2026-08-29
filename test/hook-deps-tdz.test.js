// El render de una vista entera se cae si un array de dependencias nombra un
// `const` declarado más abajo: el array se evalúa durante el render, o sea en
// la zona muerta, y tira ReferenceError. Pasó en CoachView (pantalla negra al
// entrar al coach, 0.16.1) y no lo atrapa ni el build ni ningún test de unidad,
// porque es válido sintácticamente. Este test lo atrapa en cualquier vista.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
  );

function tdzDeps(src) {
  const lines = src.split("\n");
  const declaredAt = {};
  lines.forEach((l, i) => {
    const m = l.match(/^\s*(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:useCallback|useMemo|useRef)/);
    if (m && declaredAt[m[1]] === undefined) declaredAt[m[1]] = i;
  });
  const bad = [];
  lines.forEach((l, i) => {
    const m = l.match(/\[([^\]]*)\]\s*\)/);
    if (!m) return;
    for (const name of m[1].split(",").map((s) => s.trim())) {
      if (declaredAt[name] !== undefined && i < declaredAt[name]) {
        bad.push(`línea ${i + 1}: la dependencia '${name}' se declara recién en la línea ${declaredAt[name] + 1}`);
      }
    }
  });
  return bad;
}

test("ningún array de dependencias usa un const declarado más abajo", () => {
  const files = walk("src/renderer").filter((f) => /\.(jsx|js)$/.test(f));
  assert.ok(files.length > 0, "no se encontró ningún archivo del renderer");
  const problemas = [];
  for (const f of files) {
    for (const p of tdzDeps(fs.readFileSync(f, "utf8"))) problemas.push(`${f} → ${p}`);
  }
  assert.deepStrictEqual(problemas, []);
});

test("detecta el caso que rompió la vista del coach", () => {
  const roto = [
    '  useEffect(() => { loadReference(1); }, [loadReference]);',
    '  const loadReference = useCallback(() => {}, []);',
  ].join("\n");
  assert.strictEqual(tdzDeps(roto).length, 1);
  const sano = [
    '  const loadReference = useCallback(() => {}, []);',
    '  useEffect(() => { loadReference(1); }, [loadReference]);',
  ].join("\n");
  assert.deepStrictEqual(tdzDeps(sano), []);
});
