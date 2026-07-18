const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const elog = require('electron-log/main');
const { formatLine, parseLine, createThrottle } = require('./log-format');

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB por archivo
const MAX_ARCHIVES = 5;           // main.log + main.1.log .. main.5.log

const throttle = createThrottle();
let _broadcast = null;
let _diagFn = () => false;
let _globalCaught = false;

function getLogDir() {
  return path.join(app.getPath('userData'), 'logs');
}
function getLogFilePath() {
  return path.join(getLogDir(), 'main.log');
}

// Rotación manual: main.log -> main.1.log, corriendo los viejos hacia arriba y
// descartando el que supere MAX_ARCHIVES. electron-log llama a esto al superar
// maxSize (le pasa el File del log actual).
function archiveLogFn(file) {
  try {
    const p = file.path || getLogFilePath();
    const dir = path.dirname(p);
    const base = path.basename(p, '.log');
    for (let i = MAX_ARCHIVES; i >= 1; i--) {
      const src = path.join(dir, `${base}.${i}.log`);
      if (i === MAX_ARCHIVES && fs.existsSync(src)) fs.unlinkSync(src);
      const prev = i === 1 ? p : path.join(dir, `${base}.${i - 1}.log`);
      if (fs.existsSync(prev)) fs.renameSync(prev, path.join(dir, `${base}.${i}.log`));
    }
  } catch (_) {}
}

function initLogger({ getDiagnosticMode } = {}) {
  if (typeof getDiagnosticMode === 'function') _diagFn = getDiagnosticMode;
  try { fs.mkdirSync(getLogDir(), { recursive: true }); } catch (_) {}

  elog.transports.file.resolvePathFn = () => getLogFilePath();
  elog.transports.file.maxSize = MAX_SIZE;
  elog.transports.file.archiveLogFn = archiveLogFn;
  // Formato del contrato (mismo que el parser). msg.data = args pasados a elog.
  elog.transports.file.format = (msg) => {
    const scope = msg.scope || 'app';
    const text = msg.data
      .map((d) => (typeof d === 'string' ? d : JSON.stringify(d)))
      .join(' ');
    return formatLine({ scope, level: msg.level, date: msg.date, text });
  };
  // Consola: solo en dev (útil al correr `npm run dev`).
  elog.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : false;
  applyDiagnosticLevel(_diagFn());

  // Captura global de errores no manejados en el main. Se registra ACÁ (después
  // de configurar el transport) para que salgan con el formato del contrato y
  // sean visibles en la pestaña Diagnóstico. Usamos nuestros propios handlers
  // en vez de elog.errorHandler.startCatching() para no duplicar el log.
  if (!_globalCaught) {
    _globalCaught = true;
    process.on('uncaughtException', (err) => {
      emit('main', 'error', `uncaughtException: ${oneLine((err && err.stack) || err)}`);
    });
    process.on('unhandledRejection', (reason) => {
      emit('main', 'error', `unhandledRejection: ${oneLine((reason && reason.stack) || reason)}`);
    });
  }
}

// Aplana un texto multilínea (ej. un stack trace) a una sola línea para que
// entre en el formato del contrato y se muestre completo en el visor (tanto en
// el tail cargado de archivo como en el vivo).
function oneLine(s) {
  return String(s).replace(/[\r\n]+/g, ' ⏎ ');
}

function applyDiagnosticLevel(diag) {
  elog.transports.file.level = diag ? 'debug' : 'info';
}

function setBroadcast(fn) { _broadcast = fn; }

function emit(scope, level, text) {
  const lvl = ['error', 'warn', 'info', 'debug'].includes(level) ? level : 'info';
  // debug solo se escribe si el nivel de archivo lo permite (modo diagnóstico).
  const scoped = elog.scope(scope);
  scoped[lvl](text);
  if (_broadcast) {
    // Reproducimos la línea para el tail en vivo (aunque debug no se persista,
    // no la reemitimos si el nivel está por debajo del umbral).
    if (lvl !== 'debug' || _diagFn()) {
      _broadcast(formatLine({ scope, level: lvl, date: new Date(), text }));
    }
  }
}

function _compose(msg, data) {
  if (data === undefined) return String(msg);
  try { return `${msg} | ${JSON.stringify(data)}`; }
  catch (_) { return `${msg} | [dato no serializable]`; }
}

function createLogger(scope) {
  return {
    info: (msg, data) => emit(scope, 'info', _compose(msg, data)),
    warn: (msg, data) => emit(scope, 'warn', _compose(msg, data)),
    error: (msg, data) => emit(scope, 'error', _compose(msg, data)),
    debug: (msg, data) => emit(scope, 'debug', _compose(msg, data)),
  };
}

function logThrottled(key, everyMs, scope, level, msg, data) {
  if (throttle.shouldLog(key, Date.now(), everyMs)) emit(scope, level, _compose(msg, data));
}
function logOnce(key, scope, level, msg, data) {
  if (throttle.shouldLog(key, Date.now(), Number.MAX_SAFE_INTEGER)) emit(scope, level, _compose(msg, data));
}

function getLogs({ limit = 500 } = {}) {
  try {
    const raw = fs.readFileSync(getLogFilePath(), 'utf-8');
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseLine(line);
      if (parsed) out.push(parsed);
    }
    return out.slice(-limit);
  } catch (_) {
    return [];
  }
}

module.exports = {
  initLogger, setBroadcast, emit, createLogger, logThrottled, logOnce,
  getLogs, getLogFilePath, getLogDir, applyDiagnosticLevel,
};
