// opcua/index.js
// OPC UA-сервер (node-opcua): модель здания и текущие значения тегов для внешних клиентов.
// Подробно — docs/opcua.md.
//
// createOpcUaServer({ model, tagStore, logger, options, authenticate, version })
//   options: { port, host, hostname, namespaceUri, allowInsecure, maxSessions, pkiDir }
//   authenticate(username, password) → Promise<boolean> — проверка пользователя
//     (userStore, этап 5). Не задана — вход по имени и паролю отклоняется.
//   version: { VERSION, COMMIT } из services/version.
// Возвращает { start, stop, status }.
//
// Безопасность (opcua/nodes.js, securitySettings): в рабочем режиме только Sign и
// SignAndEncrypt и вход по имени и паролю; allowInsecure добавляет None и анонимный вход.
// Сертификат сервера создаётся в <pkiDir>/own при первом запуске. Сертификат нового
// клиента попадает в <pkiDir>/rejected; доверие — перенос в trusted/certs
// (tools/opcuaPki.js). Каталог отслеживается, перезапуск не нужен.
'use strict';

const os = require('os');
const fs = require('fs');
const util = require('util');
const { X509Certificate } = require('crypto');
const opcua = require('node-opcua');
const { buildAddressSpace } = require('./addressSpace');
const { bindValues } = require('./values');
const { securitySettings } = require('./nodes');

const {
  OPCUAServer, OPCUACertificateManager, MessageSecurityMode, SecurityPolicy, UserTokenType,
  RegisterServerMethod, makeApplicationUrn, setWarningLogger, setErrorLogger,
} = opcua;

const PRODUCT_URI = 'urn:scada-bms';

// Отпечаток SHA-1 и CN сертификата (DER) — для сообщений о недоверенных клиентах
function certificateLabel(der) {
  try {
    const cert = new X509Certificate(der);
    const cn = (cert.subject.match(/CN=([^\n]+)/) || [])[1] || '?';
    return `${cn} [${cert.fingerprint.replace(/:/g, '').toLowerCase()}]`;
  } catch {
    return 'сертификат не разобран';
  }
}

function createOpcUaServer({ model, tagStore, logger, options, authenticate = null, version = {} }) {
  const opts = { port: 4840, host: '0.0.0.0', hostname: '', allowInsecure: false, maxSessions: 20, ...options };
  const hostname = opts.hostname || os.hostname();
  const security = securitySettings({ allowInsecure: opts.allowInsecure });
  let server = null;
  let certificateManager = null;
  let unbind = null;
  let variables = new Map();
  let namespaceIndex = null;
  const rejectedLogged = new Set();
  let noAuthLogged = false;

  async function checkUser(username, password) {
    if (!authenticate) {
      if (!noAuthLogged) {
        noAuthLogged = true;
        logger.logInfoMessage(`[OpcUa] - login - вход ${username} отклонён: пользователей пока нет (userStore — этап 5)`);
      }
      return false;
    }
    try {
      const ok = await authenticate(username, password);
      if (!ok) logger.logInfoMessage(`[OpcUa] - login - неверное имя или пароль: ${username}`);
      return Boolean(ok);
    } catch (err) {
      logger.logErrorMessage(`[OpcUa] - login - ошибка проверки ${username}:`, err);
      return false;
    }
  }

  // Сообщение о недоверенном сертификате клиента — один раз на сертификат
  function watchCertificates(cm) {
    const check = cm.checkCertificate.bind(cm);
    cm.checkCertificate = async (chain, ...rest) => {
      const status = await check(chain, ...rest);
      const der = Array.isArray(chain) ? chain[0] : chain;
      if (status && status.isNotGood && status.isNotGood()) {
        const label = certificateLabel(der);
        if (!rejectedLogged.has(label)) {
          rejectedLogged.add(label);
          logger.logInfoMessage(`[OpcUa] - certificate - клиент не допущен (${status.name}): ${label}. `
            + 'Доверие: node tools/opcuaPki.js trust');
        }
      }
      return status;
    };
  }

  // Собственный вывод node-opcua (console.log с цветами) — в наш логгер:
  // предупреждения на уровень dev, ошибки — error. Настройка общая для процесса
  function routeLibraryLogs() {
    const line = (ctx, args) => `[OpcUa] - node-opcua - ${ctx.filename}: ${util.format(...args)}`;
    setWarningLogger((ctx, ...args) => logger.logDevMessage(line(ctx, args)));
    setErrorLogger((ctx, ...args) => logger.logErrorMessage(line(ctx, args)));
  }

  async function start() {
    routeLibraryLogs();
    fs.mkdirSync(opts.pkiDir, { recursive: true });
    certificateManager = new OPCUACertificateManager({
      rootFolder: opts.pkiDir,
      automaticallyAcceptUnknownCertificate: false,
    });
    await certificateManager.initialize();
    watchCertificates(certificateManager);

    server = new OPCUAServer({
      port: opts.port,
      host: opts.host,
      hostname,
      serverCertificateManager: certificateManager,
      securityModes: security.modes.map((m) => MessageSecurityMode[m]),
      securityPolicies: security.policies.map((p) => SecurityPolicy[p]),
      allowAnonymous: security.allowAnonymous,
      userTokenTypes: security.userTokens.map((t) => UserTokenType[t]),
      // node-opcua ждёт колбэк (err, isAuthorized), а не промис
      userManager: {
        isValidUserAsync: (username, password, callback) => {
          checkUser(username, password).then((ok) => callback(null, ok), () => callback(null, false));
        },
      },
      registerServerMethod: RegisterServerMethod.HIDDEN,
      maxConnectionsPerEndpoint: opts.maxSessions,
      serverCapabilities: { maxSessions: opts.maxSessions },
      serverInfo: {
        applicationUri: makeApplicationUrn(hostname, 'scada-bms'),
        productUri: PRODUCT_URI,
        applicationName: { text: `SCADA BMS ${model.site.id}`, locale: 'ru' },
      },
      buildInfo: {
        productName: 'SCADA BMS',
        productUri: PRODUCT_URI,
        manufacturerName: 'SCADA BMS',
        softwareVersion: version.VERSION || '0',
        buildNumber: version.COMMIT || '',
      },
    });
    await server.initialize();

    const { addressSpace } = server.engine;
    const ns = addressSpace.registerNamespace(opts.namespaceUri);
    namespaceIndex = ns.index;
    const built = buildAddressSpace({ addressSpace, ns, model });
    variables = built.variables;
    unbind = bindValues({ variables, tagStore, logger });

    server.on('session_activated', (session) => {
      logger.logDevMessage(`[OpcUa] - session - открыта: ${session.sessionName || '?'}, `
        + `${session.userIdentityToken && session.userIdentityToken.userName ? `пользователь ${session.userIdentityToken.userName}` : 'анонимно'}`);
    });
    server.on('session_closed', (session) => {
      logger.logDevMessage(`[OpcUa] - session - закрыта: ${session.sessionName || '?'}`);
    });

    try {
      await server.start();
    } catch (err) {
      if (err.code === 'EADDRINUSE') throw new Error(`порт TCP ${opts.port} занят (OPCUA_PORT)`);
      throw err;
    }
    logger.logInfoMessage(`[OpcUa] - start - ${endpoints().join(', ')}; режимы ${security.modes.join(', ')}; `
      + `типов ${built.types}, установок ${built.instances}, переменных ${variables.size}, ns=${namespaceIndex} (${opts.namespaceUri})`);
    if (!authenticate && !opts.allowInsecure) {
      logger.logInfoMessage('[OpcUa] - start - пользователей пока нет (userStore — этап 5): вход по имени и паролю '
        + 'отклоняется, для проверки клиентом — OPCUA_ALLOW_INSECURE=true');
    }
    if (opts.allowInsecure) {
      logger.logErrorMessage('[OpcUa] - start - ВНИМАНИЕ: OPCUA_ALLOW_INSECURE=true — разрешены режим None '
        + 'и анонимный вход. Только для разработки, не для объекта');
    }
  }

  function endpoints() {
    if (!server) return [];
    return [...new Set(server.endpoints.flatMap((e) => e.endpointDescriptions().map((d) => d.endpointUrl)))];
  }

  async function stop() {
    if (unbind) unbind();
    unbind = null;
    if (server) await server.shutdown(0);
    server = null;
    if (certificateManager) await certificateManager.dispose();
    certificateManager = null;
  }

  function status() {
    return {
      running: Boolean(server),
      endpoints: endpoints(),
      namespaceIndex,
      variables: variables.size,
      sessions: server ? server.currentSessionCount : 0,
      subscriptions: server ? server.currentSubscriptionCount : 0,
    };
  }

  return { start, stop, status };
}

module.exports = { createOpcUaServer, certificateLabel };
