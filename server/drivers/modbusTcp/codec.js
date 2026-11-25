// drivers/modbusTcp/codec.js
// Преобразование между словами Modbus и значениями параметров.
//
// Точка (docs/model.md): area coil | discrete | holding | input, address, type
// bool | int16 | uint16 | int32 | uint32 | float32, bit (для бита регистра), scale, offset.
// Значение параметра = сырое × scale + offset. Запись — обратное преобразование.
//
// Порядок байт byteOrder описывает, в каком порядке байты значения A B C D
// (A — старший) приходят в двух регистрах: ABCD — как есть, CDAB — слова переставлены,
// BADC — байты в словах переставлены, DCBA — всё наоборот. Для 16-битных значений
// (и битов регистра) учитывается только перестановка байт в слове (BADC, DCBA).
'use strict';

const WORDS = { bool: 1, int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2 };
const INT_RANGE = {
  int16: [-32768, 32767],
  uint16: [0, 65535],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
};
const FLOAT32_MAX = 3.4028234663852886e38;

const isBitArea = (area) => area === 'coil' || area === 'discrete';
const swapBytes = (order) => order === 'BADC' || order === 'DCBA';
const swap16 = (w) => ((w & 0xff) << 8) | ((w >> 8) & 0xff);

// Сколько слов (регистров или битов) занимает точка
function pointSize(point) {
  return isBitArea(point.area) ? 1 : WORDS[point.type];
}

// Два регистра → 4 байта значения (старший первым)
function wordsToBytes(words, order) {
  const sent = [words[0] >> 8, words[0] & 0xff, words[1] >> 8, words[1] & 0xff];
  const bytes = Buffer.alloc(4);
  for (let i = 0; i < 4; i += 1) bytes[order.charCodeAt(i) - 65] = sent[i];
  return bytes;
}

// 4 байта значения → два регистра
function bytesToWords(bytes, order) {
  const sent = [0, 1, 2, 3].map((i) => bytes[order.charCodeAt(i) - 65]);
  return [(sent[0] << 8) | sent[1], (sent[2] << 8) | sent[3]];
}

// Убирает «хвосты» двоичной арифметики: 215 × 0.1 = 21.500000000000004 → 21.5
const tidy = (x, digits) => Number(x.toPrecision(digits));

// Сырое значение точки. words — фрагмент ответа, начиная с адреса точки
// (для coil и discrete — булевы значения, для регистров — числа 0–65535).
function decodeRaw(point, words, byteOrder = 'ABCD') {
  if (isBitArea(point.area)) return Boolean(words[0]);
  const w0 = swapBytes(byteOrder) ? swap16(words[0]) : words[0];
  switch (point.type) {
    case 'bool': return ((w0 >> point.bit) & 1) === 1;
    case 'uint16': return w0;
    case 'int16': return w0 >= 0x8000 ? w0 - 0x10000 : w0;
    case 'uint32': return wordsToBytes(words, byteOrder).readUInt32BE(0);
    case 'int32': return wordsToBytes(words, byteOrder).readInt32BE(0);
    // float32 точен до 7 значащих цифр: 21.1 приходит как 21.100000381…
    case 'float32': return tidy(wordsToBytes(words, byteOrder).readFloatBE(0), 7);
    default: throw new Error(`неизвестный тип точки ${point.type}`);
  }
}

// Значение параметра из слов ответа
function decode(point, words, byteOrder) {
  const raw = decodeRaw(point, words, byteOrder);
  if (typeof raw === 'boolean') return raw;
  const { scale = 1, offset = 0 } = point;
  if (scale === 1 && offset === 0) return raw;
  return tidy(raw * scale + offset, 12);
}

// Значение параметра → что записать в контроллер:
//   { coil: true|false }            — coil;
//   { bit: n, state: true|false }   — бит регистра (нужно чтение-изменение-запись);
//   { words: [..] }                 — регистры.
// Значение не того типа или вне диапазона типа точки — RangeError с понятным текстом.
function encode(point, value, byteOrder = 'ABCD') {
  if (point.type === 'bool') {
    if (typeof value !== 'boolean') throw new RangeError('ожидается true или false');
    return point.area === 'coil' ? { coil: value } : { bit: point.bit, state: value };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('ожидается число');
  const { scale = 1, offset = 0 } = point;
  let raw = tidy((value - offset) / scale, 12);

  if (point.type === 'float32') {
    if (Math.abs(raw) > FLOAT32_MAX) throw new RangeError('значение вне диапазона float32');
    const bytes = Buffer.alloc(4);
    bytes.writeFloatBE(raw, 0);
    return { words: bytesToWords(bytes, byteOrder) };
  }

  raw = Math.round(raw);
  const [min, max] = INT_RANGE[point.type];
  if (raw < min || raw > max) {
    const lo = tidy(min * scale + offset, 12);
    const hi = tidy(max * scale + offset, 12);
    throw new RangeError(`значение вне диапазона точки (${Math.min(lo, hi)}…${Math.max(lo, hi)})`);
  }
  if (WORDS[point.type] === 1) {
    const w = raw & 0xffff;
    return { words: [swapBytes(byteOrder) ? swap16(w) : w] };
  }
  const bytes = Buffer.alloc(4);
  if (point.type === 'int32') bytes.writeInt32BE(raw, 0);
  else bytes.writeUInt32BE(raw, 0);
  return { words: bytesToWords(bytes, byteOrder) };
}

// Новое значение регистра после установки бита (с учётом перестановки байт)
function setBit(word, bit, state, byteOrder = 'ABCD') {
  const swap = swapBytes(byteOrder);
  let w = swap ? swap16(word) : word;
  w = state ? w | (1 << bit) : w & ~(1 << bit) & 0xffff;
  return swap ? swap16(w) : w;
}

module.exports = { pointSize, decodeRaw, decode, encode, setBit, isBitArea };
