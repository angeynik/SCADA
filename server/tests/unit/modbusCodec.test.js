'use strict';

const { decode, decodeRaw, encode, setBit, pointSize } = require('../../drivers/modbusTcp/codec');

const reg = (type, extra = {}) => ({ area: 'holding', address: 0, type, scale: 1, offset: 0, ...extra });

describe('modbus codec', () => {
  test('размер точки', () => {
    expect(pointSize({ area: 'coil', type: 'bool' })).toBe(1);
    expect(pointSize(reg('bool', { bit: 3 }))).toBe(1);
    expect(pointSize(reg('int16'))).toBe(1);
    expect(pointSize(reg('float32'))).toBe(2);
    expect(pointSize(reg('uint32'))).toBe(2);
  });

  test('16 бит: знак, перестановка байт', () => {
    expect(decodeRaw(reg('int16'), [0xffff])).toBe(-1);
    expect(decodeRaw(reg('int16'), [0x8000])).toBe(-32768);
    expect(decodeRaw(reg('uint16'), [0xffff])).toBe(65535);
    expect(decodeRaw(reg('uint16'), [0x3412], 'BADC')).toBe(0x1234);
    expect(decodeRaw(reg('uint16'), [0x1234], 'CDAB')).toBe(0x1234);
  });

  // 0x41A8C000 = 21.09375f: байты A=41 B=A8 C=C0 D=00
  test.each([
    ['ABCD', [0x41a8, 0xc000]],
    ['CDAB', [0xc000, 0x41a8]],
    ['BADC', [0xa841, 0x00c0]],
    ['DCBA', [0x00c0, 0xa841]],
  ])('float32 %s', (order, words) => {
    expect(decodeRaw(reg('float32'), words, order)).toBe(21.09375);
    expect(encode(reg('float32'), 21.09375, order).words).toEqual(words);
  });

  test('32-битные целые во всех порядках', () => {
    for (const order of ['ABCD', 'CDAB', 'BADC', 'DCBA']) {
      for (const [type, v] of [['uint32', 4000000000], ['int32', -123456789], ['int32', 2147483647]]) {
        const { words } = encode(reg(type), v, order);
        expect(decodeRaw(reg(type), words, order)).toBe(v);
      }
    }
    expect(encode(reg('uint32'), 0x01020304, 'ABCD').words).toEqual([0x0102, 0x0304]);
    expect(encode(reg('uint32'), 0x01020304, 'CDAB').words).toEqual([0x0304, 0x0102]);
  });

  test('float32 округляется до 7 значащих цифр', () => {
    const { words } = encode(reg('float32'), 21.1);
    expect(decode(reg('float32'), words)).toBe(21.1);
  });

  test('масштаб и смещение без «хвостов» арифметики', () => {
    expect(decode(reg('int16', { scale: 0.1 }), [215])).toBe(21.5);
    expect(decode(reg('int16', { scale: 0.1 }), [0xfffd])).toBe(-0.3);
    expect(decode(reg('uint16', { scale: 0.5, offset: -40 }), [130])).toBe(25);
    expect(encode(reg('int16', { scale: 0.1 }), 12.3).words).toEqual([123]);
    expect(encode(reg('int16', { scale: 0.1 }), -0.3).words).toEqual([0xfffd]);
    expect(encode(reg('uint16', { scale: 0.5, offset: -40 }), 25).words).toEqual([130]);
  });

  test('биты: coil, discrete, бит регистра с перестановкой байт', () => {
    expect(decode({ area: 'coil', address: 0, type: 'bool' }, [true])).toBe(true);
    expect(decode({ area: 'discrete', address: 0, type: 'bool' }, [false])).toBe(false);
    expect(decode(reg('bool', { bit: 4 }), [0x0010])).toBe(true);
    expect(decode(reg('bool', { bit: 4 }), [0x0010], 'BADC')).toBe(false);
    expect(decode(reg('bool', { bit: 12 }), [0x0010], 'BADC')).toBe(true);
  });

  test('setBit сохраняет остальные биты', () => {
    expect(setBit(0b1010, 0, true)).toBe(0b1011);
    expect(setBit(0b1011, 1, false)).toBe(0b1001);
    expect(setBit(0xffff, 15, false)).toBe(0x7fff);
    expect(setBit(0x0000, 0, true, 'BADC')).toBe(0x0100);
  });

  test('encode: виды результата', () => {
    expect(encode({ area: 'coil', address: 0, type: 'bool' }, true)).toEqual({ coil: true });
    expect(encode(reg('bool', { bit: 2 }), false)).toEqual({ bit: 2, state: false });
  });

  test('encode: ошибки типа и диапазона', () => {
    expect(() => encode({ area: 'coil', type: 'bool' }, 1)).toThrow('ожидается true или false');
    expect(() => encode(reg('int16'), '5')).toThrow('ожидается число');
    expect(() => encode(reg('int16'), NaN)).toThrow('ожидается число');
    expect(() => encode(reg('int16', { scale: 0.1 }), 3276.8)).toThrow('вне диапазона точки (-3276.8…3276.7)');
    expect(() => encode(reg('uint16'), -1)).toThrow('вне диапазона точки (0…65535)');
    expect(() => encode(reg('float32'), 1e39)).toThrow('вне диапазона float32');
    expect(encode(reg('int16'), 2.6).words).toEqual([3]);
  });
});
