// Lista las variables relacionadas con sectores del SDK
const { IRacingSDK } = require('irsdk-node');

(async () => {
  if (!(await IRacingSDK.IsSimRunning())) {
    console.log('Abrí iRacing');
    process.exit(1);
  }
  const sdk = new IRacingSDK({ autoEnableTelemetry: true });
  sdk.startSDK();

  if (!sdk.waitForData(5000)) {
    console.log('Sin datos');
    process.exit(1);
  }

  const tel = sdk.getTelemetry();
  const all = Object.keys(tel).filter((k) =>
    k.toLowerCase().includes('sector') ||
    k.toLowerCase().includes('split') ||
    k.toLowerCase().includes('lap')
  ).sort();

  console.log('Variables:');
  console.log('==========');
  for (const k of all) {
    const v = tel[k];
    const raw = v?.value;
    let display;
    if (Array.isArray(raw)) {
      display = `[${raw.slice(0, 6).map(x => typeof x === 'number' ? x.toFixed(3) : x).join(', ')}${raw.length > 6 ? `, ... (len=${raw.length})` : ''}]`;
    } else if (typeof raw === 'number') {
      display = raw.toFixed(4);
    } else {
      display = JSON.stringify(raw);
    }
    console.log(`  ${k.padEnd(35)} ${display}`);
  }

  sdk.stopSDK();
  process.exit(0);
})();
