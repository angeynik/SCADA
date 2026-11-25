'use strict';

const bacnet = require('@bacnet-js/client');
const codec = require('../../drivers/bacnetIp/codec');
const { buildRequests, splitRequest } = require('../../drivers/bacnetIp/planner');
const { whoIsRanges, createLimiter } = require('../../drivers/bacnetIp');
const { normalizeError, normalizeAddress, parseReadMultiple, BacnetError } = require('../../drivers/bacnetIp/transport');
const { formatBacnetPoint, parsePoint } = require('../../tools/lib/pointNotation');
const { paramGuess } = require('../../tools/bacnetDiscover');
const { layoutPoints } = require('../../tools/bacnetEmulator');

const { ApplicationTag: TAG, StatusFlagsBitString, StatusFlags: SF } = bacnet;
const real = (v) => [{ type: TAG.REAL, value: v }];

describe('bacnet codec', () => {
  test('objectId и подпись объекта', () => {
    expect(codec.objectIdOf({ objectType: 'analogInput', instance: 1701 })).toEqual({ type: 0, instance: 1701 });
    expect(codec.objectLabel({ type: 19, instance: 2 })).toBe('multiStateValue:2');
    expect(() => codec.objectIdOf({ objectType: 'loop', instance: 1 })).toThrow(/неизвестный тип/);
  });

  test('analog: REAL округляется до 7 цифр, масштаб, целые параметры', () => {
    const p = { objectType: 'analogInput', instance: 1 };
    expect(codec.decode(p, 'Float', real(21.100000381469727))).toBe(21.1);
    expect(codec.decode({ ...p, scale: 0.1, offset: -5 }, 'Float', real(250))).toBe(20);
    expect(codec.decode(p, 'UInt32', real(1000.4))).toBe(1000);
    expect(codec.decode(p, 'Float', [{ type: TAG.UNSIGNED_INTEGER, value: 7 }])).toBe(7);
    expect(() => codec.decode(p, 'Float', [{ type: TAG.CHARACTER_STRING, value: 'x' }])).toThrow(/неожиданный тип/);
    expect(() => codec.decode(p, 'Float', [])).toThrow(/пустое/);
  });

  test('binary, multiState (offset −1 для состояний с 0), characterstring', () => {
    expect(codec.decode({ objectType: 'binaryInput' }, 'Boolean', [{ type: TAG.ENUMERATED, value: 1 }])).toBe(true);
    expect(codec.decode({ objectType: 'binaryValue' }, 'Boolean', [{ type: TAG.BOOLEAN, value: false }])).toBe(false);
    expect(() => codec.decode({ objectType: 'binaryValue' }, 'Boolean', real(1))).toThrow(/binary/);
    expect(codec.decode({ objectType: 'multiStateValue', offset: -1 }, 'UInt16', [{ type: TAG.UNSIGNED_INTEGER, value: 3 }])).toBe(2);
    expect(codec.decode({ objectType: 'characterstringValue' }, 'String', [{ type: TAG.CHARACTER_STRING, value: 'Лето' }])).toBe('Лето');
    expect(() => codec.decode({ objectType: 'characterstringValue' }, 'String', real(1))).toThrow(/characterstring/);
  });

  test('encode — обратное преобразование и проверки', () => {
    expect(codec.encode({ objectType: 'analogValue', scale: 0.1, offset: -5 }, 20)).toEqual({ type: TAG.REAL, value: 250 });
    expect(codec.encode({ objectType: 'analogValue' }, 22.5)).toEqual({ type: TAG.REAL, value: 22.5 });
    expect(codec.encode({ objectType: 'binaryOutput' }, true)).toEqual({ type: TAG.ENUMERATED, value: 1 });
    expect(codec.encode({ objectType: 'multiStateValue', offset: -1 }, 0)).toEqual({ type: TAG.UNSIGNED_INTEGER, value: 1 });
    expect(codec.encode({ objectType: 'characterstringValue' }, 'a')).toEqual({ type: TAG.CHARACTER_STRING, value: 'a' });
    expect(() => codec.encode({ objectType: 'binaryOutput' }, 1)).toThrow(RangeError);
    expect(() => codec.encode({ objectType: 'multiStateValue' }, 0)).toThrow(/номер состояния/);
    expect(() => codec.encode({ objectType: 'multiStateValue' }, 1.5)).toThrow(RangeError);
    expect(() => codec.encode({ objectType: 'analogValue' }, NaN)).toThrow(/ожидается число/);
    expect(() => codec.encode({ objectType: 'analogValue' }, 1e39)).toThrow(/REAL/);
    expect(() => codec.encode({ objectType: 'characterstringValue' }, 5)).toThrow(/строка/);
    expect(codec.nullValue()).toEqual({ type: TAG.NULL, value: null });
    expect(codec.nullValue()).not.toBe(codec.nullValue());
  });

  test('statusFlags → качество', () => {
    const flags = (...bits) => [{ type: TAG.BIT_STRING, value: new StatusFlagsBitString(...bits) }];
    expect(codec.statusQuality(flags())).toEqual({ quality: 'good', code: null });
    expect(codec.statusQuality(flags(SF.IN_ALARM, SF.OVERRIDDEN))).toEqual({ quality: 'good', code: null });
    expect(codec.statusQuality(flags(SF.FAULT, SF.OUT_OF_SERVICE))).toEqual({ quality: 'bad', code: 'DEVICE_FAULT' });
    expect(codec.statusQuality(flags(SF.OUT_OF_SERVICE))).toEqual({ quality: 'uncertain', code: 'OUT_OF_SERVICE' });
    expect(codec.statusQuality(undefined)).toEqual({ quality: 'good', code: null });
  });
});

describe('bacnet planner', () => {
  const obj = (i, objectType = 'analogInput') => ({ key: `0:${i}`, point: { objectType, instance: i } });

  test('запросы ограничены maxApdu и maxObjects', () => {
    const objects = Array.from({ length: 50 }, (_, i) => obj(i));
    expect(buildRequests(objects, { maxApdu: 480, maxObjects: 100 }).map((r) => r.length)).toEqual([19, 19, 12]);
    expect(buildRequests(objects, { maxApdu: 1476, maxObjects: 20 }).map((r) => r.length)).toEqual([20, 20, 10]);
    expect(buildRequests(objects, { maxApdu: 50, maxObjects: 20 }).every((r) => r.length === 1)).toBe(true);
    expect(buildRequests([], {})).toEqual([]);
  });

  test('строковые объекты занимают больше места', () => {
    const objects = Array.from({ length: 10 }, (_, i) => obj(i, 'characterstringValue'));
    expect(buildRequests(objects, { maxApdu: 480, maxObjects: 20 }).map((r) => r.length)).toEqual([5, 5]);
  });

  test('деление запроса пополам', () => {
    expect(splitRequest([1, 2, 3])).toEqual([[1, 2], [3]]);
    expect(splitRequest([1])).toEqual([[1]]);
  });

  test('диапазоны Who-Is', () => {
    expect(whoIsRanges([30005, 30001, 30001, 30040, 31000])).toEqual([{ low: 30001, high: 30040 }, { low: 31000, high: 31000 }]);
    expect(whoIsRanges([])).toEqual([]);
  });

  test('ограничитель одновременных запросов', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const job = () => limit(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return 'ok';
    });
    await expect(Promise.all([job(), job(), job(), job(), job()])).resolves.toEqual(Array(5).fill('ok'));
    expect(peak).toBe(2);
    await expect(limit(async () => { throw new Error('x'); })).rejects.toThrow('x');
  });
});

describe('bacnet transport: разбор', () => {
  test('ошибки библиотеки → BacnetError', () => {
    expect(normalizeError(new Error('ERR_TIMEOUT'))).toMatchObject({ kind: 'timeout', message: 'нет ответа (таймаут)' });
    expect(normalizeError(new Error('BacnetError - Class:1 - Code:31'))).toMatchObject({
      kind: 'error', errorClass: 1, errorCode: 31, message: 'ошибка BACnet object/unknown_object',
    });
    expect(normalizeError(new Error('BacnetAbort - Reason:4'))).toMatchObject({ kind: 'abort', reason: 4, message: expect.stringMatching(/segmentation_not_supported/) });
    expect(normalizeError(new Error('INVALID_DECODING'))).toMatchObject({ kind: 'transport' });
    const e = new BacnetError('timeout', 't');
    expect(normalizeError(e)).toBe(e);
  });

  test('адреса: порт 47808 опускается', () => {
    expect(normalizeAddress('10.0.0.1:47808')).toBe('10.0.0.1');
    expect(normalizeAddress('10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeAddress('127.0.0.1:47809')).toBe('127.0.0.1:47809');
    expect(normalizeAddress(null)).toBeNull();
  });

  test('ответ ReadPropertyMultiple: значения и ошибки по свойствам', () => {
    const parsed = parseReadMultiple({
      values: [{
        objectId: { type: 0, instance: 1 },
        values: [
          { id: 85, index: 0, value: [{ type: TAG.REAL, value: 1 }] },
          { id: 111, index: 0, value: [{ type: TAG.ERROR, value: { errorClass: 2, errorCode: 32 } }] },
        ],
      }],
    });
    expect(parsed).toEqual([{
      objectId: { type: 0, instance: 1 },
      props: { 85: { value: [{ type: TAG.REAL, value: 1 }] }, 111: { error: { errorClass: 2, errorCode: 32, message: 'ошибка BACnet property/unknown_property' } } },
    }]);
  });
});

describe('bacnet: инструменты', () => {
  test('короткая запись точки туда и обратно', () => {
    for (const s of ['AI:1701', 'BO:2@10', 'MV:3', 'CSV:4']) expect(formatBacnetPoint(parsePoint('bacnet', s))).toBe(s);
    expect(() => formatBacnetPoint({ objectType: 'loop', instance: 1 })).toThrow(/неизвестный/);
  });

  test('черновик имени параметра из имени объекта', () => {
    const used = new Set();
    expect(paramGuess('AHU17.SA-T', used)).toBe('AHU17_SA-T');
    expect(paramGuess('AHU17.SA-T', used)).toBe('AHU17_SA-T_2');
    expect(paramGuess('1-й этаж', used)).toBe('Point');
    expect(paramGuess('', used)).toBe('Point_2');
  });

  test('раскладка объектов эмулятора по шаблону', () => {
    const points = layoutPoints({
      params: {
        Cmd: { dataType: 'Boolean', access: 'rw' },
        Run: { dataType: 'Boolean', access: 'r' },
        Mode: { dataType: 'UInt16', access: 'rw', states: { 0: 'a', 1: 'b' } },
        Stage: { dataType: 'UInt16', access: 'r', states: { 1: 'a', 2: 'b' } },
        T: { dataType: 'Float', access: 'r' },
        Sp: { dataType: 'Float', access: 'rw' },
        Note: { dataType: 'String', access: 'r' },
      },
    });
    expect(points.map((p) => p.point)).toEqual([
      { objectType: 'binaryOutput', instance: 1 },
      { objectType: 'binaryInput', instance: 2 },
      { objectType: 'multiStateValue', instance: 3, offset: -1 },
      { objectType: 'multiStateInput', instance: 4 },
      { objectType: 'analogInput', instance: 5 },
      { objectType: 'analogValue', instance: 6 },
      { objectType: 'characterstringValue', instance: 7 },
    ]);
  });
});
