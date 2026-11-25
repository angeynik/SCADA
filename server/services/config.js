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
