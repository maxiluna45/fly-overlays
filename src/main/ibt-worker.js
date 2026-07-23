// Worker thread para parsear un .ibt COMPLETO fuera del hilo principal.
// parseIbtSession lee el archivo entero (hasta 300MB) y recorre cientos de miles
// de muestras en un bucle síncrono; hacerlo en el main congelaba la UI y los
// overlays al abrir una sesión desde Análisis. Acá corre aislado y devuelve la
// sesión ya parseada por postMessage (structured clone).
const { parentPort, workerData } = require('worker_threads');
const { parseIbtSession } = require('./ibt-parser');

try {
  const session = parseIbtSession(workerData.filePath);
  parentPort.postMessage({ ok: true, session });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
