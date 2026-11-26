// services/userStore.js
// Пользователи и роли (таблица users, PostgreSQL). Пароли — только bcrypt.
//
// Роли (rules.md, «Права доступа»): viewer 1, operator 2, engineer 3, admin 4.
// Пользователь наружу: { username, displayName, role, level, disabled, createdAt,
// updatedAt, passwordChangedAt } — хеш пароля из модуля не выходит.
//
// Нельзя удалить, заблокировать или понизить последнего действующего администратора:
// проверка и изменение — в одной транзакции с блокировкой строк администраторов
// (SELECT … FOR UPDATE), так два параллельных изменения не обойдут проверку.
// Каждое изменение рассылает NOTIFY scada_users с именем пользователя: сервер
// закрывает сессии этого пользователя (смена роли, пароля, блокировка, удаление),
// даже если изменение сделал tools/userAdmin из другого процесса.
//
// Ошибки — UserError с кодом: INVALID, EXISTS, NOT_FOUND, LAST_ADMIN.
'use strict';

const bcrypt = require('bcryptjs');

const ROLES = Object.freeze({ viewer: 1, operator: 2, engineer: 3, admin: 4 });
const USERNAME_RE = /^[A-Za-z0-9._-]{2,64}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX_BYTES = 72; // bcrypt учитывает только первые 72 байта
const CHANNEL = 'scada_users';

class UserError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function checkUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new UserError('INVALID', 'имя пользователя: 2–64 знака, латинские буквы, цифры, «.», «_», «-»');
  }
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw new UserError('INVALID', `пароль: не короче ${PASSWORD_MIN} знаков`);
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new UserError('INVALID', `пароль: не длиннее ${PASSWORD_MAX_BYTES} байт`);
  }
}

function checkRole(role) {
  if (!(role in ROLES)) throw new UserError('INVALID', `роль: ${Object.keys(ROLES).join(' | ')}`);
}

const COLUMNS = 'username, display_name, role, disabled, created_at, updated_at, password_changed_at';

function toUser(row) {
  return {
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    level: ROLES[row.role],
    disabled: row.disabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    passwordChangedAt: row.password_changed_at,
  };
}

function createUserStore({ db, logger, bcryptRounds = 12 }) {
  // Хеш для сравнения, когда пользователя нет: время ответа не выдаёт, есть ли такое имя
  let dummyHash = null;
  const getDummyHash = async () => {
    if (!dummyHash) dummyHash = await bcrypt.hash('нет такого пользователя', bcryptRounds);
    return dummyHash;
  };

  async function list() {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM users ORDER BY username`);
    return rows.map(toUser);
  }

  async function get(username) {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM users WHERE username = $1`, [username]);
    return rows.length ? toUser(rows[0]) : null;
  }

  // Проверка пароля. Возвращает { user } или { reason: 'unknown' | 'disabled' | 'password' }
  async function verify(username, password) {
    const { rows } = typeof username === 'string' && USERNAME_RE.test(username)
      ? await db.query(`SELECT ${COLUMNS}, password_hash FROM users WHERE username = $1`, [username])
      : { rows: [] };
    const row = rows[0];
    const ok = await bcrypt.compare(String(password), row ? row.password_hash : await getDummyHash());
    if (!row) return { reason: 'unknown' };
    if (!ok) return { reason: 'password' };
    if (row.disabled) return { reason: 'disabled' };
    return { user: toUser(row) };
  }

  async function create({ username, password, role, displayName = '' }) {
    checkUsername(username);
    checkPassword(password);
    checkRole(role);
    const hash = await bcrypt.hash(password, bcryptRounds);
    try {
      const { rows } = await db.query(
        `INSERT INTO users (username, display_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
        [username, String(displayName), role, hash],
      );
      await db.notify(CHANNEL, username);
      return toUser(rows[0]);
    } catch (err) {
      if (err.code === '23505') throw new UserError('EXISTS', `пользователь ${username} уже есть`);
      throw err;
    }
  }

  // Изменение с проверкой «последнего администратора». removesAdmin(row) — true, если после
  // изменения пользователь перестанет быть действующим администратором; apply(client, row) — само изменение.
  async function changeGuarded(username, removesAdmin, apply) {
    return db.transaction(async (client) => {
      const admins = await client.query("SELECT username FROM users WHERE role = 'admin' AND NOT disabled FOR UPDATE");
      const { rows } = await client.query(`SELECT ${COLUMNS} FROM users WHERE username = $1 FOR UPDATE`, [username]);
      if (!rows.length) throw new UserError('NOT_FOUND', `пользователя ${username} нет`);
      const row = rows[0];
      const isActiveAdmin = row.role === 'admin' && !row.disabled;
      if (isActiveAdmin && removesAdmin(row) && admins.rows.length <= 1) {
        throw new UserError('LAST_ADMIN', `${username} — последний действующий администратор`);
      }
      const result = await apply(client, row);
      await db.notify(CHANNEL, username, client);
      return result;
    });
  }

  const returning = async (client, sql, params) => toUser((await client.query(`${sql} RETURNING ${COLUMNS}`, params)).rows[0]);

  async function setPassword(username, password) {
    checkPassword(password);
    const hash = await bcrypt.hash(password, bcryptRounds);
    return changeGuarded(username, () => false, (client) => returning(client,
      'UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE username = $1',
      [username, hash]));
  }

  async function setRole(username, role) {
    checkRole(role);
    return changeGuarded(username, () => role !== 'admin', (client) => returning(client,
      'UPDATE users SET role = $2, updated_at = now() WHERE username = $1', [username, role]));
  }

  async function setDisabled(username, disabled) {
    return changeGuarded(username, () => Boolean(disabled), (client) => returning(client,
      'UPDATE users SET disabled = $2, updated_at = now() WHERE username = $1', [username, Boolean(disabled)]));
  }

  async function setDisplayName(username, displayName) {
    return changeGuarded(username, () => false, (client) => returning(client,
      'UPDATE users SET display_name = $2, updated_at = now() WHERE username = $1', [username, String(displayName)]));
  }

  async function remove(username) {
    return changeGuarded(username, () => true, async (client, row) => {
      await client.query('DELETE FROM users WHERE username = $1', [username]);
      return toUser(row);
    });
  }

  // fn(username) — пользователь изменён; fn(null) — уведомления могли потеряться
  // (переподключение к БД), проверить всех. Возвращает функцию отписки.
  function onChange(fn) {
    return db.listen(CHANNEL, (payload) => fn(payload || null));
  }

  return { list, get, verify, create, setPassword, setRole, setDisabled, setDisplayName, remove, onChange };
}

module.exports = { createUserStore, UserError, ROLES, USERNAME_RE, PASSWORD_MIN };
