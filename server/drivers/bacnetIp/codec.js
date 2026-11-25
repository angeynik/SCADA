// drivers/bacnetIp/codec.js
// Преобразование значений BACnet ↔ значения параметров.
//
// Точка: objectType (analogInput … characterstringValue), instance, priority, scale, offset.
// Значение параметра = presentValue × scale + offset (обычно scale 1: в BACnet значения
// уже в инженерных единицах). Запись — обратное преобразование.
//
//   analog*      REAL (а также DOUBLE, UNSIGNED, SIGNED при чтении) → число;
//                REAL округляется до 7 значащих цифр (21.1, а не 21.100000381);
//                для целочисленных параметров (Int16 … UInt32) — до целого;
//   binary*      ENUMERATED 0/1 (inactive/active) → Boolean;
//   multiState*  UNSIGNED, номер состояния с 1 → число;
//   characterstringValue  CHARACTER_STRING → String.
//
// statusFlags: fault → bad / DEVICE_FAULT, outOfService → uncertain / OUT_OF_SERVICE
// (значение задано вручную на контроллере, а не измерено), иначе good.
'use strict';

const bacnet = require('@bacnet-js/client');

const { ObjectType: OT, ApplicationTag: TAG, PropertyIdentifier: PROP, StatusFlags: SF } = bacnet;

// camelCase из конфигурации → номер типа объекта BACnet
const OBJECT_TYPES = {
  analogInput: OT.ANALOG_INPUT,
  analogOutput: OT.ANALOG_OUTPUT,
  analogValue: OT.ANALOG_VALUE,
  binaryInput: OT.BINARY_INPUT,
  binaryOutput: OT.BINARY_OUTPUT,
  binaryValue: OT.BINARY_VALUE,
  multiStateInput: OT.MULTI_STATE_INPUT,
  multiStateOutput: OT.MULTI_STATE_OUTPUT,
  multiStateValue: OT.MULTI_STATE_VALUE,
  characterstringValue: OT.CHARACTERSTRING_VALUE,
};
const OBJECT_TYPE_NAMES = Object.fromEntries(Object.entries(OBJECT_TYPES).map(([k, v]) => [v, k]));

const PV = PROP.PRESENT_VALUE;
const STATUS_FLAGS = PROP.STATUS_FLAGS;
const INTEGER_TYPES = ['Int16', 'UInt16', 'Int32', 'UInt32'];
const REAL_MAX = 3.4028234663852886e38;

const tidy = (x, digits) => Number(x.toPrecision(digits));
const kind = (objectType) => (objectType.startsWith('analog') ? 'analog'
  : objectType.startsWith('binary') ? 'binary'
    : objectType.startsWith('multiState') ? 'multiState' : 'string');

function objectIdOf(point) {
  const type = OBJECT_TYPES[point.objectType];
  if (type === undefined) throw new Error(`неизвестный тип объекта ${point.objectType}`);
  return { type, instance: point.instance };
}

const objectKey = (objectId) => `${objectId.type}:${objectId.instance}`;

// Короткая запись объекта для логов: analogInput:1701
const objectLabel = (objectId) => `${OBJECT_TYPE_NAMES[objectId.type] || objectId.type}:${objectId.instance}`;

// Сырое значение presentValue (первый элемент application data) → значение параметра.
// Значение неожиданного типа — исключение (драйвер ставит bad / BAD_VALUE).
function decode(point, dataType, appValues) {
  const item = appValues && appValues[0];
  if (!item) throw new Error('пустое значение');
  const { type, value } = item;
  const k = kind(point.objectType);
  if (k === 'binary') {
    if (type === TAG.ENUMERATED || type === TAG.UNSIGNED_INTEGER) return value !== 0;
    if (type === TAG.BOOLEAN) return Boolean(value);
    throw new Error(`binary: неожиданный тип значения ${type}`);
  }
  if (k === 'string') {
    if (type !== TAG.CHARACTER_STRING) throw new Error(`characterstring: неожиданный тип значения ${type}`);
    return String(value);
  }
  if (![TAG.REAL, TAG.DOUBLE, TAG.UNSIGNED_INTEGER, TAG.SIGNED_INTEGER, TAG.ENUMERATED].includes(type) || typeof value !== 'number') {
    throw new Error(`${k}: неожиданный тип значения ${type}`);
  }
  let raw = type === TAG.REAL ? tidy(value, 7) : value;
  const { scale = 1, offset = 0 } = point;
  if (scale !== 1 || offset !== 0) raw = tidy(raw * scale + offset, 12);
  return INTEGER_TYPES.includes(dataType) ? Math.round(raw) : raw;
}

// Значение параметра → application data для записи presentValue.
// Неподходящее значение — RangeError (драйвер отвечает OUT_OF_RANGE).
function encode(point, value) {
  const k = kind(point.objectType);
  if (k === 'binary') {
    if (typeof value !== 'boolean') throw new RangeError(`ожидается true | false, получено ${JSON.stringify(value)}`);
    return { type: TAG.ENUMERATED, value: value ? 1 : 0 };
  }
  if (k === 'string') {
    if (typeof value !== 'string') throw new RangeError(`ожидается строка, получено ${JSON.stringify(value)}`);
    return { type: TAG.CHARACTER_STRING, value };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`ожидается число, получено ${JSON.stringify(value)}`);
  const { scale = 1, offset = 0 } = point;
  const raw = scale === 1 && offset === 0 ? value : tidy((value - offset) / scale, 12);
  if (k === 'multiState') {
    if (!Number.isInteger(raw) || raw < 1) throw new RangeError(`номер состояния — целое от 1, получено ${raw}`);
    return { type: TAG.UNSIGNED_INTEGER, value: raw };
  }
  if (Math.abs(raw) > REAL_MAX) throw new RangeError(`${value} не помещается в REAL`);
  return { type: TAG.REAL, value: raw };
}

// Значение NULL для снятия команды с приоритета. Каждый раз новый объект:
// библиотека изменяет переданное значение при кодировании
const nullValue = () => ({ type: TAG.NULL, value: null });

// statusFlags (BIT_STRING) → { quality, code }. Флаги не прочитаны — good.
function statusQuality(appValues) {
  const item = appValues && appValues[0];
  if (!item || item.type !== TAG.BIT_STRING || !item.value) return { quality: 'good', code: null };
  const bytes = item.value.value || [];
  const bit = (i) => Boolean((bytes[i >> 3] || 0) & (1 << (i % 8)));
  if (bit(SF.FAULT)) return { quality: 'bad', code: 'DEVICE_FAULT' };
  if (bit(SF.OUT_OF_SERVICE)) return { quality: 'uncertain', code: 'OUT_OF_SERVICE' };
  return { quality: 'good', code: null };
}

module.exports = {
  OBJECT_TYPES,
  OBJECT_TYPE_NAMES,
  PV,
  STATUS_FLAGS,
  nullValue,
  objectIdOf,
  objectKey,
  objectLabel,
  decode,
  encode,
  statusQuality,
  kind,
};
