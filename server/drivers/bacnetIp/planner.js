// drivers/bacnetIp/planner.js
// Разбивка объектов устройства на запросы ReadPropertyMultiple.
//
// Каждый объект читается двумя свойствами: presentValue и statusFlags. Размер ответа
// оценивается сверху: заголовок ответа плюс на объект ~24 байта (идентификатор,
// скобки, два свойства с значениями), для characterstringValue — 80 байт. Число объектов
// в запросе — сколько помещается в maxApdu устройства, но не больше maxObjects.
// Сегментацию драйвер не использует: N30 и многие контроллеры её не поддерживают,
// а короткие запросы проще повторить. Если устройство всё же отвергнет запрос
// (abort: ответ не помещается), device.js делит запрос пополам.
'use strict';

const RESPONSE_HEADER = 8;
const BYTES_PER_OBJECT = 24;
const BYTES_PER_STRING_OBJECT = 80;

const objectBytes = (o) => (o.point.objectType === 'characterstringValue' ? BYTES_PER_STRING_OBJECT : BYTES_PER_OBJECT);

// objects — [{ key, objectId, point, ... }] в порядке опроса. Возвращает массив групп объектов.
function buildRequests(objects, { maxApdu = 480, maxObjects = 20 } = {}) {
  const budget = Math.max(maxApdu - RESPONSE_HEADER, BYTES_PER_OBJECT);
  const requests = [];
  let current = [];
  let size = 0;
  for (const o of objects) {
    const b = objectBytes(o);
    if (current.length && (current.length >= maxObjects || size + b > budget)) {
      requests.push(current);
      current = [];
      size = 0;
    }
    current.push(o);
    size += b;
  }
  if (current.length) requests.push(current);
  return requests;
}

// Деление запроса пополам (после отказа устройства). Один объект не делится.
function splitRequest(request) {
  if (request.length < 2) return [request];
  const half = Math.ceil(request.length / 2);
  return [request.slice(0, half), request.slice(half)];
}

module.exports = { buildRequests, splitRequest, BYTES_PER_OBJECT };
