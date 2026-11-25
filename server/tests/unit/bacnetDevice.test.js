'use strict';

const bacnet = require('@bacnet-js/client');
const { createBacnetDevice } = require('../../drivers/bacnetIp/device');
const { BacnetError } = require('../../drivers/bacnetIp/transport');
const { createTagStore } = require('../../core/tagStore');
const { createFakeLogger } = require('../helpers/fakeLogger');

const { ApplicationTag: TAG, PropertyIdentifier: P, ObjectType: OT, StatusFlagsBitString, StatusFlags: SF, ErrorCode: EC, AbortReason: AR } = bacnet;
const DEVICE_ID = 30001;
const k = (type, instance) => `${type}:${instance}`;

// Транспорт-подделка: объекты устройства, управляемые отказы
function createFakeTransport() {
  const objects = new Map();
  const t = {
    objects,
    timeout: false,
    wrongDevice: false,
    rejectCov: false,
    // Ошибка на весь запрос, если в нём есть неизвестный объект (так отвечают некоторые устройства)
    wholeRequestError: false,
    maxObjects: null,
    requests: [],
    subs: new Map(),
    writes: [],
    set(type, instance, pv, flags = []) {
      objects.set(k(type, instance), { pv, flags });
    },
    isOpen: () => true,
    async readMultiple(address, specs) {
      t.requests.push(specs.map((s) => k(s.objectId.type, s.objectId.instance)).join(','));
      if (t.timeout) throw new BacnetError('timeout', 'нет ответа (таймаут)');
      if (t.maxObjects && specs.length > t.maxObjects) throw new BacnetError('abort', 'запрос прерван устройством (segmentation_not_supported)', { reason: AR.SEGMENTATION_NOT_SUPPORTED });
      const unknown = (s) => s.objectId.type !== OT.DEVICE && !objects.has(k(s.objectId.type, s.objectId.instance));
      if (t.wholeRequestError && specs.length > 1 && specs.some(unknown)) {
        throw new BacnetError('error', 'ошибка BACnet object/unknown_object', { errorClass: 1, errorCode: EC.UNKNOWN_OBJECT });
      }
      return specs.map((s) => {
        const props = {};
        if (s.objectId.type === OT.DEVICE) {
          if (t.wrongDevice || s.objectId.instance !== DEVICE_ID) {
            throw new BacnetError('error', 'ошибка BACnet object/unknown_object', { errorClass: 1, errorCode: EC.UNKNOWN_OBJECT });
          }
          for (const id of s.properties) props[id] = { value: [{ type: TAG.UNSIGNED_INTEGER, value: id === P.MAX_APDU_LENGTH_ACCEPTED ? 206 : 0 }] };
          return { objectId: s.objectId, props };
        }
        const o = objects.get(k(s.objectId.type, s.objectId.instance));
        for (const id of s.properties) {
          if (!o) props[id] = { error: { errorClass: 1, errorCode: 31, message: 'ошибка BACnet object/unknown_object' } };
          else if (id === P.PRESENT_VALUE) props[id] = { value: [o.pv] };
          else if (id === P.STATUS_FLAGS) props[id] = { value: [{ type: TAG.BIT_STRING, value: new StatusFlagsBitString(...o.flags) }] };
        }
        return { objectId: s.objectId, props };
      });
    },
    subscribeCov: jest.fn(async (address, objectId, processId, lifetime, cancel) => {
      if (t.timeout) throw new BacnetError('timeout', 'нет ответа (таймаут)');
      if (t.rejectCov && !cancel) throw new BacnetError('error', 'ошибка BACnet services/service_request_denied', { errorClass: 5, errorCode: 29 });
      if (cancel) t.subs.delete(k(objectId.type, objectId.instance));
      else t.subs.set(k(objectId.type, objectId.instance), lifetime);
    }),
    writeProperty: jest.fn(async (address, objectId, propId, value, priority) => {
      if (t.timeout) throw new BacnetError('timeout', 'нет ответа (таймаут)');
      const o = objects.get(k(objectId.type, objectId.instance));
      if (objectId.type === OT.ANALOG_VALUE && value.type === TAG.REAL && value.value > 100) {
        throw new BacnetError('error', 'ошибка BACnet property/value_out_of_range', { errorClass: 2, errorCode: 37 });
      }
      t.writes.push({ object: k(objectId.type, objectId.instance), value: value.value, priority });
      if (value.type === TAG.NULL) o.pv = o.relinquish || { type: o.pv.type, value: 0 };
      else o.pv = value;
    }),
  };
  return t;
}

const POINTS = {
  Temp: { point: { objectType: 'analogInput', instance: 1 }, dataType: 'Float' },
  Sp: { point: { objectType: 'analogValue', instance: 2 }, dataType: 'Float' },
  Cmd: { point: { objectType: 'binaryOutput', instance: 3 }, dataType: 'Boolean' },
  Mode: { point: { objectType: 'multiStateValue', instance: 4, offset: -1, priority: 10 }, dataType: 'UInt16' },
  Run: { point: { objectType: 'binaryInput', instance: 5 }, dataType: 'Boolean' },
};

async function waitFor(fn, ms = 2000) {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error('условие не выполнилось');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('bacnet device', () => {
  let transport;
  let store;
  let logger;
  let device;

  function setup(options = {}, { address = '10.0.0.30', points = POINTS } = {}) {
    transport = createFakeTransport();
    transport.set(OT.ANALOG_INPUT, 1, { type: TAG.REAL, value: 21.100000381469727 });
    transport.set(OT.ANALOG_VALUE, 2, { type: TAG.REAL, value: 20 });
    transport.set(OT.BINARY_OUTPUT, 3, { type: TAG.ENUMERATED, value: 0 });
    transport.set(OT.MULTI_STATE_VALUE, 4, { type: TAG.UNSIGNED_INTEGER, value: 2 });
    transport.set(OT.BINARY_INPUT, 5, { type: TAG.ENUMERATED, value: 1 });
    logger = createFakeLogger();
    const entries = Object.entries(points).map(([n, p]) => ({ tagId: `B1/A/${n}`, dataType: p.dataType, point: p.point }));
    const tags = new Map(Object.entries(points).map(([n, p]) => [`B1/A/${n}`, { id: `B1/A/${n}`, dataType: p.dataType, deadband: 0 }]));
    store = createTagStore({ tags, logger });
    device = createBacnetDevice({
      deviceId: DEVICE_ID,
      address,
      entries,
      transport,
      tagStore: store,
      logger,
      options: { pollMs: 20, failLimit: 2, reconnectMinMs: 10, reconnectMaxMs: 40, covLifetimeS: 300, ...options },
    });
  }

  afterEach(async () => {
    if (device) await device.stop();
    device = null;
  });

  const value = (n) => store.get(`B1/A/${n}`);
  const allGood = () => Object.keys(POINTS).every((n) => value(n).quality === 'good');

  test('опознание, чтение всех типов, затем подписка COV и выход из опроса', async () => {
    setup();
    device.start();
    await waitFor(allGood);
    expect(Object.fromEntries(Object.keys(POINTS).map((n) => [n, value(n).value]))).toEqual({ Temp: 21.1, Sp: 20, Cmd: false, Mode: 1, Run: true });
    await waitFor(() => device.status().covObjects === 5);
    expect(transport.subs.get(k(OT.ANALOG_INPUT, 1))).toBe(300);
    expect(device.status()).toMatchObject({ online: true, maxApdu: 206, requests: 0, configErrors: 0 });
    // Все объекты на COV — опрашивается только объект device (проверка связи)
    transport.requests.length = 0;
    await waitFor(() => transport.requests.length >= 2);
    expect(transport.requests.every((r) => r === `${OT.DEVICE}:${DEVICE_ID}`)).toBe(true);
    expect(logger.lines.dev.join('\n')).toMatch(/на связи \(10\.0\.0\.30\)/);
  });

  test('уведомление COV обновляет значение и флаги', async () => {
    setup();
    device.start();
    await waitFor(() => device.status().covObjects === 5);
    device.onCov({ objectId: { type: OT.ANALOG_INPUT, instance: 1 }, values: { [P.PRESENT_VALUE]: [{ type: TAG.REAL, value: 25.5 }] } });
    expect(value('Temp')).toMatchObject({ value: 25.5, quality: 'good' });
    device.onCov({
      objectId: { type: OT.ANALOG_INPUT, instance: 1 },
      values: { [P.PRESENT_VALUE]: [{ type: TAG.REAL, value: 26 }], [P.STATUS_FLAGS]: [{ type: TAG.BIT_STRING, value: new StatusFlagsBitString(SF.FAULT) }] },
    });
    expect(value('Temp')).toMatchObject({ value: 26, quality: 'bad', code: 'DEVICE_FAULT' });
    // Без presentValue и для чужого объекта — ничего
    device.onCov({ objectId: { type: OT.ANALOG_INPUT, instance: 1 }, values: {} });
    device.onCov({ objectId: { type: OT.ANALOG_INPUT, instance: 99 }, values: { [P.PRESENT_VALUE]: [{ type: TAG.REAL, value: 1 }] } });
    expect(value('Temp').value).toBe(26);
    expect(device.status().covNotifications).toBe(3);
  });

  test('подписка продлевается на половине срока', async () => {
    setup({ covLifetimeS: 0.1 });
    device.start();
    await waitFor(() => device.status().covObjects === 5);
    const first = transport.subscribeCov.mock.calls.length;
    await waitFor(() => transport.subscribeCov.mock.calls.length >= first + 5);
  });

  test('без COV — только опрос; outOfService — uncertain', async () => {
    setup({ cov: false });
    transport.objects.get(k(OT.ANALOG_INPUT, 1)).flags = [SF.OUT_OF_SERVICE];
    device.start();
    await waitFor(() => value('Sp').quality === 'good');
    expect(value('Temp')).toMatchObject({ quality: 'uncertain', code: 'OUT_OF_SERVICE', value: 21.1 });
    transport.objects.get(k(OT.ANALOG_INPUT, 1)).pv = { type: TAG.REAL, value: 30 };
    await waitFor(() => value('Temp').value === 30);
    expect(transport.subscribeCov).not.toHaveBeenCalled();
    expect(device.status().requests).toBe(1);
  });

  test('подписка отвергнута — объекты остаются в опросе, лог один раз', async () => {
    setup();
    transport.rejectCov = true;
    device.start();
    await waitFor(allGood);
    await waitFor(() => transport.subscribeCov.mock.calls.length >= 5);
    transport.objects.get(k(OT.ANALOG_VALUE, 2)).pv = { type: TAG.REAL, value: 24 };
    await waitFor(() => value('Sp').value === 24);
    expect(device.status().covObjects).toBe(0);
    expect(transport.subscribeCov).toHaveBeenCalledTimes(5);
    expect(logger.lines.info.filter((l) => /подписка COV не принята/.test(l))).toHaveLength(1);
  });

  test('неизвестный объект — CONFIG_ERROR, остальные работают; объект появился — читается', async () => {
    setup({ cov: false });
    transport.objects.delete(k(OT.ANALOG_VALUE, 2));
    device.start();
    await waitFor(() => value('Sp').code === 'CONFIG_ERROR' && value('Temp').quality === 'good');
    expect(value('Cmd').quality).toBe('good');
    await waitFor(() => device.status().requests === 2); // неверный объект — отдельным запросом
    transport.set(OT.ANALOG_VALUE, 2, { type: TAG.REAL, value: 19 });
    await waitFor(() => value('Sp').quality === 'good');
    expect(value('Sp').value).toBe(19);
    expect(logger.lines.error.filter((l) => /analogValue:2/.test(l))).toHaveLength(1);
    expect(logger.lines.info.join('\n')).toMatch(/analogValue:2: объект снова читается/);
  });

  test('ошибка на весь запрос — деление пополам до неверного объекта', async () => {
    setup({ cov: false });
    transport.wholeRequestError = true;
    transport.objects.delete(k(OT.BINARY_INPUT, 5));
    device.start();
    await waitFor(() => value('Run').code === 'CONFIG_ERROR' && value('Mode').quality === 'good');
    expect(['Temp', 'Sp', 'Cmd', 'Mode'].every((n) => value(n).quality === 'good')).toBe(true);
    expect(device.status().maxObjectsPerRequest).toBe(20); // предел не уменьшается: дело не в размере
  });

  test('abort «не помещается» — предел объектов в запросе уменьшается', async () => {
    setup({ cov: false });
    transport.maxObjects = 2;
    device.start();
    await waitFor(allGood);
    await waitFor(() => device.status().requests === 3);
    expect(device.status().maxObjectsPerRequest).toBe(2);
    expect(logger.lines.info.join('\n')).toMatch(/запрос из 5 объектов отвергнут .*не больше 3/);
  });

  test('нет ответа — COMM_ERROR после failLimit, восстановление и новая подписка', async () => {
    setup();
    device.start();
    await waitFor(() => device.status().covObjects === 5);
    transport.timeout = true;
    await waitFor(() => value('Temp').code === 'COMM_ERROR');
    expect(value('Temp').value).toBe(21.1); // последнее значение сохраняется
    expect(device.status()).toMatchObject({ online: false, covObjects: 0 });
    expect(logger.lines.error.filter((l) => /нет связи: нет ответа \(таймаут\) \(2 раза подряд\)/.test(l))).toHaveLength(1);
    // Уведомления COV без связи не принимаются
    device.onCov({ objectId: { type: OT.ANALOG_INPUT, instance: 1 }, values: { [P.PRESENT_VALUE]: [{ type: TAG.REAL, value: 99 }] } });
    expect(value('Temp').value).toBe(21.1);
    transport.timeout = false;
    await waitFor(allGood);
    await waitFor(() => device.status().covObjects === 5);
    expect(logger.lines.info.filter((l) => /связь восстановлена/.test(l))).toHaveLength(1);
  });

  test('по адресу другое устройство — CONFIG_ERROR для всех тегов', async () => {
    setup();
    transport.wrongDevice = true;
    device.start();
    await waitFor(() => value('Temp').code === 'CONFIG_ERROR');
    expect(logger.lines.error[0]).toMatch(/по адресу 10\.0\.0\.30 нет устройства 30001/);
  });

  test('без адреса: COMM_ERROR, пока не найдено; адрес из I-Am', async () => {
    setup({}, { address: null });
    expect(device.needsDiscovery()).toBe(true);
    device.start();
    await waitFor(() => value('Temp').code === 'COMM_ERROR');
    expect(logger.lines.error[0]).toMatch(/устройство не найдено: нет ответа I-Am/);
    device.setAddress('10.0.0.31');
    await waitFor(allGood);
    expect(device.address()).toBe('10.0.0.31');
    expect(device.needsDiscovery()).toBe(false);
    device.setAddress('10.0.0.32');
    expect(logger.lines.info.join('\n')).toMatch(/адрес изменился: 10\.0\.0\.31 → 10\.0\.0\.32/);
  });

  test('адрес из конфигурации не меняется по I-Am', async () => {
    setup();
    device.setAddress('10.9.9.9');
    expect(device.address()).toBe('10.0.0.30');
    expect(device.needsDiscovery()).toBe(false);
  });

  test('запись: приоритет по умолчанию и из точки, подтверждение, снятие команды', async () => {
    setup();
    device.start();
    await waitFor(allGood);
    await expect(device.write('B1/A/Sp', 22.5)).resolves.toEqual({ ok: true, value: 22.5 });
    await expect(device.write('B1/A/Cmd', true)).resolves.toEqual({ ok: true, value: true });
    await expect(device.write('B1/A/Mode', 2)).resolves.toEqual({ ok: true, value: 2 });
    expect(value('Mode').value).toBe(2);
    await expect(device.release('B1/A/Cmd')).resolves.toEqual({ ok: true, value: false });
    expect(transport.writes).toEqual([
      { object: k(OT.ANALOG_VALUE, 2), value: 22.5, priority: 8 },
      { object: k(OT.BINARY_OUTPUT, 3), value: 1, priority: 8 },
      { object: k(OT.MULTI_STATE_VALUE, 4), value: 3, priority: 10 },
      { object: k(OT.BINARY_OUTPUT, 3), value: null, priority: 8 },
    ]);
  });

  test('запись: ошибки', async () => {
    setup({ writePriority: 12 });
    await expect(device.write('B1/A/Sp', 1)).resolves.toMatchObject({ ok: false, code: 'NOT_CONNECTED' });
    device.start();
    await waitFor(allGood);
    await expect(device.write('B1/X/Y', 1)).resolves.toMatchObject({ code: 'NOT_FOUND' });
    await expect(device.write('B1/A/Cmd', 1)).resolves.toMatchObject({ code: 'OUT_OF_RANGE' });
    await expect(device.write('B1/A/Mode', -1)).resolves.toMatchObject({ code: 'OUT_OF_RANGE' });
    await expect(device.write('B1/A/Sp', 500)).resolves.toMatchObject({ code: 'WRITE_FAILED', message: expect.stringMatching(/value_out_of_range/) });
    expect(value('Sp').value).toBe(20);
    await expect(device.write('B1/A/Sp', 30)).resolves.toEqual({ ok: true, value: 30 });
    expect(transport.writes.at(-1).priority).toBe(12);
    transport.timeout = true;
    await expect(device.write('B1/A/Sp', 31)).resolves.toMatchObject({ code: 'WRITE_FAILED', message: 'нет ответа (таймаут)' });
    expect(logger.lines.error.join('\n')).toMatch(/запись B1\/A\/Sp = 500 \(приоритет 12\): ошибка BACnet/);
  });

  test('приоритеты 1–7 запрещены', () => {
    const base = { deviceId: 1, address: 'a', transport: createFakeTransport(), tagStore: {}, logger: createFakeLogger() };
    expect(() => createBacnetDevice({ ...base, entries: [], options: { writePriority: 7 } })).toThrow(/8–16/);
    expect(() => createBacnetDevice({ ...base, entries: [{ tagId: 'B1/A/X', dataType: 'Float', point: { objectType: 'analogValue', instance: 1, priority: 1 } }] })).toThrow(/приоритет 1/);
  });

  test('значение неожиданного типа — BAD_VALUE, лог один раз', async () => {
    setup({ cov: false });
    transport.objects.get(k(OT.ANALOG_INPUT, 1)).pv = { type: TAG.CHARACTER_STRING, value: 'x' };
    device.start();
    await waitFor(() => value('Temp').code === 'BAD_VALUE');
    const n = transport.requests.length;
    await waitFor(() => transport.requests.length > n + 2);
    expect(logger.lines.error.filter((l) => /B1\/A\/Temp/.test(l))).toHaveLength(1);
  });

  test('остановка снимает подписки, теги NOT_CONNECTED', async () => {
    setup();
    device.start();
    await waitFor(() => device.status().covObjects === 5);
    await device.stop();
    expect(transport.subs.size).toBe(0);
    expect(value('Temp')).toMatchObject({ quality: 'bad', code: 'NOT_CONNECTED' });
    await expect(device.write('B1/A/Sp', 1)).resolves.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  test('несколько тегов на одном объекте', async () => {
    setup({ cov: false }, {
      points: {
        Temp: POINTS.Temp,
        TempF: { point: { objectType: 'analogInput', instance: 1, scale: 1.8, offset: 32 }, dataType: 'Float' },
      },
    });
    device.start();
    await waitFor(() => value('TempF').quality === 'good');
    expect(value('TempF').value).toBe(69.98);
    expect(device.status()).toMatchObject({ objects: 1, tags: 2 });
  });
});
