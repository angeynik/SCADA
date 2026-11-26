'use strict';

const { createCommandGateway } = require('../../services/commandGateway');
const { createTagStore } = require('../../core/tagStore');
const { createFakeLogger } = require('../helpers/fakeLogger');

const tag = (id, extra) => ({ id, dataType: 'Float', access: 'rw', writeLevel: 3, deadband: 0, source: { driver: 'modbus' }, ...extra });
const TAGS = [
  tag('B1/A/Sp', { min: 10, max: 30 }),
  tag('B1/A/Temp', { access: 'r' }),
  tag('B1/A/Cmd', { dataType: 'Boolean', writeLevel: 2 }),
  tag('B1/A/Mode', { dataType: 'UInt16', states: { 0: 'Авто', 1: 'Зима' } }),
  tag('B1/N/Cmd', { dataType: 'Boolean', writeLevel: 2, source: { driver: 'bacnet' } }),
];
const ENG = { username: 'eng', role: 'engineer', level: 3 };
const OPER = { username: 'oper', role: 'operator', level: 2 };

function setup({ drivers, isPrimary } = {}) {
  const logger = createFakeLogger();
  const store = createTagStore({ tags: new Map(TAGS.map((t) => [t.id, t])), logger });
  const entries = [];
  const modbus = {
    write: jest.fn(async (id, v) => { store.update(id, v); return { ok: true, value: v }; }),
  };
  const bacnet = {
    write: jest.fn(async (id, v) => ({ ok: true, value: v })),
    release: jest.fn(async () => ({ ok: true, value: false })),
  };
  const gw = createCommandGateway({
    tagStore: store,
    drivers: drivers || new Map([['modbus', modbus], ['bacnet', bacnet]]),
    journal: { record: async (e) => { entries.push(e); } },
    logger,
    isPrimary,
  });
  return { gw, store, entries, modbus, bacnet, logger };
}

describe('commandGateway', () => {
  test('успешная запись: драйвер, подтверждение, журнал со старым и новым значением', async () => {
    const { gw, store, entries, modbus } = setup();
    store.update('B1/A/Sp', 20);
    await expect(gw.execute({ tagId: 'B1/A/Sp', value: 22, user: ENG, source: 'opcua/UaExpert' })).resolves.toEqual({ ok: true, value: 22 });
    expect(modbus.write).toHaveBeenCalledWith('B1/A/Sp', 22);
    expect(entries).toEqual([{
      username: 'eng', source: 'opcua/UaExpert', action: 'write', tagId: 'B1/A/Sp', oldValue: 20, newValue: 22, ok: true, code: null, message: null,
    }]);
  });

  test.each([
    ['нет тега', { tagId: 'B1/X/Y', value: 1, user: ENG }, 'NOT_FOUND'],
    ['только чтение', { tagId: 'B1/A/Temp', value: 1, user: ENG }, 'READ_ONLY'],
    ['без входа', { tagId: 'B1/A/Cmd', value: true, user: null }, 'FORBIDDEN'],
    ['уровень ниже writeLevel', { tagId: 'B1/A/Sp', value: 20, user: OPER }, 'FORBIDDEN'],
    ['не тот тип', { tagId: 'B1/A/Cmd', value: 1, user: OPER }, 'TYPE_MISMATCH'],
    ['дробное для целого', { tagId: 'B1/A/Mode', value: 0.5, user: ENG }, 'TYPE_MISMATCH'],
    ['ниже min', { tagId: 'B1/A/Sp', value: 9.9, user: ENG }, 'OUT_OF_RANGE'],
    ['выше max', { tagId: 'B1/A/Sp', value: 30.1, user: ENG }, 'OUT_OF_RANGE'],
    ['нет такого состояния', { tagId: 'B1/A/Mode', value: 2, user: ENG }, 'OUT_OF_RANGE'],
    ['NaN', { tagId: 'B1/A/Sp', value: NaN, user: ENG }, 'TYPE_MISMATCH'],
  ])('отказ: %s → %s, драйвер не вызывается, запись в журнале', async (_, cmd, code) => {
    const { gw, entries, modbus } = setup();
    const res = await gw.execute({ ...cmd, source: 't' });
    expect(res).toMatchObject({ ok: false, code });
    expect(typeof res.message).toBe('string');
    expect(modbus.write).not.toHaveBeenCalled();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ok: false, code, tagId: cmd.tagId });
  });

  test('резервный узел не пишет', async () => {
    const { gw, modbus } = setup({ isPrimary: () => false });
    await expect(gw.execute({ tagId: 'B1/A/Cmd', value: true, user: OPER })).resolves.toMatchObject({ code: 'NOT_PRIMARY' });
    expect(modbus.write).not.toHaveBeenCalled();
  });

  test('драйвер выключен — NOT_CONNECTED', async () => {
    const { gw } = setup({ drivers: new Map() });
    await expect(gw.execute({ tagId: 'B1/A/Cmd', value: true, user: OPER })).resolves.toMatchObject({ code: 'NOT_CONNECTED', message: 'драйвер modbus выключен' });
  });

  test('отказ драйвера и исключение драйвера', async () => {
    const { gw, modbus, entries, logger } = setup();
    modbus.write.mockResolvedValueOnce({ ok: false, code: 'WRITE_FAILED', message: 'исключение Modbus 2' });
    await expect(gw.execute({ tagId: 'B1/A/Cmd', value: true, user: OPER })).resolves.toEqual({ ok: false, code: 'WRITE_FAILED', message: 'исключение Modbus 2' });
    modbus.write.mockRejectedValueOnce(new Error('сбой'));
    await expect(gw.execute({ tagId: 'B1/A/Cmd', value: true, user: OPER })).resolves.toMatchObject({ code: 'WRITE_FAILED', message: 'сбой' });
    expect(entries.map((e) => e.code)).toEqual(['WRITE_FAILED', 'WRITE_FAILED']);
    expect(logger.lines.error.join('\n')).toMatch(/B1\/A\/Cmd: сбой/);
  });

  test('подтверждённое значение отличается от записанного — отметка в журнале', async () => {
    const { gw, modbus, entries } = setup();
    modbus.write.mockResolvedValueOnce({ ok: true, value: 21.9 });
    await expect(gw.execute({ tagId: 'B1/A/Sp', value: 22, user: ENG })).resolves.toEqual({ ok: true, value: 21.9 });
    expect(entries[0].message).toBe('подтверждено 21.9');
  });

  test('снятие команды: BACnet поддерживает, Modbus — нет', async () => {
    const { gw, bacnet, entries } = setup();
    await expect(gw.release({ tagId: 'B1/N/Cmd', user: OPER, source: 't' })).resolves.toEqual({ ok: true, value: false });
    expect(bacnet.release).toHaveBeenCalledWith('B1/N/Cmd');
    await expect(gw.release({ tagId: 'B1/A/Cmd', user: OPER })).resolves.toMatchObject({ code: 'NOT_SUPPORTED' });
    await expect(gw.release({ tagId: 'B1/N/Cmd', user: null })).resolves.toMatchObject({ code: 'FORBIDDEN' });
    expect(entries.map((e) => [e.action, e.ok, e.newValue])).toEqual([['release', true, null], ['release', false, null], ['release', false, null]]);
  });

  test('canWrite — без записи', () => {
    const { gw } = setup();
    expect(gw.canWrite('B1/A/Cmd', OPER)).toBe(true);
    expect(gw.canWrite('B1/A/Sp', OPER)).toBe(false);
    expect(gw.canWrite('B1/A/Temp', ENG)).toBe(false);
    expect(gw.canWrite('B1/A/Cmd', null)).toBe(false);
  });

  test('остановка: новые команды отклоняются, начатая дожидается', async () => {
    const { gw, modbus } = setup();
    let finish;
    modbus.write.mockImplementationOnce(() => new Promise((r) => { finish = () => r({ ok: true, value: true }); }));
    const pending = gw.execute({ tagId: 'B1/A/Cmd', value: true, user: OPER });
    await new Promise((r) => setImmediate(r));
    expect(gw.status()).toEqual({ accepting: true, inFlight: 1 });
    let stopped = false;
    const stopping = gw.stop().then(() => { stopped = true; });
    await expect(gw.execute({ tagId: 'B1/A/Cmd', value: false, user: OPER })).resolves.toMatchObject({ code: 'NOT_CONNECTED', message: 'сервер останавливается' });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false);
    finish();
    await expect(pending).resolves.toEqual({ ok: true, value: true });
    await stopping;
    expect(gw.status()).toEqual({ accepting: false, inFlight: 0 });
  });
});
