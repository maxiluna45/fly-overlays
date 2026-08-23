const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSessionInfo } = require('../src/main/session-parser');

// Regresión: un piloto con nombre "? ?" (u otros caracteres especiales) rompía el
// parser YAML de iRacing. El saneo debe permitir parsear igual.
test('parseSessionInfo tolera UserName con caracteres que rompen YAML', () => {
  const yaml = [
    'DriverInfo:',
    ' Drivers:',
    ' - CarIdx: 0',
    '   UserName: ? ?',
    '   TeamName: Team: A',
    '   AbbrevName: O\'Neil, S',
    ' - CarIdx: 1',
    '   UserName: José',
    'WeekendInfo:',
    ' TrackName: spa gp',
    '',
  ].join('\n');
  const parsed = parseSessionInfo(yaml);
  assert.ok(parsed, 'debe parsear (no null)');
  assert.equal(parsed.DriverInfo.Drivers.length, 2);
  assert.equal(parsed.DriverInfo.Drivers[0].UserName, '? ?');
  assert.equal(parsed.DriverInfo.Drivers[0].TeamName, 'Team: A');
  assert.equal(parsed.DriverInfo.Drivers[0].AbbrevName, "O'Neil, S");
  assert.equal(parsed.DriverInfo.Drivers[1].UserName, 'José');
  assert.equal(parsed.WeekendInfo.TrackName, 'spa gp');
});

// YAML válido normal no debe verse afectado (no se saltea al camino de saneo).
test('parseSessionInfo parsea YAML bien formado sin tocarlo', () => {
  const parsed = parseSessionInfo('WeekendInfo:\n TrackLength: 7.004 km\n TrackID: 219\n');
  assert.equal(parsed.WeekendInfo.TrackID, 219);
});

test('getTrackInfo lee TrackNorthOffset del YAML', () => {
  const { getTrackInfo, parseNorthOffset } = require('../src/main/session-parser.js');
  assert.equal(parseNorthOffset('1.6113 rad'), 1.6113);
  assert.equal(parseNorthOffset(0.4107), 0.4107);
  assert.equal(parseNorthOffset(null), null);
  assert.equal(parseNorthOffset('unlimited'), null);
  const ti = getTrackInfo({ WeekendInfo: { TrackDisplayName: 'Spa', TrackLength: '7.00 km', TrackNorthOffset: '1.6113 rad' } });
  assert.equal(ti.northOffset, 1.6113);
  assert.equal(getTrackInfo(null).northOffset, null);
});
