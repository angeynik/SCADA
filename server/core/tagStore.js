// core/tagStore.js
// Текущие значения тегов. Единственный приёмник данных от драйверов и единственный
// источник текущих значений для OPC UA, WebSocket, тревог и архива.
//
// Значение тега: { value, quality, code, sourceTs, serverTs }
//   quality — good | uncertain | bad, code — причина (core/quality.js), у good — null;
//   sourceTs — время значения у источника (мс), serverTs — время публикации на сервере (мс).
// После запуска все теги: value null, bad / NOT_CONNECTED.
//
// Публикация (уведомление подписчиков) происходит, если изменилось качество или код,
// либо значение. Для числовых тегов с deadband > 0 значение считается изменившимся,
// когда отличается от последнего опубликованного больше чем на deadband.
// Значение не того типа (драйвер ошибся) не принимается: тег становится bad / BAD_VALUE,
// последнее значение сохраняется.
// Подписчики вызываются синхронно; исключение подписчика пишется в лог и не мешает
// остальным подписчикам и драйверу.
'use strict';

const { QUALITY, checkQuality } = require('./quality');

const INT_RANGE = {
  Int16: [-32768, 32767],
  UInt16: [0, 65535],
  Int32: [-2147483648, 2147483647],
  UInt32: [0, 4294967295],
};
const STRING_MAX = 4096;

// Подходит ли значение к типу тега
function fitsType(dataType, v) {
  if (dataType === 'Boolean') return typeof v === 'boolean';
  if (dataType === 'String') return typeof v === 'string' && v.length <= STRING_MAX;
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  const range = INT_RANGE[dataType];
  return !range || (Number.isInteger(v) && v >= range[0] && v <= range[1]);
}

function createTagStore({ tags, logger, now = Date.now }) {
  const values = new Map();
  const listeners = new Set();
  const badValueLogged = new Set();
  const started = now();

  for (const id of tags.keys()) {
    values.set(id, { value: null, quality: QUALITY.BAD, code: 'NOT_CONNECTED', sourceTs: null, serverTs: started });
  }

  function notify(id, state) {
    const change = Object.freeze({ id, ...state });
    for (const l of listeners) {
      if (l.ids && !l.ids.has(id)) continue;
      if (l.prefix && !id.startsWith(l.prefix)) continue;
      try {
        l.fn(change);
      } catch (err) {
        logger.logErrorMessage('[TagStore] - notify - ошибка подписчика:', err);
      }
    }
  }

  function valueChanged(tag, prev, value) {
    if (prev.value === null || typeof value !== 'number') return prev.value !== value;
    if (tag.deadband > 0) return Math.abs(value - prev.value) > tag.deadband;
    return prev.value !== value;
  }

  // Сохраняет и публикует, если есть изменения. Возвращает true, если опубликовано.
  function commit(id, next) {
    const prev = values.get(id);
    const tag = tags.get(id);
    const changed = prev.quality !== next.quality || prev.code !== next.code
      || valueChanged(tag, prev, next.value);
    if (!changed) return false;
    const state = { ...next, serverTs: now() };
    values.set(id, state);
    notify(id, state);
    return true;
  }

  // Новое значение от драйвера. options: { quality = 'good', code = null, sourceTs = now() }.
  // Возвращает true, если значение опубликовано.
  function update(id, value, { quality = QUALITY.GOOD, code = null, sourceTs } = {}) {
    const tag = tags.get(id);
    if (!tag) {
      logger.logDevMessage(`[TagStore] - update - неизвестный тег ${id}`);
      return false;
    }
    const qError = checkQuality(quality, code);
    if (qError) {
      logger.logErrorMessage(`[TagStore] - update - ${id}: ${qError}`);
      return false;
    }
    const prev = values.get(id);
    if (!fitsType(tag.dataType, value)) {
      if (!badValueLogged.has(id)) {
        badValueLogged.add(id);
        logger.logErrorMessage(`[TagStore] - update - ${id}: значение`, value, `не подходит к типу ${tag.dataType}`);
      }
      return commit(id, { value: prev.value, quality: QUALITY.BAD, code: 'BAD_VALUE', sourceTs: prev.sourceTs });
    }
    badValueLogged.delete(id);
    return commit(id, { value, quality, code, sourceTs: sourceTs === undefined ? now() : sourceTs });
  }

  // Смена качества без нового значения (обрыв связи, ошибка привязки). Значение сохраняется.
  function setQuality(id, quality, code) {
    if (!tags.has(id)) {
      logger.logDevMessage(`[TagStore] - setQuality - неизвестный тег ${id}`);
      return false;
    }
    const qError = quality === QUALITY.GOOD ? 'качество good ставится только вместе со значением' : checkQuality(quality, code);
    if (qError) {
      logger.logErrorMessage(`[TagStore] - setQuality - ${id}: ${qError}`);
      return false;
    }
    const prev = values.get(id);
    return commit(id, { value: prev.value, quality, code, sourceTs: prev.sourceTs });
  }

  // Подписка на изменения: filter { ids?: Iterable<string>, prefix?: string }.
  // prefix 'B1/AHU-17/' — все теги установки. Возвращает функцию отписки.
  function subscribe(fn, { ids, prefix } = {}) {
    const entry = { fn, ids: ids ? new Set(ids) : null, prefix: prefix || null };
    listeners.add(entry);
    return () => listeners.delete(entry);
  }

  function get(id) {
    const v = values.get(id);
    return v ? { ...v } : undefined;
  }

  // Текущие значения: все или по фильтру, в порядке модели
  function snapshot({ ids, prefix } = {}) {
    const list = ids ? [...ids].filter((id) => values.has(id)) : [...values.keys()];
    return list
      .filter((id) => !prefix || id.startsWith(prefix))
      .map((id) => ({ id, ...values.get(id) }));
  }

  return {
    update,
    setQuality,
    subscribe,
    get,
    snapshot,
    has: (id) => tags.has(id),
    tag: (id) => tags.get(id),
    size: () => tags.size,
  };
}

module.exports = { createTagStore, fitsType };
