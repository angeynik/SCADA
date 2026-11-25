// services/config.js
// Единственное место чтения настроек сервера.
// Источники: файл conf.env (dotenv) и переменные окружения. Переменная окружения
// перекрывает значение из файла; имена перекрытых переменных возвращаются в
// `overrides`, server.js пишет их в лог (значения не пишутся — это могут быть секреты).
// Путь к файлу: CONF_ENV_FILE из окружения, иначе conf.env рядом с server.js
// (не от текущего каталога: systemd и cron запускают процесс из другого места).
// Отсутствующий параметр получает значение по умолчанию, недопустимый — ошибку
// при старте: лучше не запуститься, чем работать с непонятной настройкой.
//
// Новый параметр: описать в SCHEMA, задать значение по умолчанию,
// добавить в conf.env.example.
'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { LEVEL_NAMES } = require('./logger');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ENV_FILE = path.join(ROOT, 'conf.env');

// ── Разбор значений ──────────────────────────────────────────────────────
function parseInt10(name, raw, { min, max }) {
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`${name}: ожидается целое число, получено "${raw}"`);
  const n = Number(text);
  if (n < min || n > max) throw new Error(`${name}: допустимо от ${min} до ${max}, получено ${n}`);
  return n;
}

function parseEnum(name, raw, values) {
  const v = String(raw).trim().toLowerCase();
  if (!values.includes(v)) throw new Error(`${name}: допустимо ${values.join(' | ')}, получено "${raw}"`);
  return v;
}

function parseBool(name, raw) {
  const v = String(raw).trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`${name}: допустимо true | false, получено "${raw}"`);
}

const int = (min, max) => (n, v) => parseInt10(n, v, { min, max });

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function parseIPv4(name, raw) {
  const v = String(raw).trim();
  if (!IPV4_RE.test(v)) throw new Error(`${name}: ожидается адрес IPv4, получено "${raw}"`);
  return v;
}

// Адрес IPv4 с необязательным портом: 192.168.1.255 или 192.168.1.255:47808
function parseHostPort(name, raw) {
  const v = String(raw).trim();
  const [host, port, extra] = v.split(':');
  const portOk = port === undefined || (/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535);
  if (extra !== undefined || !IPV4_RE.test(host) || !portOk) {
    throw new Error(`${name}: ожидается адрес IPv4[:порт], получено "${raw}"`);
  }
  return v;
}

// Имя узла DNS или IPv4 (для адреса OPC UA в сертификате и описании точек входа).
// Пустое значение — имя машины
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function parseHostname(name, raw) {
  const v = String(raw).trim();
  if (v && !HOSTNAME_RE.test(v)) throw new Error(`${name}: ожидается имя узла или адрес IPv4, получено "${raw}"`);
  return v;
}

// URI пространства имён: схема и непустая часть без пробелов (urn:..., http://...)
function parseUri(name, raw) {
  const v = String(raw).trim();
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(v)) throw new Error(`${name}: ожидается URI (например urn:scada-bms:model), получено "${raw}"`);
  return v;
}

// Относительный путь считается от каталога сервера
function parsePath(name, raw) {
  const v = String(raw).trim();
  if (!v) throw new Error(`${name}: пустой путь`);
  return path.resolve(ROOT, v);
}

// ── Параметры ────────────────────────────────────────────────────────────
// key — имя в объекте config, env — имя переменной, def — значение по умолчанию (строкой,
// разбирается так же, как значение из файла)
const SCHEMA = [
  { key: 'logLevel', env: 'LOG_LEVEL', def: 'info', parse: (n, v) => parseEnum(n, v, LEVEL_NAMES) },
  { key: 'dataDir', env: 'DATA_DIR', def: 'data', parse: parsePath },
  // Конфигурация объекта (шаблоны, карты, установки). Образец — config/example
  { key: 'configDir', env: 'CONFIG_DIR', def: 'data/config', parse: parsePath },
  {
    key: 'shutdownTimeoutMs',
    env: 'SHUTDOWN_TIMEOUT_MS',
    def: '10000',
    parse: (n, v) => parseInt10(n, v, { min: 1000, max: 120000 }),
  },
  // Пауза переподключения драйверов растёт от 1 с до этого значения
  { key: 'reconnectMaxMs', env: 'RECONNECT_MAX_MS', def: '30000', parse: int(1000, 600000) },
  // Modbus TCP (docs/modbus-tcp.md)
  { key: 'modbusEnabled', env: 'MODBUS_ENABLED', def: 'true', parse: parseBool },
  { key: 'modbusPollMs', env: 'MODBUS_POLL_MS', def: '1000', parse: int(100, 60000) },
  { key: 'modbusTimeoutMs', env: 'MODBUS_TIMEOUT_MS', def: '1000', parse: int(100, 30000) },
  { key: 'modbusConnectTimeoutMs', env: 'MODBUS_CONNECT_TIMEOUT_MS', def: '3000', parse: int(100, 60000) },
  { key: 'modbusFailLimit', env: 'MODBUS_FAIL_LIMIT', def: '3', parse: int(1, 20) },
  { key: 'modbusMaxGap', env: 'MODBUS_MAX_GAP', def: '4', parse: int(0, 100) },
  // BACnet/IP (docs/bacnet.md)
  { key: 'bacnetEnabled', env: 'BACNET_ENABLED', def: 'true', parse: parseBool },
  { key: 'bacnetPort', env: 'BACNET_PORT', def: '47808', parse: int(1, 65535) },
  { key: 'bacnetInterface', env: 'BACNET_INTERFACE', def: '0.0.0.0', parse: parseIPv4 },
  { key: 'bacnetBroadcastAddress', env: 'BACNET_BROADCAST_ADDRESS', def: '255.255.255.255', parse: parseHostPort },
  { key: 'bacnetApduTimeoutMs', env: 'BACNET_APDU_TIMEOUT_MS', def: '3000', parse: int(200, 30000) },
  { key: 'bacnetPollMs', env: 'BACNET_POLL_MS', def: '2000', parse: int(200, 600000) },
  { key: 'bacnetFailLimit', env: 'BACNET_FAIL_LIMIT', def: '3', parse: int(1, 20) },
  { key: 'bacnetCov', env: 'BACNET_COV', def: 'true', parse: parseBool },
  { key: 'bacnetCovLifetimeS', env: 'BACNET_COV_LIFETIME_S', def: '300', parse: int(60, 28800) },
  // Приоритет записи по умолчанию; 1–7 (жизнеобеспечение, критичное оборудование) недопустимы
  { key: 'bacnetWritePriority', env: 'BACNET_WRITE_PRIORITY', def: '8', parse: int(8, 16) },
  { key: 'bacnetMaxObjects', env: 'BACNET_MAX_OBJECTS', def: '20', parse: int(1, 100) },
  // OPC UA (docs/opcua.md)
  { key: 'opcuaEnabled', env: 'OPCUA_ENABLED', def: 'true', parse: parseBool },
  { key: 'opcuaPort', env: 'OPCUA_PORT', def: '4840', parse: int(1, 65535) },
  // Интерфейс сети клиентов; 0.0.0.0 — все интерфейсы
  { key: 'opcuaInterface', env: 'OPCUA_INTERFACE', def: '0.0.0.0', parse: parseIPv4 },
  { key: 'opcuaHostname', env: 'OPCUA_HOSTNAME', def: '', parse: parseHostname },
  { key: 'opcuaNamespaceUri', env: 'OPCUA_NAMESPACE_URI', def: 'urn:scada-bms:model', parse: parseUri },
  // Режим None и анонимный вход — только для разработки
  { key: 'opcuaAllowInsecure', env: 'OPCUA_ALLOW_INSECURE', def: 'false', parse: parseBool },
  { key: 'opcuaMaxSessions', env: 'OPCUA_MAX_SESSIONS', def: '20', parse: int(1, 500) },
  // Сертификаты OPC UA: свой, доверенные и отклонённые клиенты
  { key: 'pkiDir', env: 'PKI_DIR', def: 'pki', parse: parsePath },
];

function readEnvFile(file) {
  try {
    return dotenv.parse(fs.readFileSync(file));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`не удалось прочитать ${file}: ${err.message}`);
  }
}

// Возвращает { config, overrides, envFile }. envFile — путь к прочитанному файлу или null,
// если файла нет. Ошибки всех параметров собираются в одно исключение.
function loadConfig({ env = process.env } = {}) {
  const file = env.CONF_ENV_FILE ? path.resolve(env.CONF_ENV_FILE) : DEFAULT_ENV_FILE;
  const fromFile = readEnvFile(file);
  const fileVars = fromFile || {};

  const config = {};
  const overrides = [];
  const errors = [];

  for (const { key, env: name, def, parse } of SCHEMA) {
    const inEnv = env[name] !== undefined && env[name] !== '';
    const inFile = fileVars[name] !== undefined && fileVars[name] !== '';
    if (inEnv && inFile && env[name] !== fileVars[name]) overrides.push(name);
    const raw = inEnv ? env[name] : inFile ? fileVars[name] : def;
    try {
      config[key] = parse(name, raw);
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (errors.length) throw new Error(`ошибка настроек: ${errors.join('; ')}`);
  return { config: Object.freeze(config), overrides, envFile: fromFile ? file : null };
}

module.exports = { loadConfig, ROOT, DEFAULT_ENV_FILE };
