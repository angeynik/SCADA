'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJournal } = require('../../services/journal');
const { readMigrations } = require('../../storage/migrate');
const { describeUrl, MIGRATIONS_DIR } = require('../../storage/db');
const { createFakeLogger } = require('../helpers/fakeLogger');

describe('journal', () => {
  test('запись: строка в лог и параметризованный INSERT', async () => {
    const logger = createFakeLogger();
    const calls = [];
    const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    await createJournal({ db, logger }).record({
      username: 'eng', source: 'opcua/UaExpert', action: 'write', tagId: 'B1/A/Sp', oldValue: 20, newValue: 22, ok: true,
    });
    expect(logger.lines.info).toEqual(['[Journal] - write - eng@opcua/UaExpert B1/A/Sp: 20 → 22, выполнено']);
    expect(calls[0].sql).toMatch(/INSERT INTO journal/);
    expect(calls[0].params).toEqual(['eng', 'opcua/UaExpert', 'write', 'B1/A/Sp', '20', '22', true, null, null]);
  });

  test('БД недоступна — команда не падает, ошибка в логе', async () => {
    const logger = createFakeLogger();
    const db = { query: async () => { throw new Error('ECONNREFUSED'); } };
    await expect(createJournal({ db, logger }).record({ action: 'write', tagId: 'B1/A/Cmd', newValue: true, ok: false, code: 'FORBIDDEN', message: 'нет прав' })).resolves.toBeUndefined();
    expect(logger.lines.info[0]).toBe('[Journal] - write - аноним@? B1/A/Cmd: — → true, отказ FORBIDDEN (нет прав)');
    expect(logger.lines.error[0]).toMatch(/журнал не записан в БД \(ECONNREFUSED\): write B1\/A\/Cmd/);
  });

  test('без БД — только лог; list пустой', async () => {
    const logger = createFakeLogger();
    const j = createJournal({ db: null, logger });
    await j.record({ action: 'user.create', source: 'userAdmin', newValue: { username: 'x' }, ok: true });
    expect(logger.lines.info[0]).toMatch(/user.create - аноним@userAdmin: — → \{"username":"x"\}, выполнено/);
    await expect(j.list()).resolves.toEqual([]);
  });

  test('list: фильтры параметрами, предел записей', async () => {
    const calls = [];
    const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: '5', tag_id: 'T', old_value: 1, new_value: 2, ok: true }] }; } };
    const j = createJournal({ db, logger: createFakeLogger() });
    const rows = await j.list({ tagId: "B1/A/Sp'; DROP TABLE journal", username: 'eng', beforeId: 100, limit: 5000 });
    expect(calls[0].sql).toMatch(/WHERE id < \$1 AND tag_id = \$2 AND username = \$3 ORDER BY id DESC LIMIT \$4/);
    expect(calls[0].params).toEqual([100, "B1/A/Sp'; DROP TABLE journal", 'eng', 1000]);
    expect(rows[0]).toMatchObject({ id: 5, tagId: 'T', oldValue: 1, newValue: 2 });
  });
});

describe('storage: миграции и адрес', () => {
  test('миграции сервера читаются по порядку', () => {
    const list = readMigrations(MIGRATIONS_DIR);
    expect(list[0]).toMatchObject({ version: 1, name: '001_users_journal.sql' });
    expect(list.map((m) => m.version)).toEqual([...list.map((m) => m.version)].sort((a, b) => a - b));
    expect(list[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test('ошибки имён и повтор номера', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scada-mig-'));
    try {
      fs.writeFileSync(path.join(dir, '001_a.sql'), 'SELECT 1;');
      fs.writeFileSync(path.join(dir, '001_b.sql'), 'SELECT 1;');
      expect(() => readMigrations(dir)).toThrow(/номер 001 повторяется/);
      fs.rmSync(path.join(dir, '001_b.sql'));
      fs.writeFileSync(path.join(dir, '2_Bad.sql'), 'SELECT 1;');
      expect(() => readMigrations(dir)).toThrow(/2_Bad.sql: имя должно быть NNN_имя.sql/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('адрес БД в логе без пользователя', () => {
    expect(describeUrl('postgresql://scada@10.0.0.5:5433/scada')).toBe('10.0.0.5:5433/scada');
    expect(describeUrl('postgresql:///scada?host=/var/run/postgresql')).toBe('/var/run/postgresql/scada');
    expect(describeUrl('postgresql://localhost/scada')).toBe('localhost:5432/scada');
    expect(describeUrl('не адрес')).toBe('PG_URL');
  });
});
