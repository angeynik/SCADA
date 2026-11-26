// opcua/nodes.js
// Соответствие модели объекта и узлов OPC UA — чистые функции без node-opcua,
// их проверяют юнит-тесты. Пространство адресов по ним строит addressSpace.js.
//
// NodeId (строковые, в пространстве имён OPCUA_NAMESPACE_URI):
//   объект (папка)        s=B1
//   установка (Object)    s=B1/AHU-17
//   тег (Variable)        s=B1/AHU-17/SupplyTemp — равен идентификатору тега
//   свойство тега         s=B1/AHU-17/SupplyTemp-EngineeringUnits (как у node-opcua для EnumValues)
//   тип установки         s=type:AhuType, его параметры — s=type:AhuType/SupplyTemp
// Двоеточие недопустимо в идентификаторах модели, поэтому NodeId типов не пересекаются
// с объектами и установками. NodeId не зависят от порядка загрузки и источника данных.
//
// Вид переменной:
//   multiState — целочисленный параметр с states → MultiStateValueDiscreteType
//                (EnumValues и ValueAsText, клиент видит текст состояния);
//   analog     — остальные числовые → BaseAnalogType (EngineeringUnits, если есть unit;
//                EURange, если заданы min и max);
//   plain      — Boolean и String → BaseDataVariableType.
'use strict';

const typeNodeId = (templateId) => `type:${templateId}`;
const typeParamNodeId = (templateId, param) => `type:${templateId}/${param}`;
const propertyNodeId = (nodeId, name) => `${nodeId}-${name}`;

const INTEGER_TYPES = ['Int16', 'UInt16', 'Int32', 'UInt32'];
const NUMERIC_TYPES = [...INTEGER_TYPES, 'Float', 'Double'];

// states { "0": "Авто", ... } → [{ value, text }] по возрастанию или null.
// Ключи — целые числа (проверяет схема модели)
function enumValuesOf(states) {
  const list = Object.entries(states || {}).map(([k, text]) => ({ value: Number(k), text }));
  return list.length ? list.sort((a, b) => a.value - b.value) : null;
}

function variableKind(param) {
  if (INTEGER_TYPES.includes(param.dataType) && enumValuesOf(param.states)) return 'multiState';
  if (NUMERIC_TYPES.includes(param.dataType)) return 'analog';
  return 'plain';
}

// Единицы измерения: текст unit → код UNECE (Rec. 20) и описание. unitId из кода считает
// node-opcua (OPC 10000-8). Нет в таблице — код null (unitId -1), текст единицы как есть.
const UNECE = {
  '°C': ['CEL', 'градус Цельсия'],
  '%': ['P1', 'процент'],
  'ч': ['HUR', 'час'],
  'мин': ['MIN', 'минута'],
  'с': ['SEC', 'секунда'],
  'Па': ['PAL', 'паскаль'],
  'кПа': ['KPA', 'килопаскаль'],
  'бар': ['BAR', 'бар'],
  'м³/ч': ['MQH', 'кубический метр в час'],
  'м3/ч': ['MQH', 'кубический метр в час'],
  'Вт': ['WTT', 'ватт'],
  'кВт': ['KWT', 'киловатт'],
  'кВт·ч': ['KWH', 'киловатт-час'],
  'Гц': ['HTZ', 'герц'],
  'об/мин': ['RPM', 'оборот в минуту'],
  'В': ['VLT', 'вольт'],
  'А': ['AMP', 'ампер'],
  'м/с': ['MTS', 'метр в секунду'],
  'ppm': ['59', 'миллионная доля'],
};
// unit → { code, displayName, description } или null
function euInformation(unit) {
  if (!unit) return null;
  const known = UNECE[unit];
  return { code: known ? known[0] : null, displayName: unit, description: known ? known[1] : unit };
}

// EURange по min/max параметра (оба заданы) или null
function euRange(param) {
  return param.min !== undefined && param.max !== undefined ? { low: param.min, high: param.max } : null;
}

// Описание узла переменной: заголовок и пояснение параметра
function describe(param) {
  return param.description ? `${param.title}. ${param.description}` : param.title;
}

// Параметры безопасности точек входа.
// Рабочий режим: Sign и SignAndEncrypt с тремя политиками, вход только по имени и паролю.
// Режим разработки (allowInsecure): дополнительно None и анонимный вход.
const SECURE_POLICIES = ['Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss'];
function securitySettings({ allowInsecure }) {
  return allowInsecure
    ? { modes: ['None', 'Sign', 'SignAndEncrypt'], policies: ['None', ...SECURE_POLICIES], userTokens: ['Anonymous', 'UserName'], allowAnonymous: true }
    : { modes: ['Sign', 'SignAndEncrypt'], policies: [...SECURE_POLICIES], userTokens: ['UserName'], allowAnonymous: false };
}

// Код ответа commandGateway → имя StatusCode для ответа на Write и Call
const WRITE_STATUS = {
  NOT_FOUND: 'BadNodeIdUnknown',
  READ_ONLY: 'BadNotWritable',
  FORBIDDEN: 'BadUserAccessDenied',
  TYPE_MISMATCH: 'BadTypeMismatch',
  OUT_OF_RANGE: 'BadOutOfRange',
  NOT_PRIMARY: 'BadInvalidState',
  NOT_CONNECTED: 'BadNotConnected',
  NOT_SUPPORTED: 'BadNotSupported',
  WRITE_FAILED: 'BadDeviceFailure',
};
const writeStatusName = (result) => (result.ok ? 'Good' : WRITE_STATUS[result.code] || 'BadInternalError');

// Значение Float из OPC UA приходит как число float32 (22.1 → 22.100000381…):
// в шлюз — с 7 значащими цифрами, как значения BACnet REAL
const normalizeWriteValue = (dataType, v) => (dataType === 'Float' && typeof v === 'number' ? Number(v.toPrecision(7)) : v);

module.exports = {
  writeStatusName,
  normalizeWriteValue,
  WRITE_STATUS,
  typeNodeId,
  typeParamNodeId,
  propertyNodeId,
  enumValuesOf,
  variableKind,
  euInformation,
  euRange,
  describe,
  securitySettings,
  SECURE_POLICIES,
};
