// Solo verifica si el SDK se conecta
const { IRacingSDK } = require('irsdk-node');
console.log('Iniciando...');
(async () => {
  const sdk = new IRacingSDK({ autoEnableTelemetry: true });
  sdk.startSDK();
  console.log('SDK started');
  let connected = false;
  for (let i = 0; i < 30; i++) {
    try {
      const running = await IRacingSDK.IsSimRunning();
      if (running && !connected) {
        console.log(`[${i}] iRacing ESTÁ corriendo`);
        connected = true;
      } else if (!running) {
        console.log(`[${i}] iRacing NO está corriendo`);
      }
    } catch (e) {
      console.log(`[${i}] error:`, e.message);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  try { sdk.stopSDK(); } catch (_) {}
  process.exit(0);
})();
