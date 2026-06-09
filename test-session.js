// Dump completo del SessionInfo YAML para descubrir dónde están los splits
const { IRacingSDK } = require('irsdk-node');

(async () => {
  if (!(await IRacingSDK.IsSimRunning())) {
    console.log('Abrí iRacing y entrá a una sesión');
    process.exit(1);
  }

  const sdk = new IRacingSDK({ autoEnableTelemetry: true });
  sdk.startSDK();

  if (!sdk.waitForData(5000)) {
    console.log('Sin datos');
    process.exit(1);
  }

  const yamlString = sdk.getSessionData();

  // Mostrar las primeras 2000 chars para ver la estructura
  console.log('===== SESSION INFO (primeros 3000 chars) =====');
  console.log(yamlString.substring(0, 3000));
  console.log('\n===== BUSCANDO "Sector" =====');

  const lines = yamlString.split('\n');
  lines.forEach((line, i) => {
    if (line.match(/[Ss]ector|[Ss]plit|[Cc]heckpoint|[Ss]plitTime/)) {
      console.log(`  L${i}: ${line}`);
    }
  });

  console.log('\n===== BUSCANDO "TrackLength", "TrackName" =====');
  lines.forEach((line, i) => {
    if (line.match(/TrackName|TrackLength|TrackConfig/)) {
      console.log(`  L${i}: ${line}`);
    }
  });

  // Probar nuestro parser
  const { parseSessionInfo, getSectorPoints, getTrackInfo } = require('./src/main/session-parser');
  const parsed = parseSessionInfo(yamlString);
  console.log('\n===== PARSER OUTPUT =====');
  console.log('TrackInfo:', getTrackInfo(parsed));
  console.log('SectorPoints:', getSectorPoints(parsed));

  sdk.stopSDK();
  process.exit(0);
})();
