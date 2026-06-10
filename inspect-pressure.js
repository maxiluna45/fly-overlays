// Busca todas las keys relacionadas con presión de neumáticos
const { IRacingSDK } = require('irsdk-node');
const TIMEOUT = Math.floor((1 / 60) * 1000);
const sdk = new IRacingSDK({ autoEnableTelemetry: true });
sdk.startSDK();
let frame = 0, logged = false;
function read(tel, key) {
  if (!tel) return null;
  const e = tel[key];
  if (e == null) return null;
  const v = e.value;
  if (v == null) return null;
  if (Array.isArray(v)) return v.length === 1 ? v[0] : v[0];
  return v;
}
function loop() {
  let hasData;
  try { hasData = sdk.waitForData(TIMEOUT); } catch (e) { return; }
  if (!hasData) { setImmediate(loop); return; }
  frame++;
  try {
    const tel = sdk.getTelemetry();
    if (!tel) { setImmediate(loop); return; }
    if (!logged) {
      const all = Object.keys(tel).sort();
      const tyreAll = all.filter(k => /(tyre|tire|press|wear|temp|psi|kpa|kpa)/i.test(k));
      const lfAll = all.filter(k => /^LF/i.test(k));
      const rfAll = all.filter(k => /^RF/i.test(k));
      console.log('=== Todas las keys con tyre/press/wear/temp ===');
      console.log(tyreAll);
      console.log('\n=== Keys que empiezan con LF ===');
      console.log(lfAll);
      console.log('\n=== Keys que empiezan con RF ===');
      console.log(rfAll);
      console.log('\n=== Sample values ===');
      for (const k of lfAll) console.log(`  ${k} =`, read(tel, k));
      console.log('---');
      for (const k of rfAll) console.log(`  ${k} =`, read(tel, k));
      logged = true;
    }
  } catch (e) {}
  setImmediate(loop);
}
loop();
setTimeout(() => { try { sdk.stopSDK(); } catch (_) {} process.exit(0); }, 8000);
