// server.js
// Точка входа: читает настройки, собирает сервисы, запускает их и корректно
// останавливает по сигналу. Бизнес-логики не содержит.
// Сервисы добавляются в lifecycle по этапам плана (PLAN.md) в порядке запуска:
// хранилище → модель → драйверы → тревоги и архив → OPC UA → WebSocket.
'use strict';

const logger = require('./services/logger');
const { loadConfig } = require('./services/config');
const version = require('./services/version');
const { createLifecycle } = require('./services/lifecycle');
const { installProcessHandlers } = require('./services/processHandlers');

async function main() {
  let loaded;
  try {
    loaded = loadConfig();
  } catch (err) {
    logger.logErrorMessage('[Server] - main -', err);
    process.exitCode = 1;
    return;
  }
  const { config, overrides, envFile } = loaded;
  logger.initLogging(config.logLevel);

  logger.logInfoMessage(`[Server] - main - версия ${version.LABEL}, Node.js ${process.version}`);
  logger.logInfoMessage(`[Server] - main - настройки: ${envFile || 'conf.env не найден, значения по умолчанию'}`);
  if (overrides.length) {
    logger.logInfoMessage(`[Server] - main - окружение перекрывает conf.env: ${overrides.join(', ')}`);
  }

  const lifecycle = createLifecycle({ logger, timeoutMs: config.shutdownTimeoutMs });
  installProcessHandlers({ lifecycle, logger });

  try {
    await lifecycle.start();
  } catch (err) {
    logger.logErrorMessage('[Server] - main - сервер не запущен:', err);
    process.exitCode = 1;
    return;
  }
  if (lifecycle.state() === 'running') {
    logger.logInfoMessage(`[Server] - main - сервер запущен (pid ${process.pid})`);
  }
}

main();
