// services/logger.js
// Единый логгер сервера. Уровень задаёт LOG_LEVEL:
//   error — только ошибки;
//   info  — ошибки и информационные сообщения (по умолчанию);
//   dev   — всё, включая отладочные сообщения;
//   none  — ничего (для тестов, задаётся в tests/setup.js).
// Каждый уровень включает все более важные, поэтому вне тестов ошибки пишутся всегда.
// Формат сообщения: `[Модуль] - функция - сообщение`. Функции принимают несколько
// аргументов: строки выводятся как есть, Error — своим message, остальное — через
// util.inspect в одну строку.
'use strict';

const util = require('util');

const LEVELS = {
  none: { error: false, info: false, dev: false },
  error: { error: true, info: false, dev: false },
  info: { error: true, info: true, dev: false },
  dev: { error: true, info: true, dev: true },
};

let flags = LEVELS.info;

// Уровень берётся из аргумента, иначе из окружения. Неизвестное значение работает как 'info'.
// До загрузки конфигурации логгер уже работает по LOG_LEVEL окружения, после —
// server.js вызывает initLogging(config.logLevel).
function initLogging(level = process.env.LOG_LEVEL) {
  const name = String(level || 'info').trim().toLowerCase();
  flags = LEVELS[name] || LEVELS.info;
}

function format(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message;
      return util.inspect(a, { depth: 4, breakLength: Infinity });
    })
    .join(' ');
}

// Канал вывода может закрыться (например, `node server.js | tee …`, и читающая программа
// завершилась). Ошибка записи (EPIPE) без обработчика стала бы uncaughtException, а его
// запись в тот же канал — новой ошибкой: процесс зациклился бы. Поэтому ошибка канала
// только отключает запись в него.
const broken = new Set();

function guard(stream) {
  stream.on('error', () => broken.add(stream));
}
guard(process.stdout);
guard(process.stderr);

function write(stream, text) {
  if (broken.has(stream)) return;
  try {
    stream.write(text);
  } catch {
    broken.add(stream);
  }
}

function logInfoMessage(...args) {
  if (flags.info) write(process.stdout, `${format(args)}\n`);
}

function logDevMessage(...args) {
  if (flags.dev) write(process.stdout, `[DEV] ${format(args)}\n`);
}

function logErrorMessage(...args) {
  if (flags.error) write(process.stderr, `[ERROR] ${format(args)}\n`);
}

// Маскирует значения секретных полей в сыром JSON (входящие сообщения клиентов)
const SECRET_RE = /("(?:password|oldPassword|newPassword|token)"\s*:\s*")(?:[^"\\]|\\.)*(")/g;

function redactSecrets(text) {
  return String(text).replace(SECRET_RE, '$1***$2');
}

initLogging();

module.exports = {
  LEVEL_NAMES: Object.keys(LEVELS),
  initLogging,
  logInfoMessage,
  logDevMessage,
  logErrorMessage,
  redactSecrets,
};
