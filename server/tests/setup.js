// tests/setup.js
// Общая подготовка Jest (setupFilesAfterEnv): тихий лог и тестовые настройки.
// Глобальных моков здесь нет: каждый тест сам подменяет то, что ему нужно,
// и использует временные каталоги в os.tmpdir().
'use strict';

const os = require('os');
const path = require('path');

process.env.LOG_LEVEL = 'none';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.DATA_DIR = path.join(os.tmpdir(), `scada-test-data-${process.pid}`);

jest.setTimeout(20000);
