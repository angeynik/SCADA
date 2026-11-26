// PostgreSQL: миграции, пользователи, журнал, NOTIFY, tools/userAdmin.
// Запускается, только если задан TEST_PG_URL (postgresql://пользователь@узел/база, пароль —
// PGPASSWORD или ~/.pgpass). Каждый запуск работает в своей временной схеме и удаляет её.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { Client } = require('pg');
const { createDb } = require('../../storage/db');
const { createUserStore } = require('../../services/userStore');
const { createJournal } = require('../../services/journal');
const { main: userAdmin } = require('../../tools/userAdmin');
const { createFakeLogger } = require('../helpers/fakeLogger');

const BASE_URL = process.env.TEST_PG_URL;
const maybe = BASE_URL ? describe : describe.skip;
if (!BASE_URL) {
  // Сообщение о пропуске видно в выводе Jest
  test.skip('PostgreSQL: TEST_PG_URL не задан, тесты с БД пропущены', () => {});
}

const ROUNDS = 4; // в тестах — быстрый bcrypt (в работе BCRYPT_ROUNDS ≥ 10)

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > until) throw new Error('условие не выполнилось');
    await new Promise((r) => setTimeout(r, 20));
  }
}

maybe('PostgreSQL', () => {
  const schema = `scada_test_${process.pid}_${Date.now()}`;
  let url;
  let db;
  let logger;

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    const u = new URL(BASE_URL);
    u.searchParams.set('options', `-c search_path=${schema}`);
    url = u.toString();
  });

  afterAll(async () => {
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  beforeEach(async () => {
    logger = createFakeLogger();
    db = createDb({ url, poolMax: 4, logger });
    await db.start();
    await db.query('TRUNCATE users, journal RESTART IDENTITY');
  });

  afterEach(async () => {
    await db.stop();
  });

  test('миграции применяются один раз; изменённая миграция — ошибка запуска', async () => {
    const { rows } = await db.query('SELECT version, name FROM schema_migrations ORDER BY version');
    expect(rows[0]).toEqual({ version: 1, name: '001_users_journal.sql' });
    const againLogger = createFakeLogger();
    const again = createDb({ url, logger: againLogger });
    await again.start();
    await again.stop();
    expect(againLogger.lines.info.filter((l) => /применена/.test(l))).toHaveLength(0);
    expect(againLogger.lines.info.join('\n')).toMatch(/миграций применено: 0/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scada-mig-'));
    try {
      fs.writeFileSync(path.join(dir, '001_users_journal.sql'), '-- изменено\nSELECT 1;');
      const changed = createDb({ url, logger, migrationsDir: dir });
      await expect(changed.start()).rejects.toThrow(/001_users_journal.sql изменена после применения/);
      await changed.stop();
      fs.rmSync(path.join(dir, '001_users_journal.sql'));
      const older = createDb({ url, logger, migrationsDir: dir });
      await expect(older.start()).rejects.toThrow(/миграции, которых нет у сервера: 001_users_journal.sql/);
      await older.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('пользователи: создание, проверка пароля, роли, блокировка', async () => {
    const users = createUserStore({ db, logger, bcryptRounds: ROUNDS });
    const admin = await users.create({ username: 'admin', password: 'admin-pass', role: 'admin', displayName: 'Администратор' });
    expect(admin).toMatchObject({ username: 'admin', role: 'admin', level: 4, disabled: false, displayName: 'Администратор' });
    expect(admin).not.toHaveProperty('passwordHash');
    await expect(users.create({ username: 'admin', password: 'admin-pass', role: 'viewer' })).rejects.toMatchObject({ code: 'EXISTS' });
    await expect(users.create({ username: 'x y', password: 'admin-pass', role: 'viewer' })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(users.create({ username: 'short', password: '1234567', role: 'viewer' })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(users.create({ username: 'long', password: 'я'.repeat(37), role: 'viewer' })).rejects.toThrow(/не длиннее 72 байт/);
    await expect(users.create({ username: 'r', password: 'admin-pass', role: 'root' })).rejects.toMatchObject({ code: 'INVALID' });

    const { rows } = await db.query('SELECT password_hash FROM users');
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$04\$/);

    expect(await users.verify('admin', 'admin-pass')).toMatchObject({ user: { username: 'admin' } });
    expect(await users.verify('admin', 'wrong')).toEqual({ reason: 'password' });
    expect(await users.verify('nobody', 'x')).toEqual({ reason: 'unknown' });
    expect(await users.verify("x' OR 1=1 --", 'x')).toEqual({ reason: 'unknown' });

    await users.create({ username: 'oper', password: 'oper-pass', role: 'operator' });
    const before = await users.get('oper');
    await new Promise((r) => setTimeout(r, 5));
    const changed = await users.setPassword('oper', 'oper-pass-2');
    expect(changed.passwordChangedAt.getTime()).toBeGreaterThan(before.passwordChangedAt.getTime());
    expect(await users.verify('oper', 'oper-pass')).toEqual({ reason: 'password' });
    await users.setRole('oper', 'engineer');
    await users.setDisabled('oper', true);
    expect(await users.verify('oper', 'oper-pass-2')).toEqual({ reason: 'disabled' });
    expect((await users.list()).map((u) => [u.username, u.role, u.disabled])).toEqual([['admin', 'admin', false], ['oper', 'engineer', true]]);
    await users.remove('oper');
    expect(await users.get('oper')).toBeNull();
    await expect(users.setRole('oper', 'viewer')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('последний администратор: нельзя понизить, заблокировать, удалить — даже параллельно', async () => {
    const users = createUserStore({ db, logger, bcryptRounds: ROUNDS });
    await users.create({ username: 'a1', password: 'admin-pass', role: 'admin' });
    for (const op of [() => users.setRole('a1', 'engineer'), () => users.setDisabled('a1', true), () => users.remove('a1')]) {
      await expect(op()).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    }
    await users.setPassword('a1', 'admin-pass-2'); // пароль менять можно

    await users.create({ username: 'a2', password: 'admin-pass', role: 'admin' });
    const results = await Promise.allSettled([users.setRole('a1', 'viewer'), users.setRole('a2', 'viewer')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.code).toBe('LAST_ADMIN');
    const { rows } = await db.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND NOT disabled");
    expect(rows[0].n).toBe(1);
  });

  test('NOTIFY: изменение из другого процесса доходит до подписчика', async () => {
    const users = createUserStore({ db, logger, bcryptRounds: ROUNDS });
    const seen = [];
    users.onChange((name) => seen.push(name));
    // После подключения подписчик получает null: «проверить всех»
    await waitFor(() => seen.includes(null));
    const other = createDb({ url, logger });
    await other.start();
    try {
      await createUserStore({ db: other, logger, bcryptRounds: ROUNDS }).create({ username: 'remote', password: 'remote-pass', role: 'viewer' });
      await waitFor(() => seen.includes('remote'));
    } finally {
      await other.stop();
    }
  });

  test('обрыв соединения уведомлений: переподключение и повторная проверка всех', async () => {
    const users = createUserStore({ db, logger, bcryptRounds: ROUNDS });
    const seen = [];
    users.onChange((name) => seen.push(name));
    await waitFor(() => seen.includes(null));
    // Сервер БД разрывает соединение LISTEN (перезапуск, сбой сети)
    const killed = await db.query("SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN%' AND pid <> pg_backend_pid()");
    expect(killed.rows.length).toBeGreaterThanOrEqual(1);
    await waitFor(() => seen.filter((n) => n === null).length >= 2, 8000);
    expect(logger.lines.error.join('\n')).toMatch(/соединение для уведомлений потеряно/);
    await users.create({ username: 'after', password: 'after-pass', role: 'viewer' });
    await waitFor(() => seen.includes('after'));
  });

  test('журнал: запись и выборка', async () => {
    const journal = createJournal({ db, logger });
    await journal.record({ username: 'eng', source: 'opcua/UaExpert', action: 'write', tagId: 'B1/A/Sp', oldValue: 20, newValue: 22.5, ok: true });
    await journal.record({ username: 'oper', source: 'opcua/UaExpert', action: 'write', tagId: 'B1/A/Cmd', oldValue: null, newValue: true, ok: false, code: 'FORBIDDEN', message: 'нет прав' });
    await journal.record({ source: 'userAdmin', action: 'user.create', newValue: { username: 'x', role: 'viewer' }, ok: true });
    const all = await journal.list();
    expect(all.map((e) => e.action)).toEqual(['user.create', 'write', 'write']);
    expect(all[2]).toMatchObject({ username: 'eng', tagId: 'B1/A/Sp', oldValue: 20, newValue: 22.5, ok: true, code: null });
    expect(all[0].newValue).toEqual({ username: 'x', role: 'viewer' });
    expect(all[0].ts).toBeInstanceOf(Date);
    expect((await journal.list({ username: 'oper' }))[0]).toMatchObject({ newValue: true, code: 'FORBIDDEN', message: 'нет прав' });
    expect(await journal.list({ tagId: 'B1/A/Sp' })).toHaveLength(1);
    expect(await journal.list({ beforeId: all[1].id })).toHaveLength(1);
  });

  test('tools/userAdmin: первый администратор, роли, последний администратор, журнал', async () => {
    const env = { CONF_ENV_FILE: path.join(os.tmpdir(), 'nope.env'), PG_URL: url, BCRYPT_ROUNDS: '10' };
    const out = [];
    const write = (s) => out.push(s);
    const io = (text) => ({ input: Readable.from([`${text}\n`]) });
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const run = (args, password) => userAdmin(['n', 't', ...args], write, { env, io: password && io(password) });
      expect(await run(['add', 'boss', '--role', 'admin', '--name', 'Главный инженер', '--password-stdin'], 'boss-pass-1')).toBe(0);
      expect(await run(['add', 'ivan', '--role', 'operator'], 'ivan-pass-1')).toBe(0);
      expect(await run(['role', 'ivan', 'engineer'])).toBe(0);
      expect(await run(['passwd', 'ivan'], 'ivan-pass-2')).toBe(0);
      expect(await run(['disable', 'ivan'])).toBe(0);
      expect(await run(['rename', 'ivan', 'Иван Петров'])).toBe(0);
      out.length = 0;
      expect(await run(['list'])).toBe(0);
      expect(out.join('')).toMatch(/Пользователей: 2\nboss +admin +действует +Главный инженер\nivan +engineer +заблокирован Иван Петров/);
      expect(await run(['role', 'boss', 'viewer'])).toBe(1);
      expect(err.mock.calls.join('')).toMatch(/boss — последний действующий администратор/);
      expect(await run(['remove', 'nobody'])).toBe(1);
      expect(await run(['add', 'x', '--role', 'god'], 'x-pass-123')).toBe(2);
      expect(await run(['frobnicate', 'x'])).toBe(2);
      expect(await run(['add', 'weak', '--role', 'viewer'], 'short')).toBe(1);
      expect(await run(['remove', 'ivan'])).toBe(0);

      const users = createUserStore({ db, logger, bcryptRounds: ROUNDS });
      expect(await users.verify('boss', 'boss-pass-1')).toMatchObject({ user: { role: 'admin' } });
      const journal = await createJournal({ db, logger }).list();
      expect(journal.map((e) => e.action).reverse()).toEqual(['user.create', 'user.create', 'user.role', 'user.password', 'user.disable', 'user.rename', 'user.remove']);
      expect(journal[0].source).toMatch(/^userAdmin \(ОС: /);
      expect(JSON.stringify(journal)).not.toMatch(/ivan-pass|boss-pass/);
      expect(await userAdmin(['n', 't', 'list'], write, { env: { CONF_ENV_FILE: env.CONF_ENV_FILE } })).toBe(1);
      expect(err.mock.calls.join('')).toMatch(/PG_URL не задан/);
    } finally {
      err.mockRestore();
    }
  });
});
