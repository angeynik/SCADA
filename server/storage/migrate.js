// storage/migrate.js
// Миграции схемы: файлы storage/migrations/NNN_имя.sql применяются по номеру, только
// вперёд, каждая в своей транзакции. Применённые записываются в schema_migrations.
// Одновременный запуск двух узлов разводится рекомендательной блокировкой: второй ждёт,
// пока первый закончит, и видит миграции уже применёнными.
// Изменённый после применения файл не применяется повторно — это ошибка запуска:
// схему меняет только новая миграция.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCK_ID = 74230501; // произвольная константа блокировки миграций SCADA BMS
const FILE_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/;

function readMigrations(dir) {
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
  const list = [];
  for (const name of files) {
    const m = name.match(FILE_RE);
    if (!m) throw new Error(`миграция ${name}: имя должно быть NNN_имя.sql (строчные буквы, цифры, _)`);
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    const version = Number(m[1]);
    if (list.some((x) => x.version === version)) throw new Error(`миграция ${name}: номер ${m[1]} повторяется`);
    list.push({ version, name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') });
  }
  return list;
}

// Возвращает список применённых сейчас миграций (имена)
async function migrate({ pool, dir, logger }) {
  const migrations = readMigrations(dir);
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT version, name, checksum FROM schema_migrations');
    const done = new Map(rows.map((r) => [r.version, r]));
    for (const m of migrations) {
      const prev = done.get(m.version);
      if (prev) {
        if (prev.checksum !== m.checksum) {
          throw new Error(`миграция ${m.name} изменена после применения: схему меняет только новая миграция`);
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`миграция ${m.name} не применена: ${err.message}`);
      }
      applied.push(m.name);
      logger.logInfoMessage(`[Db] - migrate - применена ${m.name}`);
    }
    const known = new Set(migrations.map((m) => m.version));
    const unknown = rows.filter((r) => !known.has(r.version));
    if (unknown.length) {
      // База новее сервера (откат версии): работать со схемой из будущего опасно
      throw new Error(`в базе применены миграции, которых нет у сервера: ${unknown.map((r) => r.name).join(', ')}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
  return applied;
}

module.exports = { migrate, readMigrations };
