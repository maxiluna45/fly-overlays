// Funciones puras del sistema de logging. SIN dependencias de Electron para
// poder testearlas con `node --test`. El resto del logging (archivo, IPC) se
// apoya en estas funciones.

// Contrato de línea: [ISO8601] [LEVEL] [scope] texto
function formatLine({ scope, level, date, text }) {
  const iso = (date instanceof Date ? date : new Date(date)).toISOString();
  const lvl = String(level || 'info').toUpperCase();
  const scp = scope || 'app';
  return `[${iso}] [${lvl}] [${scp}] ${text}`;
}

const LINE_RE = /^\[([^\]]+)\] \[([A-Z]+)\] \[([^\]]+)\] ([\s\S]*)$/;

function parseLine(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(LINE_RE);
  if (!m) return null;
  return { ts: m[1], level: m[2], scope: m[3], text: m[4] };
}

// Rate-limiter por key: primera vez siempre pasa; luego cada `everyMs`.
function createThrottle() {
  const last = new Map();
  return {
    shouldLog(key, nowMs, everyMs) {
      const prev = last.get(key);
      if (prev == null || nowMs - prev >= everyMs) {
        last.set(key, nowMs);
        return true;
      }
      return false;
    },
  };
}

module.exports = { formatLine, parseLine, createThrottle };
