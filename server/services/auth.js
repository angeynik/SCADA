// services/auth.js
// Вход по имени и паролю — общий для OPC UA и (с этапа 8) WebSocket.
//
// createAuthService({ userStore, logger, maxFailures, lockMs, now })
//   userStore — services/userStore или null (сервер без БД: вход невозможен).
// authenticate(username, password) →
//   { ok: true, user } | { ok: false, code, message }, code:
//   BAD_CREDENTIALS — неверное имя или пароль, учётная запись заблокирована
//                     (клиенту причина не раскрывается, в лог — раскрывается);
//   LOCKED          — после maxFailures неудач подряд имя заблокировано на lockMs;
//   UNAVAILABLE     — пользователей нет (без БД) или БД недоступна.
// Пароль в лог не попадает никогда.
'use strict';

const MAX_TRACKED = 10000;

function createAuthService({ userStore, logger, maxFailures = 5, lockMs = 60000, now = Date.now }) {
  const failures = new Map(); // username → { count, until }
  let noStoreLogged = false;

  // Неудачи помнятся только для блокировки; таблица ограничена, чтобы перебор имён не съел память
  function noteFailure(username) {
    if (failures.size >= MAX_TRACKED) {
      const t = now();
      for (const [k, v] of failures) if (v.until <= t && v.count < maxFailures) failures.delete(k);
      if (failures.size >= MAX_TRACKED) failures.delete(failures.keys().next().value);
    }
    const f = failures.get(username) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= maxFailures) {
      f.until = now() + lockMs;
      logger.logInfoMessage(`[Auth] - login - ${username}: ${f.count} неудачных попыток, вход заблокирован на ${Math.round(lockMs / 1000)} с`);
    }
    failures.set(username, f);
  }

  async function authenticate(username, password, { source = '?' } = {}) {
    const name = String(username || '');
    if (!userStore) {
      if (!noStoreLogged) {
        noStoreLogged = true;
        logger.logInfoMessage('[Auth] - login - вход невозможен: база пользователей не подключена (PG_URL)');
      }
      return { ok: false, code: 'UNAVAILABLE', message: 'вход невозможен: база пользователей не подключена' };
    }
    const f = failures.get(name);
    if (f && f.count >= maxFailures) {
      if (f.until > now()) return { ok: false, code: 'LOCKED', message: 'слишком много неудачных попыток, повторите позже' };
      failures.delete(name);
    }
    let res;
    try {
      res = await userStore.verify(name, password);
    } catch (err) {
      logger.logErrorMessage(`[Auth] - login - ${name}: ошибка базы пользователей:`, err.message);
      return { ok: false, code: 'UNAVAILABLE', message: 'база пользователей недоступна' };
    }
    if (res.user) {
      failures.delete(name);
      logger.logInfoMessage(`[Auth] - login - вход ${name} (${res.user.role}) через ${source}`);
      return { ok: true, user: res.user };
    }
    noteFailure(name);
    const why = { unknown: 'нет такого пользователя', password: 'неверный пароль', disabled: 'учётная запись заблокирована' }[res.reason];
    logger.logInfoMessage(`[Auth] - login - отказ ${name} через ${source}: ${why}`);
    return { ok: false, code: 'BAD_CREDENTIALS', message: 'неверное имя или пароль' };
  }

  // Изменения пользователей (роль, пароль, блокировка): fn(username) или fn(null) — проверить всех
  function onRevoke(fn) {
    return userStore ? userStore.onChange(fn) : () => {};
  }

  // Действует ли ещё вход: пользователь есть, не заблокирован, роль и пароль те же
  async function stillValid(user) {
    if (!userStore) return false;
    const current = await userStore.get(user.username);
    return Boolean(current && !current.disabled && current.role === user.role
      && new Date(current.passwordChangedAt).getTime() === new Date(user.passwordChangedAt).getTime());
  }

  return { authenticate, onRevoke, stillValid, available: () => Boolean(userStore) };
}

module.exports = { createAuthService };
