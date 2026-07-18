const elog = require('electron-log/node');
const path = require('path');
const os = require('os');
const file = path.join(os.tmpdir(), 'elog-repro2.log');
try { require('fs').unlinkSync(file); } catch (_) {}
elog.transports.file.resolvePathFn = () => file;
// El format NUEVO (firma v5, como quedó en logger.js):
function formatLine({ scope, level, date, text }) {
  const iso = (date instanceof Date ? date : new Date(date)).toISOString();
  return `[${iso}] [${String(level || 'info').toUpperCase()}] [${scope || 'app'}] ${text}`;
}
elog.transports.file.format = ({ data, level, message }) => {
  const scope = (message && message.scope) || 'app';
  const date = (message && message.date instanceof Date) ? message.date : new Date();
  const text = (data || []).map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).join(' ');
  return formatLine({ scope, level: level || (message && message.level) || 'info', date, text });
};
elog.transports.console.level = false;
elog.scope('irsdk').info('conectado, recibiendo datos');
elog.scope('relative').warn('classPosition duplicada | {"dups":[["1",2]]}');
elog.info('sin scope');
const fs = require('fs');
const content = fs.readFileSync(file, 'utf8');
console.log('FILE CONTENT:');
console.log(content);
// Validar contra el parser real del proyecto:
const { parseLine } = require('./src/main/log-format');
const lines = content.trim().split(/\r?\n/);
const parsed = lines.map(parseLine);
console.log('PARSED OK:', parsed.every(Boolean), JSON.stringify(parsed.map((p) => p && p.scope)));
