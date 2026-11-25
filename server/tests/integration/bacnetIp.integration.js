// Драйвер BACnet/IP с настоящим транспортом (@bacnet-js/client, UDP) против эмулятора
// tools/lib/bacnetDevice на 127.0.0.1; инструменты bacnetEmulator и bacnetDiscover.
'use strict';

const fs = require('fs');
const dgram = require('dgram');
const { createBacnetDeviceEmulator } = require('../../tools/lib/bacnetDevice');
const { createBacnetIpDriver } = require('../../drivers/bacnetIp');
const { createBacnetTransport } = require('../../drivers/bacnetIp/transport');
const { createTagStore } = require('../../core/tagStore');
const { loadModel } = require('../../core/modelLoader');
const { startBacnetEmulators } = require('../../tools/bacnetEmulator');
const { main: discoverMain } = require('../../tools/bacnetDiscover');
const { createFakeLogger } = require('../helpers/fakeLogger');
const fx = require('../helpers/modelFixture');

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error('условие не выполнилось');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const OPTIONS = {
  port: 0, iface: '127.0.0.1', apduTimeoutMs: 200, pollMs: 50, failLimit: 2, reconnectMinMs: 50, reconnectMaxMs: 200, covLifetimeS: 60,
};

const OBJECTS = [
  { objectType: 'analogInput', instance: 1, value: 21.1, name: 'AHU.SA-T' },
  { objectType: 'analogValue', instance: 2, value: 20 },
  { objectType: 'binaryOutput', instance: 3, value: false },
  { objectType: 'multiStateValue', instance: 4, value: 1, states: 3 },
  { objectType: 'binaryInput', instance: 5, value: true },
];

function makeTags({ device = 30001, address, extra = [] } = {}) {
  const src = (point) => ({ driver: 'bacnet', connection: { device, address: address || null }, point: { scale: 1, offset: 0, ...point } });
  return [
    { id: 'B1/N/Temp', dataType: 'Float', deadband: 0, source: src({ objectType: 'analogInput', instance: 1 }) },
    { id: 'B1/N/Sp', dataType: 'Float', deadband: 0, source: src({ objectType: 'analogValue', instance: 2 }) },
    { id: 'B1/N/Cmd', dataType: 'Boolean', deadband: 0, source: src({ objectType: 'binaryOutput', instance: 3 }) },
    { id: 'B1/N/Season', dataType: 'UInt16', deadband: 0, source: src({ objectType: 'multiStateValue', instance: 4, offset: -1 }) },
    { id: 'B1/N/Run', dataType: 'Boolean', deadband: 0, source: src({ objectType: 'binaryInput', instance: 5 }) },
    ...extra.map((e) => ({ ...e, source: src(e.point) })),
  ];
}

describe('BACnet/IP: драйвер и эмулятор', () => {
  let emu;
  let driver;
  let store;
  let logger;

  async function setup({ emuOptions = {}, options = {}, tags } = {}) {
    emu = createBacnetDeviceEmulator({ deviceId: 30001, objects: OBJECTS, ...emuOptions });
    await emu.start();
    const list = tags ? tags(emu) : makeTags({ address: emu.address() });
    logger = createFakeLogger();
    store = createTagStore({ tags: new Map(list.map((t) => [t.id, t])), logger });
    const extra = typeof options === 'function' ? options(emu) : options;
    driver = createBacnetIpDriver({ tags: list, tagStore: store, logger, options: { ...OPTIONS, ...extra } });
    await driver.start();
  }

  afterEach(async () => {
    if (driver) await driver.stop();
    if (emu) await emu.stop();
    driver = null;
    emu = null;
  });

  const v = (n) => store.get(`B1/N/${n}`);
  const allGood = () => store.snapshot().every((s) => s.quality === 'good');

  test('чтение, подписка COV и уведомления', async () => {
    await setup();
    await waitFor(allGood);
    expect(Object.fromEntries(store.snapshot().map((s) => [s.id.split('/')[2], s.value]))).toEqual({ Temp: 21.1, Sp: 20, Cmd: false, Season: 0, Run: true });
    await waitFor(() => emu.subscriptions().length === 5);
    emu.setValue('analogInput', 1, 24.5);
    await waitFor(() => v('Temp').value === 24.5);
    emu.setFlags('binaryInput', 5, { fault: true });
    await waitFor(() => v('Run').code === 'DEVICE_FAULT');
    expect(driver.status().devices[0]).toMatchObject({ online: true, covObjects: 5, maxApdu: 480 });
    expect(driver.status().devices[0].covNotifications).toBeGreaterThanOrEqual(7);
  });

  test('запись с приоритетом 8, подтверждение и снятие команды', async () => {
    await setup();
    await waitFor(allGood);
    await expect(driver.write('B1/N/Sp', 22.5)).resolves.toEqual({ ok: true, value: 22.5 });
    await expect(driver.write('B1/N/Cmd', true)).resolves.toEqual({ ok: true, value: true });
    await expect(driver.write('B1/N/Season', 2)).resolves.toEqual({ ok: true, value: 2 });
    expect(emu.priorityArray('binaryOutput', 3)[7]).toBe(true);
    expect(emu.value('multiStateValue', 4)).toBe(3);
    await expect(driver.release('B1/N/Cmd')).resolves.toEqual({ ok: true, value: false });
    expect(emu.priorityArray('binaryOutput', 3).every((x) => x === null)).toBe(true);
    expect(emu.writes.every((w) => w.priority === 8)).toBe(true);
    await expect(driver.write('B1/N/Season', 5)).resolves.toMatchObject({ code: 'WRITE_FAILED', message: expect.stringMatching(/value_out_of_range/) });
    await expect(driver.write('B1/N/Run', false)).resolves.toMatchObject({ code: 'WRITE_FAILED', message: expect.stringMatching(/write_access_denied/) });
    await expect(driver.write('B1/X/Y', 1)).resolves.toMatchObject({ code: 'NOT_FOUND' });
    await expect(driver.release('B1/X/Y')).resolves.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('поиск по Who-Is, если адрес не задан', async () => {
    await setup({
      tags: () => makeTags({ address: null }),
      // Who-Is на адрес эмулятора вместо широковещательного
      options: (e) => ({ broadcastAddress: e.address() }),
    });
    await waitFor(allGood);
    expect(driver.status().devices[0].address).toBe(emu.address());
    expect(emu.requests.whoIs).toBeGreaterThanOrEqual(1);
    expect(logger.lines.info.join('\n')).toMatch(/поиск по Who-Is: 1/);
  });

  test('устройство замолчало: COMM_ERROR, затем восстановление и новая подписка', async () => {
    await setup();
    await waitFor(() => emu.subscriptions().length === 5);
    emu.setSilent(true);
    await waitFor(() => v('Temp').code === 'COMM_ERROR');
    const subs = emu.requests.subscribeCov;
    emu.setSilent(false);
    await waitFor(allGood);
    // Подписки после потери связи считаются потерянными и оформляются заново
    await waitFor(() => emu.requests.subscribeCov >= subs + 5);
    expect(logger.lines.info.filter((l) => /связь восстановлена/.test(l))).toHaveLength(1);
  });

  test('устройство без сегментации и без COV: короткие запросы и опрос', async () => {
    await setup({ emuOptions: { maxObjectsPerRpm: 2, cov: false } });
    await waitFor(allGood);
    emu.setValue('analogValue', 2, 18);
    await waitFor(() => v('Sp').value === 18);
    expect(driver.status().devices[0]).toMatchObject({ covObjects: 0, maxObjectsPerRequest: 2, requests: 3 });
  });

  test('неизвестный объект — CONFIG_ERROR, остальные работают', async () => {
    await setup({
      tags: (e) => makeTags({ address: e.address(), extra: [{ id: 'B1/N/Missing', dataType: 'Float', deadband: 0, point: { objectType: 'analogInput', instance: 99 } }] }),
    });
    await waitFor(() => v('Missing').code === 'CONFIG_ERROR' && v('Temp').quality === 'good');
    expect(logger.lines.error.join('\n')).toMatch(/analogInput:99 .*unknown_object/);
  });
});

describe('BACnet/IP: транспорт', () => {
  test('занятый порт — понятная ошибка запуска', async () => {
    const sock = dgram.createSocket('udp4');
    await new Promise((r) => sock.bind(0, '127.0.0.1', r));
    const { port } = sock.address();
    try {
      const t = createBacnetTransport({ port, iface: '127.0.0.1' });
      await expect(t.open()).rejects.toMatchObject({ kind: 'transport', message: `порт UDP ${port} занят (на порту BACnet может слушать только один процесс)` });
      expect(t.isOpen()).toBe(false);
      await expect(t.readMultiple('127.0.0.1', [])).rejects.toMatchObject({ message: 'сокет BACnet закрыт' });
    } finally {
      sock.close();
    }
  });

  test('таймаут ответа', async () => {
    const t = createBacnetTransport({ port: 0, iface: '127.0.0.1', apduTimeoutMs: 100 });
    await t.open();
    try {
      await expect(t.readProperty('127.0.0.1:9', { type: 8, instance: 1 }, 77)).rejects.toMatchObject({ kind: 'timeout' });
    } finally {
      t.close();
    }
  });
});

describe('BACnet/IP: инструменты', () => {
  test('bacnetEmulator по шаблону и bacnetDiscover: поиск, объекты, проверка установки', async () => {
    const model = loadModel({ dir: fx.EXAMPLE_DIR });
    const emu = await startBacnetEmulators({ model, templateId: 'AhuType', count: 2, baseDevice: 40001 });
    const dir = fx.createConfigDir({});
    const out = [];
    const write = (s) => out.push(s);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(emu.instances.map((i) => i.source.device)).toEqual([40001, 40002]);
      fs.cpSync(fx.EXAMPLE_DIR, dir, { recursive: true });
      fs.writeFileSync(`${dir}/instances/floor1.json`, JSON.stringify(emu.instances));
      expect(loadModel({ dir }).issues).toEqual([]);

      const port = emu.devices[0].port();
      await expect(discoverMain(['n', 'd', '--broadcast', `127.0.0.1:${port}`, '--local-port', '0', '--wait', '300'], write)).resolves.toBe(0);
      expect(out.join('')).toMatch(/Ответили устройств: 1\n\n40001 +127\.0\.0\.1:\d+ .*BEMU-01 · Emulator/);

      out.length = 0;
      const csv = `${dir}/draft.csv`;
      await expect(discoverMain(['n', 'd', '--device', '40001', '--address', `127.0.0.1:${port}`, '--csv', csv, '--id', 'AHU-99'], write)).resolves.toBe(0);
      expect(out.join('')).toMatch(/AI:8 +BEMU-01\.SupplyTemp +20 +degrees_celsius/);
      expect(fs.readFileSync(csv, 'utf8').split('\n')[2]).toBe('AHU-99;;;;;;BEMU-01_Command;BO:1');

      out.length = 0;
      await expect(discoverMain(['n', 'd', '--instance', 'BEMU-02', '--config', dir], write)).resolves.toBe(0);
      expect(out.join('')).toMatch(/Season +MV:2 +BEMU-02\.Season +1 +0\n/);
      expect(out.join('')).toMatch(/RunHours +AI:20 .* 1000 ч/);

      emu.devices[1].removeObject('analogInput', 8);
      await expect(discoverMain(['n', 'd', '--instance', 'BEMU-02', '--config', dir], write)).resolves.toBe(1);
      expect(out.join('')).toMatch(/SupplyTemp +AI:8 +ОШИБКА: ошибка BACnet object\/unknown_object/);

      await expect(discoverMain(['n', 'd', '--instance', 'AHU-01', '--config', fx.EXAMPLE_DIR], write)).resolves.toBe(1);
      expect(err.mock.calls.join('')).toMatch(/AHU-01 не на BACnet/);
      await expect(discoverMain(['n', 'd', '--device', 'x'], write)).resolves.toBe(2);
    } finally {
      err.mockRestore();
      fx.removeDir(dir);
      await emu.stop();
    }
  });
});
