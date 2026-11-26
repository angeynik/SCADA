// storage/db.js
// Подключение к PostgreSQL: пул (pg), миграции, уведомления LISTEN/NOTIFY.
//
// createDb({ url, poolMax, logger, migrationsDir })
//   url — PG_URL без пароля: пароль берётся из PGPASSWORD или ~/.pgpass (так его нет
//         в conf.env и в логе).
// Возвращает { start, stop, query, transaction, listen, notify, where }.
//   start() — проверка подключения и миграции; ошибка — исключение (сервер не запускается).
//   query(text, params) — параметризованный запрос (только так: SQL из данных не собирается).
//   transaction(fn) — fn(client) в BEGIN … COMMIT, при исключении ROLLBACK.
//   listen(channel, fn) — уведомления канала; отдельное соединение, после обрыва
//     переподключается с нарастающей паузой.
// Во время работы обрыв связи с БД не роняет процесс: запрос получает ошибку, пул
// создаёт новое соединение при следующем запросе.
'use strict';

const path = require('path');
const { Pool, Client } = require('pg');
const { migrate } = require('./migrate');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const CHANNEL_RE = /^[a-z_][a-z0-9_]{0,62}$/;

// URL без логина и пароля — для лога
function describeUrl(url) {
  try {
    const u = new URL(url);
    const socket = u.searchParams.get('host');
    if (!u.hostname && socket) return `${socket}${u.pathname}`;
    return `${u.hostname || 'localhost'}:${u.port || 5432}${u.pathname}`;
  } catch {
    return 'PG_URL';
  }
}

function createDb({ url, poolMax = 10, logger, migrationsDir = MIGRATIONS_DIR, timers = { setTimeout, clearTimeout } }) {
  const where = describeUrl(url);
  const pool = new Pool({ connectionString: url, max: poolMax, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  // Ошибка простаивающего соединения (перезапуск БД) — не исключение процесса
  pool.on('error', (err) => logger.logErrorMessage(`[Db] - pool - ${where}:`, err.message));

  const listeners = new Map(); // channel → Set(fn)
  let listenClient = null;
  let listenTimer = null;
  let listenDelay = 1000;
  let stopped = false;
  let started = false;

  const query = (text, params) => pool.query(text, params);

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function connectListener() {
    listenTimer = null;
    if (stopped || !listeners.size) return;
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    client.on('error', () => {}); // обрыв обрабатывается в 'end'
    client.on('notification', (msg) => {
      for (const fn of listeners.get(msg.channel) || []) {
        try {
          fn(msg.payload);
        } catch (err) {
          logger.logErrorMessage(`[Db] - listen - ошибка обработчика ${msg.channel}:`, err);
        }
      }
    });
    client.on('end', () => {
      if (listenClient !== client) return;
      listenClient = null;
      if (stopped) return;
      logger.logErrorMessage(`[Db] - listen - соединение для уведомлений потеряно, повтор через ${listenDelay} мс`);
      scheduleListener();
    });
    try {
      await client.connect();
      for (const channel of listeners.keys()) await client.query(`LISTEN ${channel}`);
      listenClient = client;
      listenDelay = 1000;
      // Пока соединения не было, уведомления могли потеряться: подписчики перечитывают состояние
      for (const [channel, fns] of listeners) for (const fn of fns) fn(null, { reconnected: true, channel });
    } catch (err) {
      await client.end().catch(() => {});
      if (stopped) return;
      logger.logErrorMessage(`[Db] - listen - ${where}: ${err.message}, повтор через ${listenDelay} мс`);
      scheduleListener();
    }
  }

  function scheduleListener() {
    if (listenTimer || stopped) return;
    listenTimer = timers.setTimeout(connectListener, listenDelay);
    listenDelay = Math.min(listenDelay * 2, 30000);
  }

  // Подписка на канал. fn(payload) — payload строкой; fn(null, { reconnected }) — после
  // восстановления соединения. Возвращает функцию отписки.
  function listen(channel, fn) {
    if (!CHANNEL_RE.test(channel)) throw new Error(`недопустимое имя канала ${channel}`);
    const isNew = !listeners.has(channel);
    if (isNew) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    // До start() подписка только запоминается: соединение откроет start
    if (listenClient && isNew) listenClient.query(`LISTEN ${channel}`).catch(() => {});
    else if (started && !listenClient && !listenTimer && !stopped) listenTimer = timers.setTimeout(connectListener, 0);
    return () => listeners.get(channel) && listeners.get(channel).delete(fn);
  }

  // pg_notify — параметризованно, в любом соединении (в т. ч. в транзакции)
  const notify = (channel, payload, client = pool) => client.query('SELECT pg_notify($1, $2)', [channel, String(payload)]);

  async function start() {
    stopped = false;
    try {
      await pool.query('SELECT 1');
    } catch (err) {
      throw new Error(`нет подключения к PostgreSQL ${where}: ${err.message}`);
    }
    const applied = await migrate({ pool, dir: migrationsDir, logger });
    logger.logInfoMessage(`[Db] - start - PostgreSQL ${where}, миграций применено: ${applied.length}`);
    started = true;
    if (listeners.size) await connectListener();
  }

  async function stop() {
    stopped = true;
    started = false;
    if (listenTimer) timers.clearTimeout(listenTimer);
    listenTimer = null;
    const lc = listenClient;
    listenClient = null;
    if (lc) await lc.end().catch(() => {});
    await pool.end();
  }

  return { start, stop, query, transaction, listen, notify, where };
}

module.exports = { createDb, describeUrl, MIGRATIONS_DIR };
