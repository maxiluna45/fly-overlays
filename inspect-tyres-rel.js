// Test integrado: simula lo que hace getRelative() con el SDK real
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
function readCarIdxArray(tel, key, n, playerIdx) {
  const raw = read(tel, key);
  if (Array.isArray(raw) && raw.length > 1) {
    if (raw.length < n) {
      const out = new Array(n).fill(0);
      for (let i = 0; i < raw.length; i++) out[i] = raw[i];
      return out;
    }
    return raw;
  }
  const out = new Array(n).fill(0);
  if (playerIdx >= 0 && playerIdx < n && raw != null) out[playerIdx] = raw;
  return out;
}
function loop() {
  let hasData;
  try { hasData = sdk.waitForData(TIMEOUT); } catch (e) { return; }
  if (!hasData) { setImmediate(loop); return; }
  frame++;
  if (frame % 60 !== 0) { setImmediate(loop); return; }
  try {
    const tel = sdk.getTelemetry();
    if (!tel) { setImmediate(loop); return; }
    const di = sdk.getDriverInfo();
    if (!di || !di.Drivers) { setImmediate(loop); return; }
    const n = di.Drivers.length;
    const playerIdx = read(tel, 'PlayerCarIdx') ?? 0;
    const playerDriver = di.Drivers.find(d => d.CarIdx === playerIdx);
    const playerClass = playerDriver ? playerDriver.CarClassID : 0;

    const positions = readCarIdxArray(tel, 'CarIdxPosition', n, playerIdx);
    const cpos = readCarIdxArray(tel, 'CarIdxClassPosition', n, playerIdx);
    const lapC = readCarIdxArray(tel, 'CarIdxLapCompleted', n, playerIdx);
    const lapD = readCarIdxArray(tel, 'CarIdxLapDistPct', n, playerIdx);
    const surf = readCarIdxArray(tel, 'CarIdxTrackSurface', n, playerIdx);
    const lastLT = readCarIdxArray(tel, 'CarIdxLastLapTime', n, playerIdx);
    const bestLT = readCarIdxArray(tel, 'CarIdxBestLapTime', n, playerIdx);

    if (!logged) {
      console.log(`n=${n} playerIdx=${playerIdx} playerClass=${playerClass}`);
      console.log(`positions.len=${positions.length} cpos.len=${cpos.length} lapC.len=${lapC.length}`);
      console.log(`positions sample:`, positions.slice(0, 15));
      console.log(`cpos sample:`, cpos.slice(0, 15));
      console.log(`lapC sample:`, lapC.slice(0, 15));
      console.log(`surf sample:`, surf.slice(0, 15));
      console.log(`lastLT sample:`, lastLT.slice(0, 15).map(v => v?.toFixed(2)));
      console.log(`bestLT sample:`, bestLT.slice(0, 15).map(v => v?.toFixed(2)));
      // Driver info sample
      console.log('\n=== driverInfo.Drivers[0..5] ===');
      for (let i = 0; i < Math.min(6, n); i++) {
        const d = di.Drivers[i];
        console.log(`  [${i}] CarIdx=${d.CarIdx} UserName=${d.UserName} ClassID=${d.CarClassID} ClassShort=${d.CarClassShortName} PaceCar=${d.CarIsPaceCar}`);
      }
      // Contar cuántos de la clase del player
      const inClass = di.Drivers.filter(d => d.CarClassID === playerClass && d.CarIsPaceCar !== 1).length;
      console.log(`\nDrivers en la clase del player: ${inClass}`);
      // Cuántos con pos > 0
      const inWorld = positions.filter(p => p > 0).length;
      console.log(`Drivers con pos > 0: ${inWorld}`);
      logged = true;
    }
  } catch (e) {}
  setImmediate(loop);
}
loop();
setTimeout(() => { try { sdk.stopSDK(); } catch (_) {} process.exit(0); }, 20000);
