// tests/helpers/fakeLogger.js
// Логгер-заглушка: собирает сообщения, чтобы тест мог проверить, что и с каким уровнем записано.
'use strict';

function createFakeLogger() {
  const lines = { info: [], dev: [], error: [] };
  const join = (args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
  return {
    lines,
    logInfoMessage: jest.fn((...a) => lines.info.push(join(a))),
    logDevMessage: jest.fn((...a) => lines.dev.push(join(a))),
    logErrorMessage: jest.fn((...a) => lines.error.push(join(a))),
  };
}

module.exports = { createFakeLogger };
