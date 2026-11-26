// tests/helpers/fakeUserStore.js
// Хранилище пользователей в памяти с тем же контрактом, что services/userStore
// (verify, get, list, onChange) — для тестов auth, OPC UA и шлюза без PostgreSQL.
// Пароли хранятся открыто: это только тест.
'use strict';

const { ROLES } = require('../../services/userStore');

function createFakeUserStore(initial = {}) {
  const users = new Map();
  const listeners = new Set();
  let changedAt = new Date('2026-11-26T08:00:00Z');

  const toUser = (u) => ({
    username: u.username, displayName: '', role: u.role, level: ROLES[u.role], disabled: Boolean(u.disabled),
    createdAt: changedAt, updatedAt: changedAt, passwordChangedAt: u.passwordChangedAt,
  });
  const emit = (name) => { for (const fn of listeners) fn(name); };

  for (const [username, { password, role, disabled }] of Object.entries(initial)) {
    users.set(username, { username, password, role, disabled, passwordChangedAt: changedAt });
  }

  return {
    async verify(username, password) {
      const u = users.get(username);
      if (!u) return { reason: 'unknown' };
      if (u.password !== password) return { reason: 'password' };
      if (u.disabled) return { reason: 'disabled' };
      return { user: toUser(u) };
    },
    async get(username) {
      const u = users.get(username);
      return u ? toUser(u) : null;
    },
    async list() {
      return [...users.values()].map(toUser);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // Управление из теста: изменение и рассылка уведомления, как NOTIFY
    change(username, patch, { notify = true } = {}) {
      const u = users.get(username);
      Object.assign(u, patch);
      if (patch.password) {
        changedAt = new Date(changedAt.getTime() + 1000);
        u.passwordChangedAt = changedAt;
      }
      if (notify) emit(username);
    },
    emit,
  };
}

module.exports = { createFakeUserStore };
