// services/journal.js
// Журнал действий: команды в контроллеры (commandGateway) и действия администратора
// (tools/userAdmin). Таблица journal (PostgreSQL); каждая запись дублируется строкой в лог.
//
// record({ username, source, action, tagId, oldValue, newValue, ok, code, message })
//   source — откуда команда: 'opcua', 'ws', 'scheduler', 'userAdmin' …;
//   action — 'write', 'release', 'user.create', 'user.role' …
//   Никогда не бросает: если БД недоступна, запись остаётся только в логе
//   (с ошибкой «журнал не записан») — команда уже выполнена и отменять её нельзя.
// list({ limit, beforeId, tagId, username }) — последние записи (новые сначала).
'use strict';

const LIMIT_MAX = 1000;

const fmt = (v) => (v === undefined || v === null ? '—' : JSON.stringify(v));

function createJournal({ db, logger }) {
  async function record(entry) {
    const e = {
      username: entry.username || null,
      source: entry.source || '?',
      action: entry.action,
      tagId: entry.tagId || null,
      oldValue: entry.oldValue === undefined ? null : entry.oldValue,
      newValue: entry.newValue === undefined ? null : entry.newValue,
      ok: Boolean(entry.ok),
      code: entry.code || null,
      message: entry.message || null,
    };
    const result = e.ok ? 'выполнено' : `отказ ${e.code}${e.message ? ` (${e.message})` : ''}`;
    logger.logInfoMessage(`[Journal] - ${e.action} - ${e.username || 'аноним'}@${e.source}`
      + `${e.tagId ? ` ${e.tagId}` : ''}: ${fmt(e.oldValue)} → ${fmt(e.newValue)}, ${result}`);
    if (!db) return;
    try {
      await db.query(
        `INSERT INTO journal (username, source, action, tag_id, old_value, new_value, ok, code, message)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
        [e.username, e.source, e.action, e.tagId, JSON.stringify(e.oldValue), JSON.stringify(e.newValue), e.ok, e.code, e.message],
      );
    } catch (err) {
      logger.logErrorMessage(`[Journal] - record - журнал не записан в БД (${err.message}): ${e.action} ${e.tagId || ''}`);
    }
  }

  async function list({ limit = 100, beforeId, tagId, username } = {}) {
    if (!db) return [];
    const where = [];
    const params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (beforeId) add('id < ?', beforeId);
    if (tagId) add('tag_id = ?', tagId);
    if (username) add('username = ?', username);
    params.push(Math.min(Math.max(1, Number(limit) || 100), LIMIT_MAX));
    const { rows } = await db.query(
      `SELECT id, ts, username, source, action, tag_id, old_value, new_value, ok, code, message FROM journal
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      ts: r.ts,
      username: r.username,
      source: r.source,
      action: r.action,
      tagId: r.tag_id,
      oldValue: r.old_value,
      newValue: r.new_value,
      ok: r.ok,
      code: r.code,
      message: r.message,
    }));
  }

  return { record, list };
}

module.exports = { createJournal };
