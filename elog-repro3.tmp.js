const elog = require('electron-log/node');
const path = require('path');
const os = require('os');
const file = path.join(os.tmpdir(), 'elog-repro3.log');
try { require('fs').unlinkSync(file); } catch (_) {}
elog.transports.file.resolvePathFn = () => file;
const { formatLine, parseLine } = require('./src/main/log-format');
// EXACTAMENTE el format nuevo de logger.js:
elog.transports.file.format = ({ data, level, message }) => {
  const scope = (message && message.scope) || 'app';
  const date = (message && message.date instanceof Date) ? message.date : new Date();
  const text = (data || []).map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).join(' ');
  return [formatLine({ scope, level: level || (message && message.level) || 'info', date, text })];
};
elog.transports.console.level = false;
elog.scope('irsdk').info('conectado, recibiendo datos');
elog.scope('relative').warn('classPosition duplicada | {"dups":[["1",2]]}');
elog.info('sin scope');
const fs = require('fs');
const content = fs.readFileSync(file, 'utf8');
console.log(content);
const parsed = content.trim().split(/\r?\n/).map(parseLine);
console.log('PARSED OK:', parsed.every(Boolean), '| scopes:', JSON.stringify(parsed.map((p) => p && p.scope)));
process.exit(0);
