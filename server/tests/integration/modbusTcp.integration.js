// Драйвер Modbus TCP с настоящим транспортом (modbus-serial) против эмулятора
// tools/lib/modbusSlave на 127.0.0.1; инструменты modbusEmulator и modbusDiag.
'use strict';

const net = require('net');
const { createModbusSlave } = require('../../tools/lib/modbusSlave');
const { createModbusTcpDriver } = require('../../drivers/modbusTcp');
const { createTcpTransport } = require('../../drivers/modbusTcp/transport');
const { encode } = require('../../drivers/modbusTcp/codec');
const { createTagStore } = require('../../core/tagStore');
const { loadModel } = require('../../core/modelLoader');
const { startEmulators } = require('../../tools/modbusEmulator');
const { main: diagMain } = require('../../tools/modbusDiag');
const { createFakeLogger } = require('../helpers/fakeLogger');
const fx = require('../helpers/modelFixture');

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error('условие не выполнилось');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const OPTIONS = { pollMs: 50, timeoutMs: 200, connectTimeoutMs: 300, failLimit: 2, maxGap: 4, reconnectMinMs: 50, reconnectMaxMs: 200 };

describe('Modbus TCP: драйвер и эмулятор', () => {
  let slave;
  let driver;
  let store;
  let logger;

  function makeTags(port) {
    const src = (point) => ({ driver: 'modbus', connection: { host: '127.0.0.1', port, unitId: 1 }, byteOrder: 'CDAB', point: { scale: 1, offset: 0, ...point } });
    return [
      { id: 'B1/A/Temp', dataType: 'Float', deadband: 0, source: src({ area: 'holding', address: 100, type: 'float32' }) },
      { id: 'B1/A/Sp', dataType: 'Float', deadband: 0, source: src({ area: 'holding', address: 102, type: 'float32' }) },
      { id: 'B1/A/Valve', dataType: 'Float', deadband: 0, source: src({ area: 'holding', address: 120, type: 'int16', scale: 0.1 }) },
      { id: 'B1/A/Alarm', dataType: 'Boolean', deadband: 0, source: src({ area: 'holding', address: 12, type: 'bool', bit: 0 }) },
      { id: 'B1/A/Cmd', dataType: 'Boolean', deadband: 0, source: src({ area: 'coil', address: 0, type: 'bool' }) },
      { id: 'B1/A/Hours', dataType: 'UInt32', deadband: 0, source: src({ area: 'input', address: 130, type: 'uint32' }) },
    ];
  }

  beforeEach(async () => {
    slave = createModbusSlave();
    const port = await slave.start();
    slave.setRegisters('holding', 100, encode({ type: 'float32' }, 21.1, 'CDAB').words);
    slave.setRegisters('holding', 102, encode({ type: 'float32' }, 20, 'CDAB').words);
    slave.setRegisters('holding', 120, [455]);
    slave.setRegisters('holding', 12, [1]);
    slave.setRegisters('input', 130, encode({ type: 'uint32' }, 70000, 'CDAB').words);
    const tags = makeTags(port);
    logger = createFakeLogger();
    store = createTagStore({ tags: new Map(tags.map((t) => [t.id, t])), logger });
    driver = createModbusTcpDriver({ tags, tagStore: store, logger, options: OPTIONS });
  });

  afterEach(async () => {
    await driver.stop();
    await slave.stop();
  });

  test('чтение всех типов точек', async () => {
    driver.start();
    await waitFor(() => store.snapshot().every((s) => s.quality === 'good'));
    const values = Object.fromEntries(store.snapshot().map((s) => [s.id.split('/')[2], s.value]));
    expect(values).toEqual({ Temp: 21.1, Sp: 20, Valve: 45.5, Alarm: true, Cmd: false, Hours: 70000 });
    expect(driver.status().devices[0]).toMatchObject({ online: true, tags: 6 });
  });

  test('запись с подтверждением доходит до контроллера', async () => {
    driver.start();
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    await expect(driver.write('B1/A/Sp', 22.5)).resolves.toEqual({ ok: true, value: 22.5 });
    await expect(driver.write('B1/A/Valve', 12.3)).resolves.toEqual({ ok: true, value: 12.3 });
    await expect(driver.write('B1/A/Cmd', true)).resolves.toEqual({ ok: true, value: true });
    await expect(driver.write('B1/A/Alarm', false)).resolves.toEqual({ ok: true, value: false });
    expect(slave.mem.holding[120]).toBe(123);
    expect(slave.mem.coil[0]).toBe(1);
    expect(slave.mem.holding[12]).toBe(0);
    await expect(driver.write('B1/X/Y', 1)).resolves.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('молчащий контроллер, обрыв и восстановление', async () => {
    driver.start();
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    slave.setSilent(true);
    await waitFor(() => store.get('B1/A/Temp').code === 'COMM_ERROR');
    slave.setSilent(false);
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    slave.dropClients();
    await waitFor(() => store.get('B1/A/Temp').code === 'COMM_ERROR');
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    expect(logger.lines.info.filter((l) => /связь восстановлена/.test(l)).length).toBeGreaterThanOrEqual(2);
  });

  test('недопустимый адрес: точка CONFIG_ERROR, остальные работают', async () => {
    slave.illegal('holding', 102, 103);
    driver.start();
    await waitFor(() => store.get('B1/A/Sp').code === 'CONFIG_ERROR' && store.get('B1/A/Temp').quality === 'good');
    expect(store.get('B1/A/Valve').quality).toBe('good');
  });

  test('контроллер не запущен: COMM_ERROR, затем подключение', async () => {
    const port = slave.port();
    await slave.stop();
    driver.start();
    await waitFor(() => store.get('B1/A/Temp').code === 'COMM_ERROR');
    expect(logger.lines.error[0]).toMatch(/нет данных от контроллера: ECONNREFUSED/);
    slave = createModbusSlave({ port });
    await slave.start();
    slave.setRegisters('holding', 100, encode({ type: 'float32' }, 5, 'CDAB').words);
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    expect(store.get('B1/A/Temp').value).toBe(5);
  });
});

describe('Modbus TCP: транспорт', () => {
  test('таймаут подключения к адресу, который не отвечает', async () => {
    // Сервер, который принимает соединения в очередь, но не завершает рукопожатие, сделать
    // переносимо нельзя, поэтому проверяем через неотвечающий порт: сокет закрыт сразу
    const server = net.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    await new Promise((r) => server.close(r));
    const t = createTcpTransport({ host: '127.0.0.1', port, timeoutMs: 100, connectTimeoutMs: 200 });
    await expect(t.connect()).rejects.toMatchObject({ kind: 'transport', message: 'ECONNREFUSED' });
    await expect(t.read(1, 'holding', 0, 1)).rejects.toMatchObject({ kind: 'transport', message: 'нет соединения' });
  });

  test('исключение Modbus и таймаут ответа нормализуются', async () => {
    const slave = createModbusSlave();
    const port = await slave.start();
    const t = createTcpTransport({ host: '127.0.0.1', port, timeoutMs: 150 });
    try {
      await t.connect();
      slave.illegal('holding', 0, 9);
      await expect(t.read(1, 'holding', 0, 2)).rejects.toMatchObject({ kind: 'exception', modbusCode: 2, message: 'исключение Modbus 2 (недопустимый адрес)' });
      slave.setSilent(true);
      await expect(t.read(1, 'holding', 20, 1)).rejects.toMatchObject({ kind: 'transport', message: 'нет ответа (таймаут)' });
    } finally {
      t.close();
      await slave.stop();
    }
  });
});

describe('Modbus TCP: инструменты', () => {
  test('modbusEmulator по карте примера и modbusDiag по установке', async () => {
    const model = loadModel({ dir: fx.EXAMPLE_DIR });
    const emu = await startEmulators({ model, mapId: 'owen-ahu-v1', count: 3, basePort: 0 });
    const out = [];
    try {
      expect(emu.instances.map((i) => i.id)).toEqual(['EMU-01', 'EMU-02', 'EMU-03']);
      expect(emu.instances[0].source).toMatchObject({ driver: 'modbus', map: 'owen-ahu-v1', host: '127.0.0.1' });

      const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const code = await diagMain(
          ['node', 'modbusDiag', '--config', fx.EXAMPLE_DIR, '--instance', 'AHU-01', '--host', '127.0.0.1', '--port', String(emu.instances[1].source.port)],
          (s) => out.push(s),
        );
        expect(code).toBe(0);
        const text = out.join('');
        expect(text).toMatch(/SupplyTemp +holding:100 float32 +0x[0-9a-f]{4} 0x[0-9a-f]{4} +\d+(\.\d)? °C/);
        expect(text).toMatch(/SupplyFanRunning +holding:12.4 bool +0x0030 +true/);
        expect(text).toMatch(/RunHours .* 1000 ч/);

        out.length = 0;
        const raw = await diagMain(['node', 'modbusDiag', '--host', '127.0.0.1', '--port', String(emu.instances[0].source.port), '--area', 'holding', '--address', '130', '--count', '2'], (s) => out.push(s));
        expect(raw).toBe(0);
        expect(out.join('')).toMatch(/holding:130 {2}1000 {2}0x03e8\nholding:131 {2}0 {2}0x0000/);
        expect(await diagMain(['node', 'modbusDiag'], () => {})).toBe(2);
        expect(await diagMain(['node', 'modbusDiag', '--config', fx.EXAMPLE_DIR, '--instance', 'AHU-17'], () => {})).toBe(1);
        expect(err.mock.calls.join('')).toMatch(/AHU-17 не на Modbus/);
      } finally {
        err.mockRestore();
      }
    } finally {
      await emu.stop();
    }
  });

  test('сервер опрашивает эмуляторы по экземплярам modbusEmulator', async () => {
    const model = loadModel({ dir: fx.EXAMPLE_DIR });
    const emu = await startEmulators({ model, mapId: 'owen-ahu-v1', count: 2, basePort: 0 });
    const dir = fx.createConfigDir({});
    try {
      require('fs').cpSync(fx.EXAMPLE_DIR, dir, { recursive: true });
      require('fs').writeFileSync(`${dir}/instances/floor1.json`, JSON.stringify(emu.instances));
      const m = loadModel({ dir });
      expect(m.issues).toEqual([]);
      const tags = [...m.tags.values()].filter((t) => t.source.driver === 'modbus');
      const logger = createFakeLogger();
      const store = createTagStore({ tags: m.tags, logger });
      const driver = createModbusTcpDriver({ tags, tagStore: store, logger, options: OPTIONS });
      driver.start();
      try {
        await waitFor(() => tags.every((t) => store.get(t.id).quality === 'good'));
        expect(store.get('B1/EMU-01/SupplyFanRunning').value).toBe(true);
        expect(store.get('B1/EMU-02/RunHours').value).toBe(1000);
        await expect(driver.write('B1/EMU-02/SupplyTempSp', 23)).resolves.toEqual({ ok: true, value: 23 });
      } finally {
        await driver.stop();
      }
    } finally {
      fx.removeDir(dir);
      await emu.stop();
    }
  });
});
