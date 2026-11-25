'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/tests/unit/**/*.test.js',
    '**/tests/integration/**/*.integration.js',
  ],
  collectCoverageFrom: [
    'server.js',
    'services/**/*.js',
    'core/**/*.js',
    'drivers/**/*.js',
    'opcua/**/*.js',
    'ws/**/*.js',
    'storage/**/*.js',
  ],
  coverageDirectory: 'coverage',
  // Тихий лог и тестовые настройки; глобальных моков нет
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  // История вызовов моков очищается перед каждым тестом (реализации сохраняются)
  clearMocks: true,
  testPathIgnorePatterns: ['/node_modules/', '/coverage/'],
};
