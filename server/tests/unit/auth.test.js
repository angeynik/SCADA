'use strict';

const { createAuthService } = require('../../services/auth');
const { createFakeUserStore } = require('../helpers/fakeUserStore');
const { createFakeLogger } = require('../helpers/fakeLogger');

describe('auth', () => {
  let t;
  let logger;
  let userStore;
  let auth;

  beforeEach(() => {
    t = 1000000;
    logger = createFakeLogger();
    userStore = createFakeUserStore({
      oper: { password: 'oper-pass', role: 'operator' },
      off: { password: 'off-pass', role: 'engineer', disabled: true },
    });
    auth = createAuthService({ userStore, logger, maxFailures: 3, lockMs: 60000, now: () => t });
  });

  test('вход: пользователь с уровнем роли', async () => {
    await expect(auth.authenticate('oper', 'oper-pass', { source: 'opcua' })).resolves.toMatchObject({ ok: true, user: { username: 'oper', role: 'operator', level: 2 } });
    expect(logger.lines.info.join('\n')).toMatch(/вход oper \(operator\) через opcua/);
  });

  test('неверное имя, пароль, блокировка — одна и та же причина клиенту, разная в логе', async () => {
    const answers = await Promise.all([['nobody', 'x'], ['oper', 'bad'], ['off', 'off-pass']].map(([u, p]) => auth.authenticate(u, p)));
    for (const a of answers) expect(a).toEqual({ ok: false, code: 'BAD_CREDENTIALS', message: 'неверное имя или пароль' });
    const log = logger.lines.info.join('\n');
    expect(log).toMatch(/отказ nobody .*нет такого пользователя/);
    expect(log).toMatch(/отказ oper .*неверный пароль/);
    expect(log).toMatch(/отказ off .*учётная запись заблокирована/);
    expect(log).not.toMatch(/oper-pass|off-pass|bad\b/);
  });

  test('после maxFailures неудач имя заблокировано на lockMs, верный пароль тоже не принимается', async () => {
    for (let i = 0; i < 3; i += 1) await auth.authenticate('oper', 'bad');
    await expect(auth.authenticate('oper', 'oper-pass')).resolves.toMatchObject({ ok: false, code: 'LOCKED' });
    expect(logger.lines.info.join('\n')).toMatch(/oper: 3 неудачных попыток, вход заблокирован на 60 с/);
    t += 60001;
    await expect(auth.authenticate('oper', 'oper-pass')).resolves.toMatchObject({ ok: true });
    // Успешный вход сбрасывает счётчик
    await auth.authenticate('oper', 'bad');
    await auth.authenticate('oper', 'bad');
    await expect(auth.authenticate('oper', 'oper-pass')).resolves.toMatchObject({ ok: true });
  });

  test('без базы пользователей — UNAVAILABLE, одна строка в лог', async () => {
    const a = createAuthService({ userStore: null, logger });
    await a.authenticate('x', 'y');
    await expect(a.authenticate('x', 'y')).resolves.toMatchObject({ ok: false, code: 'UNAVAILABLE' });
    expect(logger.lines.info.filter((l) => /база пользователей не подключена/.test(l))).toHaveLength(1);
    expect(a.available()).toBe(false);
    expect(await a.stillValid({ username: 'x' })).toBe(false);
    expect(typeof a.onRevoke(() => {})).toBe('function');
  });

  test('ошибка БД — UNAVAILABLE, неудачей не считается', async () => {
    userStore.verify = async () => { throw new Error('connection refused'); };
    for (let i = 0; i < 5; i += 1) await expect(auth.authenticate('oper', 'oper-pass')).resolves.toMatchObject({ code: 'UNAVAILABLE' });
    expect(logger.lines.error.join('\n')).toMatch(/oper: ошибка базы пользователей: connection refused/);
  });

  test('stillValid: роль, пароль, блокировка, удаление', async () => {
    const { user } = await auth.authenticate('oper', 'oper-pass');
    expect(await auth.stillValid(user)).toBe(true);
    userStore.change('oper', { password: 'new-pass-1' }, { notify: false });
    expect(await auth.stillValid(user)).toBe(false);
    const { user: u2 } = await auth.authenticate('oper', 'new-pass-1');
    userStore.change('oper', { role: 'viewer' }, { notify: false });
    expect(await auth.stillValid(u2)).toBe(false);
    expect(await auth.stillValid({ ...u2, username: 'ghost' })).toBe(false);
  });

  test('onRevoke передаёт имя изменённого пользователя', () => {
    const seen = [];
    const off = auth.onRevoke((name) => seen.push(name));
    userStore.change('oper', { role: 'viewer' });
    userStore.emit(null);
    off();
    userStore.change('oper', { role: 'admin' });
    expect(seen).toEqual(['oper', null]);
  });
});
