// core/quality.js
// Качество значения тега и машинные коды причин.
// Качество: good | uncertain | bad. У good кода нет (null), у остальных код обязателен.
// Каждый код однозначно отображается в имя StatusCode OPC UA (таблица OPCUA_STATUS),
// чтобы OPC UA-сервер и WebSocket-шлюз показывали одно и то же.
'use strict';

const QUALITY = Object.freeze({ GOOD: 'good', UNCERTAIN: 'uncertain', BAD: 'bad' });

// Код → качество, с которым он допустим
const CODES = Object.freeze({
  NOT_CONNECTED: QUALITY.BAD, // значение ещё не получено (после запуска) или драйвер выключен
  COMM_ERROR: QUALITY.BAD, // нет связи с контроллером
  CONFIG_ERROR: QUALITY.BAD, // ошибка привязки: нет такого регистра или объекта
  BAD_VALUE: QUALITY.BAD, // драйвер передал значение не того типа или вне диапазона типа
  DEVICE_FAULT: QUALITY.BAD, // контроллер сообщает о неисправности точки (BACnet Reliability, Fault)
  STALE: QUALITY.UNCERTAIN, // значение давно не обновлялось
  OUT_OF_SERVICE: QUALITY.UNCERTAIN, // точка выведена из работы на контроллере, значение задано вручную (BACnet Out_Of_Service)
});

const OPCUA_STATUS = Object.freeze({
  good: 'Good',
  NOT_CONNECTED: 'BadNotConnected',
  COMM_ERROR: 'BadCommunicationError',
  CONFIG_ERROR: 'BadConfigurationError',
  BAD_VALUE: 'BadTypeMismatch',
  DEVICE_FAULT: 'BadDeviceFailure',
  STALE: 'UncertainLastUsableValue',
  OUT_OF_SERVICE: 'UncertainSubstituteValue',
});

// Проверка пары качество + код. Возвращает текст ошибки или null.
function checkQuality(quality, code) {
  if (quality === QUALITY.GOOD) return code == null ? null : `у качества good не бывает кода (${code})`;
  if (!Object.values(QUALITY).includes(quality)) return `неизвестное качество "${quality}"`;
  if (!(code in CODES)) return `неизвестный код "${code}"`;
  if (CODES[code] !== quality) return `код ${code} допустим только с качеством ${CODES[code]}`;
  return null;
}

function toOpcUaStatus(quality, code) {
  return quality === QUALITY.GOOD ? OPCUA_STATUS.good : OPCUA_STATUS[code];
}

module.exports = { QUALITY, CODES, checkQuality, toOpcUaStatus };
