// Test directo del SDK sin Electron. Ejecutar con: node test-sdk.js
const { IRacingSDK } = require('irsdk-node');

(async () => {
  console.log('=== TEST iRacing SDK ===');
  const running = await IRacingSDK.IsSimRunning();
  console.log('Sim running:', running);
  if (!running) { console.log('Abrí iRacing'); process.exit(1); }

  const sdk = new IRacingSDK({ autoEnableTelemetry: true });
  sdk.startSDK();

  if (!sdk.waitForData(5000)) {
    console.log('Sin datos');
    process.exit(1);
  }

  function read(telemetry, key) {
    if (!telemetry) return null;
    const entry = telemetry[key];
    if (entry === undefined || entry === null) return null;
    const raw = entry.value;
    if (raw === undefined || raw === null) return null;
    if (Array.isArray(raw)) return raw.length === 1 ? raw[0] : raw[0];
    return raw;
  }

  console.log('\n=== Muestreo cada 500ms durante 10s (movete en pista) ===');
  console.log('LapNum | CurrentLap | BestLap | LastLap | DeltaToBest | Speed');
  console.log('-----------------------------------------------------------');
  for (let i = 0; i < 20; i++) {
    if (!sdk.waitForData(500)) break;
    const tel = sdk.getTelemetry();
    const lap = read(tel, 'Lap');
    const currentLap = read(tel, 'LapCurrentLapTime');
    const bestLap = read(tel, 'LapBestLapTime');
    const lastLap = read(tel, 'LapLastLapTime');
    const deltaToBest = read(tel, 'LapDeltaToBestLap');
    const speed = read(tel, 'Speed');
    console.log(`${lap} | ${currentLap?.toFixed(2)} | ${bestLap?.toFixed(2)} | ${lastLap?.toFixed(2)} | ${deltaToBest?.toFixed(3)} | ${speed?.toFixed(2)}`);
  }

  sdk.stopSDK();
  process.exit(0);
})();
