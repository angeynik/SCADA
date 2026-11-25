'use strict';

const { createModbusDevice } = require('../../drivers/modbusTcp/device');
const { ModbusError } = require('../../drivers/modbusTcp/transport');
const { createTagStore } = require('../../core/tagStore');
const { encode } = require('../../drivers/modbusTcp/codec');
const { createFakeLogger } = require('../helpers/fakeLogger');

// Транспорт-подделка: память контроллера, управляемые отказы
function createFakeTransport() {
  const mem = { holding: new Array(1000).fill(0), input: new Array(1000).fill(0), coil: new Array(1000).fill(false), discrete: new Array(1000).fill(false) };
  let open = false;
  let closeHandler = null;
  const t = {
    mem,
    failConnect: null,
    timeout: false,
    illegal: [],
    requests: [],
    connect: jest.fn(async () => {
      if (t.failConnect) throw new ModbusError('transport', t.failConnect);
      open = true;
    }),
    isOpen: () => open,
    onClose: (fn) => { closeHandler = fn; },
    close: jest.fn(() => { open = false; }),
    drop() {
      open = false;
      if (closeHandler) closeHandler();
    },
    async read(unit, area, address, length) {
      t.requests.push(`${area}:${address}+${length}`);
      if (!open) throw new ModbusError('transport', 'нет соединения');
      if (t.timeout) throw new ModbusError('transport', 'нет ответа (таймаут)');
      if (t.illegal.some(([a, f, to]) => a === area && address <= to && address + length - 1 >= f)) {
        throw new ModbusError('exception', 'исключение Modbus 2 (недопустимый адрес)', 2);
      }
      return mem[area].slice(address, address + length);
    },
    writeCoil: jest.fn(async (unit, address, v) => { mem.coil[address] = v; }),
    writeRegister: jest.fn(async (unit, address, v) => { mem.holding[address] = v; }),
    writeRegisters: jest.fn(async (unit, address, vs) => { mem.holding.splice(address, vs.length, ...vs); }),
  };
  return t;
}

const POINTS = {
  Temp: { point: { area: 'holding', address: 100, type: 'float32', scale: 1, offset: 0 }, dataType: 'Float' },
  Valve: { point: { area: 'holding', address: 102, type: 'int16', scale: 0.1, offset: 0 }, dataType: 'Float' },
  Alarm: { point: { area: 'holding', address: 12, type: 'bool', bit: 1 }, dataType: 'Boolean' },
  Run: { point: { area: 'holding', address: 12, type: 'bool', bit: 4 }, dataType: 'Boolean' },
  Cmd: { point: { area: 'coil', address: 3, type: 'bool' }, dataType: 'Boolean' },
  Hours: { point: { area: 'input', address: 5, type: 'uint32', scale: 1, offset: 0 }, dataType: 'UInt32' },
};

async function waitFor(fn, ms = 2000) {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error('условие не выполнилось');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('modbus device', () => {
  let transport;
  let store;
  let logger;
  let device;

  function setup(options = {}) {
    transport = createFakeTransport();
    logger = createFakeLogger();
    const entries = Object.entries(POINTS).map(([n, p]) => ({ tagId: `B1/A/${n}`, unitId: 1, byteOrder: 'ABCD', point: p.point }));
    const tags = new Map(Object.entries(POINTS).map(([n, p]) => [`B1/A/${n}`, { id: `B1/A/${n}`, dataType: p.dataType, deadband: 0 }]));
    store = createTagStore({ tags, logger });
    device = createModbusDevice({
      host: '10.0.0.1',
      port: 502,
      entries,
      tagStore: store,
      logger,
      transport,
      options: { pollMs: 10, failLimit: 2, maxGap: 4, reconnectMinMs: 10, reconnectMaxMs: 40, ...options },
    });
  }

  afterEach(async () => {
    if (device) await device.stop();
  });

  function loadValues() {
    transport.mem.holding.splice(100, 2, ...encode(POINTS.Temp.point, 21.5).words);
    transport.mem.holding[102] = 455;
    transport.mem.holding[12] = 0b10010;
    transport.mem.input.splice(5, 2, 0, 1234);
  }

  test('опрос: значения по блокам, на связи — в dev-логе', async () => {
    setup();
    loadValues();
    device.start();
    await waitFor(() => store.get('B1/A/Hours').quality === 'good');
    expect(store.get('B1/A/Temp').value).toBe(21.5);
    expect(store.get('B1/A/Valve').value).toBe(45.5);
    expect(store.get('B1/A/Alarm').value).toBe(true);
    expect(store.get('B1/A/Run').value).toBe(true);
    expect(store.get('B1/A/Cmd').value).toBe(false);
    expect(store.get('B1/A/Hours').value).toBe(1234);
    // Блоки: holding 12 (биты) отдельно от 100–102 (разрыв больше maxGap), input, coil
    expect(device.status()).toMatchObject({ connected: true, online: true, blocks: 4, tags: 6 });
    expect(logger.lines.dev.join('\n')).toMatch(/10.0.0.1:502 - на связи/);
    expect(logger.lines.info).toEqual([]);
  });

  test('нет подключения: теги COMM_ERROR, лог один раз, пауза растёт', async () => {
    setup();
    transport.failConnect = 'ECONNREFUSED';
    device.start();
    await waitFor(() => transport.connect.mock.calls.length >= 4);
    expect(store.get('B1/A/Temp')).toMatchObject({ quality: 'bad', code: 'COMM_ERROR' });
    expect(logger.lines.error).toEqual(['[ModbusTCP] - 10.0.0.1:502 - нет данных от контроллера: ECONNREFUSED']);
    transport.failConnect = null;
    loadValues();
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    expect(logger.lines.error).toHaveLength(1);
  });

  test('таймауты: после failLimit подряд — COMM_ERROR, затем восстановление с записью в лог', async () => {
    setup();
    loadValues();
    device.start();
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    transport.timeout = true;
    await waitFor(() => store.get('B1/A/Temp').code === 'COMM_ERROR');
    // Значение сохраняется с плохим качеством
    expect(store.get('B1/A/Temp').value).toBe(21.5);
    expect(transport.close).toHaveBeenCalled();
    expect(logger.lines.error[0]).toMatch(/нет связи: нет ответа \(таймаут\) \(2 раза подряд\)/);
    // Контроллер принимает соединение, но молчит: лог не «мигает»
    await waitFor(() => transport.connect.mock.calls.length >= 4);
    expect(logger.lines.error).toHaveLength(1);
    expect(logger.lines.info).toEqual([]);
    transport.timeout = false;
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    expect(logger.lines.info).toEqual(['[ModbusTCP] - 10.0.0.1:502 - связь восстановлена']);
  });

  test('один таймаут меньше failLimit не портит качество', async () => {
    setup({ failLimit: 3 });
    loadValues();
    device.start();
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    const changes = [];
    store.subscribe((c) => changes.push(c));
    const origRead = transport.read;
    let first = true;
    transport.read = async (...a) => {
      if (first) { first = false; throw new ModbusError('transport', 'нет ответа (таймаут)'); }
      return origRead(...a);
    };
    await new Promise((r) => setTimeout(r, 60));
    expect(changes.filter((c) => c.quality !== 'good')).toEqual([]);
  });

  test('обрыв соединения контроллером — сразу COMM_ERROR и переподключение', async () => {
    setup();
    loadValues();
    device.start();
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    const calls = transport.connect.mock.calls.length;
    transport.drop();
    expect(store.get('B1/A/Temp').code).toBe('COMM_ERROR');
    expect(logger.lines.error[0]).toMatch(/соединение закрыто контроллером/);
    await waitFor(() => transport.connect.mock.calls.length > calls && store.get('B1/A/Temp').quality === 'good');
  });

  test('исключение на блок: разбиение по точкам, неверная точка — CONFIG_ERROR', async () => {
    setup({ maxGap: 10 });
    loadValues();
    // 100–102 читаются одним блоком; адрес 102 «не существует»
    transport.illegal.push(['holding', 102, 102]);
    device.start();
    await waitFor(() => store.get('B1/A/Valve').code === 'CONFIG_ERROR' && store.get('B1/A/Temp').quality === 'good');
    expect(store.get('B1/A/Temp').value).toBe(21.5);
    expect(logger.lines.info[0]).toMatch(/блок holding:100\+3 отвергнут .* опрос по одной точке/);
    expect(logger.lines.error.filter((l) => /B1\/A\/Valve: holding:102/.test(l))).toHaveLength(1);
    // Связь при этом есть
    expect(device.status().online).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(logger.lines.error).toHaveLength(1);
    // Исправили программу контроллера — точка заработала
    transport.illegal.splice(0);
    await waitFor(() => store.get('B1/A/Valve').quality === 'good');
  });

  test('запись регистра, coil и бита с подтверждением чтением', async () => {
    setup();
    loadValues();
    device.start();
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');

    await expect(device.write('B1/A/Valve', 12.3)).resolves.toEqual({ ok: true, value: 12.3 });
    expect(transport.writeRegister).toHaveBeenCalledWith(1, 102, 123);
    expect(store.get('B1/A/Valve').value).toBe(12.3);

    await expect(device.write('B1/A/Temp', 18.5)).resolves.toEqual({ ok: true, value: 18.5 });
    expect(transport.writeRegisters).toHaveBeenCalledWith(1, 100, encode(POINTS.Temp.point, 18.5).words);

    await expect(device.write('B1/A/Cmd', true)).resolves.toEqual({ ok: true, value: true });
    expect(transport.writeCoil).toHaveBeenCalledWith(1, 3, true);

    // Бит 1 сбрасывается, бит 4 сохраняется
    await expect(device.write('B1/A/Alarm', false)).resolves.toEqual({ ok: true, value: false });
    expect(transport.mem.holding[12]).toBe(0b10000);
    expect(device.status()).toMatchObject({ writes: 4, writeErrors: 0 });
  });

  test('подтверждение возвращает то, что реально в контроллере', async () => {
    setup();
    loadValues();
    device.start();
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    // Контроллер ограничивает значение: пишет не больше 500 (50 %)
    transport.writeRegister.mockImplementationOnce(async (u, a, v) => { transport.mem.holding[a] = Math.min(v, 500); });
    await expect(device.write('B1/A/Valve', 80)).resolves.toEqual({ ok: true, value: 50 });
    expect(store.get('B1/A/Valve').value).toBe(50);
  });

  test('ошибки записи: нет связи, вне диапазона, отказ контроллера, чужой тег', async () => {
    setup();
    await expect(device.write('B1/A/Valve', 1)).resolves.toMatchObject({ ok: false, code: 'NOT_CONNECTED' });
    loadValues();
    device.start();
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    await expect(device.write('B1/A/Valve', 5000)).resolves.toMatchObject({ ok: false, code: 'OUT_OF_RANGE', message: expect.stringMatching(/-3276.8…3276.7/) });
    await expect(device.write('B1/A/Cmd', 1)).resolves.toMatchObject({ ok: false, code: 'OUT_OF_RANGE', message: 'ожидается true или false' });
    transport.writeRegister.mockRejectedValueOnce(new ModbusError('exception', 'исключение Modbus 3 (недопустимое значение)', 3));
    await expect(device.write('B1/A/Valve', 10)).resolves.toMatchObject({ ok: false, code: 'WRITE_FAILED', message: expect.stringMatching(/исключение Modbus 3/) });
    expect(store.get('B1/A/Valve').value).toBe(45.5);
    await expect(device.write('B1/X/Y', 1)).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(device.status().writeErrors).toBe(1);
  });

  test('запись идёт раньше очередных чтений', async () => {
    setup({ maxGap: 0 });
    loadValues();
    device.start();
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    transport.requests.splice(0);
    await device.write('B1/A/Cmd', true);
    const i = transport.requests.indexOf('coil:3+1');
    // Между началом записи и подтверждением нет чужих чтений (кроме, возможно, уже начатого)
    expect(transport.writeCoil).toHaveBeenCalled();
    expect(i).toBeLessThanOrEqual(1);
  });

  test('stop: опрос прекращается, теги NOT_CONNECTED', async () => {
    setup();
    loadValues();
    device.start();
    await waitFor(() => store.get('B1/A/Temp').quality === 'good');
    await device.stop();
    expect(store.get('B1/A/Temp')).toMatchObject({ quality: 'bad', code: 'NOT_CONNECTED', value: 21.5 });
    const n = transport.requests.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(transport.requests.length).toBe(n);
    await expect(device.write('B1/A/Cmd', true)).resolves.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});
