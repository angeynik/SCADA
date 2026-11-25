'use strict';

const { CODES, checkQuality, toOpcUaStatus } = require('../../core/quality');

describe('quality', () => {
  test('допустимые пары', () => {
    expect(checkQuality('good', null)).toBeNull();
    expect(checkQuality('bad', 'COMM_ERROR')).toBeNull();
    expect(checkQuality('uncertain', 'STALE')).toBeNull();
  });

  test.each([
    ['good', 'COMM_ERROR', /у качества good не бывает кода/],
    ['bad', 'STALE', /STALE допустим только с качеством uncertain/],
    ['bad', 'NOPE', /неизвестный код/],
    ['bad', undefined, /неизвестный код/],
    ['ok', null, /неизвестное качество/],
  ])('%s / %s — ошибка', (q, c, re) => {
    expect(checkQuality(q, c)).toMatch(re);
  });

  test('каждый код отображается в StatusCode OPC UA', () => {
    expect(toOpcUaStatus('good', null)).toBe('Good');
    for (const [code, q] of Object.entries(CODES)) {
      expect(toOpcUaStatus(q, code)).toMatch(q === 'bad' ? /^Bad/ : /^Uncertain/);
    }
  });
});
