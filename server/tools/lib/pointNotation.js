// tools/lib/pointNotation.js
// Короткая запись точки привязки для таблиц (CSV): одна ячейка вместо нескольких полей.
//   Modbus: <область>:<адрес>[.<бит>][:<тип>]
//     область HR (holding), IR (input), CO (coil), DI (discrete);
//     тип I16, U16, I32, U32, F32 (по умолчанию U16 для регистров);
//     примеры: HR:100:F32, HR:12.3, CO:0, IR:30:I16.
//   BACnet: <тип объекта>:<номер>[@<приоритет записи>]
//     AI, AO, AV, BI, BO, BV, MI, MO, MV, CSV (characterstringValue);
//     примеры: AI:1701, AV:1701@10.
// Регистр букв не важен. Возвращает объект точки в формате конфигурации (docs/model.md).
'use strict';

const MODBUS_AREAS = { HR: 'holding', IR: 'input', CO: 'coil', DI: 'discrete' };
const MODBUS_TYPES = { I16: 'int16', U16: 'uint16', I32: 'int32', U32: 'uint32', F32: 'float32' };
const BACNET_TYPES = {
  AI: 'analogInput',
  AO: 'analogOutput',
  AV: 'analogValue',
  BI: 'binaryInput',
  BO: 'binaryOutput',
  BV: 'binaryValue',
  MI: 'multiStateInput',
  MO: 'multiStateOutput',
  MV: 'multiStateValue',
  CSV: 'characterstringValue',
};

const MODBUS_RE = /^(HR|IR|CO|DI):(\d+)(?:\.(\d+))?(?::(I16|U16|I32|U32|F32))?$/i;
const BACNET_RE = /^(AI|AO|AV|BI|BO|BV|MI|MO|MV|CSV):(\d+)(?:@(\d+))?$/i;

function parsePoint(driver, text) {
  const s = String(text).trim();
  if (driver === 'modbus') {
    const m = MODBUS_RE.exec(s);
    if (!m) throw new Error(`"${s}": ожидается HR|IR|CO|DI:<адрес>[.<бит>][:I16|U16|I32|U32|F32]`);
    const point = { area: MODBUS_AREAS[m[1].toUpperCase()], address: Number(m[2]) };
    if (m[3] !== undefined) point.bit = Number(m[3]);
    if (m[4]) point.type = MODBUS_TYPES[m[4].toUpperCase()];
    return point;
  }
  if (driver === 'bacnet') {
    const m = BACNET_RE.exec(s);
    if (!m) throw new Error(`"${s}": ожидается AI|AO|AV|BI|BO|BV|MI|MO|MV|CSV:<номер>[@<приоритет>]`);
    const point = { objectType: BACNET_TYPES[m[1].toUpperCase()], instance: Number(m[2]) };
    if (m[3] !== undefined) point.priority = Number(m[3]);
    return point;
  }
  throw new Error(`неизвестный драйвер "${driver}"`);
}

module.exports = { parsePoint };
