// server.js
// Точка входа: читает настройки, собирает сервисы, запускает их и корректно
// останавливает по сигналу. Бизнес-логики не содержит.
// Сервисы добавляются в lifecycle по этапам плана (PLAN.md) в порядке запуска:
// БД → драйверы → шлюз команд → тревоги и архив → OPC UA → WebSocket.
// Остановка — в обратном порядке: OPC UA, шлюз (команды больше не принимаются), драйверы, БД.
'use strict';

const logger = require('./services/logger');
const { loadConfig } = require('./services/config');
const version = require('./services/version');
const { createLifecycle } = require('./services/lifecycle');
const { installProcessHandlers } = require('./services/processHandlers');
const { loadModel, reportModel } = require('./core/modelLoader');
const { createTagStore } = require('./core/tagStore');
const { createModbusTcpDriver } = require('./drivers/modbusTcp');
const { createBacnetIpDriver } = require('./drivers/bacnetIp');
const { createDb } = require('./storage/db');
const { createUserStore } = require('./services/userStore');
const { createAuthService } = require('./services/auth');
const { createJournal } = require('./services/journal');
const { createCommandGateway } = require('./services/commandGateway');

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

  // Модель объекта: без site.json сервер не запускается, ошибочные установки отключаются
  let model;
  try {
    model = loadModel({ dir: config.configDir });
  } catch (err) {
    logger.logErrorMessage('[Server] - main - модель не загружена:', err);
    process.exitCode = 1;
    return;
  }
  reportModel(model, logger);
  // Текущие значения тегов: драйверы пишут, OPC UA (и позже WebSocket) читают
  const tagStore = createTagStore({ tags: model.tags, logger });

  const lifecycle = createLifecycle({ logger, timeoutMs: config.shutdownTimeoutMs });
  installProcessHandlers({ lifecycle, logger });

  // БД: пользователи и журнал. Без PG_URL — без пользователей, журнал только в логе
  let db = null;
  if (!config.pgUrl) {
    logger.logInfoMessage('[Server] - main - PostgreSQL не задан (PG_URL): пользователей нет, журнал только в логе');
  } else {
    db = createDb({ url: config.pgUrl, poolMax: config.pgPoolMax, logger });
    lifecycle.add('db', db);
  }
  const userStore = db ? createUserStore({ db, logger, bcryptRounds: config.bcryptRounds }) : null;
  const auth = createAuthService({ userStore, logger, maxFailures: config.authMaxFailures, lockMs: config.authLockMs });
  const journal = createJournal({ db, logger });
  const drivers = new Map();

  const tagsOf = (driver) => [...model.tags.values()].filter((t) => t.source.driver === driver);
  const modbusTags = tagsOf('modbus');
  if (!config.modbusEnabled) {
    logger.logInfoMessage(`[Server] - main - Modbus TCP выключен (MODBUS_ENABLED=false), тегов без опроса: ${modbusTags.length}`);
  } else if (modbusTags.length) {
    drivers.set('modbus', createModbusTcpDriver({
      tags: modbusTags,
      tagStore,
      logger,
      options: {
        pollMs: config.modbusPollMs,
        timeoutMs: config.modbusTimeoutMs,
        connectTimeoutMs: config.modbusConnectTimeoutMs,
        failLimit: config.modbusFailLimit,
        maxGap: config.modbusMaxGap,
        reconnectMaxMs: config.reconnectMaxMs,
      },
    }));
    lifecycle.add('modbus', drivers.get('modbus'));
  }

  const bacnetTags = tagsOf('bacnet');
  if (!config.bacnetEnabled) {
    logger.logInfoMessage(`[Server] - main - BACnet выключен (BACNET_ENABLED=false), тегов без опроса: ${bacnetTags.length}`);
  } else if (bacnetTags.length) {
    drivers.set('bacnet', createBacnetIpDriver({
      tags: bacnetTags,
      tagStore,
      logger,
      options: {
        port: config.bacnetPort,
        iface: config.bacnetInterface,
        broadcastAddress: config.bacnetBroadcastAddress,
        apduTimeoutMs: config.bacnetApduTimeoutMs,
        pollMs: config.bacnetPollMs,
        failLimit: config.bacnetFailLimit,
        cov: config.bacnetCov,
        covLifetimeS: config.bacnetCovLifetimeS,
        writePriority: config.bacnetWritePriority,
        maxObjects: config.bacnetMaxObjects,
        reconnectMaxMs: config.reconnectMaxMs,
      },
    }));
    lifecycle.add('bacnet', drivers.get('bacnet'));
  }

  // Единый путь записи. После драйверов: при остановке сначала перестаёт принимать команды
  const gateway = createCommandGateway({ tagStore, drivers, journal, logger });
  lifecycle.add('commands', gateway);

  // OPC UA — после драйверов: при остановке он закрывается первым
  if (!config.opcuaEnabled) {
    logger.logInfoMessage('[Server] - main - OPC UA выключен (OPCUA_ENABLED=false)');
  } else {
    // node-opcua загружается ~1,5 с, поэтому только когда OPC UA включён
    const { createOpcUaServer } = require('./opcua');
    lifecycle.add('opcua', createOpcUaServer({
      model,
      tagStore,
      logger,
      version,
      auth,
      gateway,
      options: {
        port: config.opcuaPort,
        host: config.opcuaInterface,
        hostname: config.opcuaHostname,
        namespaceUri: config.opcuaNamespaceUri,
        allowInsecure: config.opcuaAllowInsecure,
        maxSessions: config.opcuaMaxSessions,
        pkiDir: config.pkiDir,
      },
    }));
  }

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
