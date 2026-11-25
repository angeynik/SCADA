// drivers/bacnetIp/device.js
// Обслуживание одного устройства BACnet (N30): одна очередь запросов, подписки COV,
// резервный опрос, запись с приоритетом.
//
// Цикл (раз в pollMs от начала предыдущего):
//   1. Адрес. Если адрес не задан в конфигурации, его находит драйвер по I-Am (Who-Is).
//      Пока адреса нет — ждём; после failLimit циклов без адреса теги — bad / COMM_ERROR.
//   2. Опознание. Чтение объекта device (maxApduLengthAccepted, segmentationSupported):
//      проверяет, что по адресу то самое устройство, и даёт предельный размер ответа.
//   3. Опрос объектов в режиме poll (presentValue + statusFlags) запросами
//      ReadPropertyMultiple (planner.js). Если все объекты на COV — один короткий запрос
//      к объекту device (heartbeat), чтобы потеря связи обнаруживалась так же быстро.
//   4. COV. Объект, прочитанный опросом, подписывается (SubscribeCOV, неподтверждаемые
//      уведомления, lifetime covLifetimeS) и уходит из опроса. Подписка продлевается на
//      половине lifetime: устройство в ответ присылает текущее значение. Если устройство
//      отвергло подписку — объект остаётся в опросе (лог один раз на устройство).
//
// Ошибки:
//   - нет ответа (таймаут) — неудача; после failLimit неудач подряд все теги устройства —
//     bad / COMM_ERROR (последнее значение сохраняется), подписки считаются потерянными;
//     повтор опознания с паузой от reconnectMinMs, удваивается до reconnectMaxMs;
//   - ошибка BACnet на запрос из нескольких объектов — запрос делится пополам, пока
//     неверный объект не останется один; ошибка по одному объекту (unknownObject и т. п.)
//     — его теги bad / CONFIG_ERROR (лог один раз), объект опрашивается отдельно и
//     заработает сам, если программу N30 исправили;
//   - abort «ответ не помещается» — запрос делится, предел объектов в запросе уменьшается.
// Связь считается восстановленной после первого ответа устройства. Потеря и
// восстановление пишутся в лог по разу.
//
// Запись presentValue — только с приоритетом 8–16 (точка или writePriority); после записи
// значение читается заново. release — снятие команды: NULL в тот же приоритет.
'use strict';

const bacnet = require('@bacnet-js/client');
const codec = require('./codec');
const { buildRequests, splitRequest } = require('./planner');

const { PropertyIdentifier: PROP, ObjectType: OT, ErrorCode: EC, AbortReason: AR } = bacnet;
const PRIORITY_MIN = 8;
const MAX_APDU_LIMIT = 1476;
// Причины abort, означающие «ответ слишком велик»
const SIZE_ABORTS = new Set([AR.BUFFER_OVERFLOW, AR.SEGMENTATION_NOT_SUPPORTED, AR.APDU_TOO_LONG]);

function createBacnetDevice({
  deviceId,
  address: configuredAddress = null,
  entries,
  transport,
  tagStore,
  logger,
  options = {},
  limit = (fn) => fn(),
  timers = { setTimeout, clearTimeout },
  now = Date.now,
}) {
  const {
    pollMs = 2000,
    failLimit = 3,
    reconnectMinMs = 1000,
    reconnectMaxMs = 30000,
    cov = true,
    covLifetimeS = 300,
    covProcessId = 1,
    writePriority = 8,
    maxObjects = 20,
    defaultMaxApdu = 480,
    cancelTimeoutMs = 1000,
  } = options;

  if (writePriority < PRIORITY_MIN || writePriority > 16) {
    throw new Error(`[BACnet] приоритет записи ${writePriority}: допустимо 8–16 (1–7 сервер не использует)`);
  }
  for (const e of entries) {
    if (e.point.priority !== undefined && (e.point.priority < PRIORITY_MIN || e.point.priority > 16)) {
      throw new Error(`[BACnet] ${e.tagId}: приоритет ${e.point.priority}, допустимо 8–16`);
    }
  }

  const name = `device ${deviceId}`;
  const log = (fn, msg, ...rest) => logger[fn](`[BACnet] - ${name} - ${msg}`, ...rest);
  const deviceObject = { type: OT.DEVICE, instance: deviceId };

  // ── Объекты: несколько тегов могут читать один объект ──
  const objects = new Map();
  const byTag = new Map();
  for (const e of entries) {
    const objectId = codec.objectIdOf(e.point);
    const key = codec.objectKey(objectId);
    if (!objects.has(key)) {
      objects.set(key, {
        key,
        objectId,
        label: codec.objectLabel(objectId),
        point: e.point,
        entries: [],
        mode: 'poll', // poll | cov
        covRejected: false,
        renewAt: 0,
        configError: null,
      });
    }
    const obj = objects.get(key);
    obj.entries.push(e);
    byTag.set(e.tagId, { entry: e, obj });
  }

  let address = configuredAddress;
  let stopped = true;
  let identified = false;
  let online = false;
  let everOnline = false;
  let downLogged = false;
  let downEpoch = 0;
  let failCount = 0;
  let unresolvedCycles = 0;
  let backoffMs = reconnectMinMs;
  let timer = null;
  let lastError = null;
  let lastCycleMs = null;
  let maxApdu = defaultMaxApdu;
  let learnedMaxObjects = maxObjects;
  let plan = null;
  let covRejectLogged = false;
  const badValueLogged = new Set();
  const stats = { reads: 0, readErrors: 0, writes: 0, writeErrors: 0, covNotifications: 0, subscribes: 0 };

  // ── Очередь: запись (high) раньше чтения (low), запросы строго по одному ──
  const queue = { high: [], low: [] };
  let busy = false;

  function enqueue(fn, high = false) {
    return new Promise((resolve, reject) => {
      (high ? queue.high : queue.low).push({ fn, resolve, reject });
      pump();
    });
  }

  async function pump() {
    if (busy) return;
    busy = true;
    for (let task = queue.high.shift() || queue.low.shift(); task; task = queue.high.shift() || queue.low.shift()) {
      try {
        task.resolve(await task.fn());
      } catch (err) {
        task.reject(err);
      }
    }
    busy = false;
  }

  function drainQueue(reason) {
    for (const task of [...queue.high.splice(0), ...queue.low.splice(0)]) task.reject(new Error(reason));
  }

  // Запрос к устройству: через общий ограничитель драйвера (invokeId BACnet — 0–255)
  const request = (fn) => limit(fn);

  // ── Состояние связи ──
  function setAll(quality, code) {
    for (const e of entries) tagStore.setQuality(e.tagId, quality, code);
  }

  function resetSubscriptions() {
    for (const o of objects.values()) {
      o.mode = 'poll';
      o.renewAt = 0;
      o.covRejected = false;
    }
    covRejectLogged = false;
    plan = null;
  }

  function markDown(reason, code = 'COMM_ERROR') {
    lastError = reason;
    if (!downLogged) {
      log('logErrorMessage', everOnline ? `нет связи: ${reason}` : `нет данных от устройства: ${reason}`);
      downLogged = true;
    }
    online = false;
    identified = false;
    failCount = 0;
    downEpoch += 1;
    resetSubscriptions();
    setAll('bad', code);
  }

  function onTimeout(err) {
    if (stopped) return;
    lastError = err.message;
    failCount += 1;
    if (failCount >= failLimit) markDown(`${err.message} (${failCount} раза подряд)`);
  }

  function markOnline() {
    failCount = 0;
    if (online) return;
    online = true;
    backoffMs = reconnectMinMs;
    if (everOnline) log('logInfoMessage', 'связь восстановлена');
    else log('logDevMessage', `на связи (${address})`);
    everOnline = true;
    downLogged = false;
  }

  function nextBackoff() {
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, reconnectMaxMs);
    return wait;
  }

  const isTimeout = (err) => err.kind === 'timeout' || err.kind === 'transport';

  // ── Публикация значений ──
  function setConfigError(o, message) {
    if (!o.configError) {
      log('logErrorMessage', `${o.label} (${o.entries.map((e) => e.tagId).join(', ')}): ${message}`);
      plan = null;
    }
    o.configError = message;
    o.mode = 'poll';
    for (const e of o.entries) tagStore.setQuality(e.tagId, 'bad', 'CONFIG_ERROR');
  }

  // props — { [propId]: { value } | { error } }
  function publishObject(o, props, ts) {
    const pv = props[codec.PV];
    if (!pv) return;
    if (pv.error) {
      setConfigError(o, pv.error.message);
      return;
    }
    if (o.configError) {
      log('logInfoMessage', `${o.label}: объект снова читается`);
      o.configError = null;
      plan = null;
    }
    const flags = props[codec.STATUS_FLAGS];
    const { quality, code } = codec.statusQuality(flags && flags.value);
    for (const e of o.entries) {
      let value;
      try {
        value = codec.decode(e.point, e.dataType, pv.value);
      } catch (err) {
        if (!badValueLogged.has(e.tagId)) {
          badValueLogged.add(e.tagId);
          log('logErrorMessage', `${e.tagId}: ${o.label} — ${err.message}`);
        }
        tagStore.setQuality(e.tagId, 'bad', 'BAD_VALUE');
        continue;
      }
      badValueLogged.delete(e.tagId);
      tagStore.update(e.tagId, value, { quality, code, sourceTs: ts });
    }
  }

  // ── Опознание ──
  async function identify() {
    try {
      const [res] = await request(() => transport.readMultiple(address, [{
        objectId: deviceObject,
        properties: [PROP.MAX_APDU_LENGTH_ACCEPTED, PROP.SEGMENTATION_SUPPORTED],
      }]));
      stats.reads += 1;
      const apdu = res && res.props[PROP.MAX_APDU_LENGTH_ACCEPTED];
      const n = apdu && apdu.value && apdu.value[0] && apdu.value[0].value;
      maxApdu = Number.isInteger(n) && n >= 50 ? Math.min(n, MAX_APDU_LIMIT) : defaultMaxApdu;
      identified = true;
      plan = null;
      markOnline();
      log('logDevMessage', `опознано: maxApdu ${maxApdu}`);
      return true;
    } catch (err) {
      stats.readErrors += 1;
      if (isTimeout(err)) {
        onTimeout(err);
        return false;
      }
      if (err.kind === 'error' && err.errorCode === EC.UNKNOWN_OBJECT) {
        markDown(`по адресу ${address} нет устройства ${deviceId} (проверьте device и address)`, 'CONFIG_ERROR');
        return false;
      }
      // Устройство ответило, но свойства не отдало — работаем с maxApdu по умолчанию
      identified = true;
      maxApdu = defaultMaxApdu;
      plan = null;
      markOnline();
      log('logDevMessage', `опознано без maxApdu (${err.message}), maxApdu ${maxApdu}`);
      return true;
    }
  }

  // ── Опрос ──
  function currentPlan() {
    if (plan) return plan;
    const poll = [...objects.values()].filter((o) => o.mode === 'poll');
    const good = poll.filter((o) => !o.configError);
    const bad = poll.filter((o) => o.configError);
    plan = [...buildRequests(good, { maxApdu, maxObjects: learnedMaxObjects }), ...bad.map((o) => [o])];
    return plan;
  }

  async function readRequest(req) {
    stats.reads += 1;
    const epoch = downEpoch;
    let results;
    try {
      results = await request(() => transport.readMultiple(address, req.map((o) => ({
        objectId: o.objectId,
        properties: [codec.PV, codec.STATUS_FLAGS],
      }))));
    } catch (err) {
      stats.readErrors += 1;
      if (isTimeout(err)) {
        onTimeout(err);
        return;
      }
      // Устройство ответило — связь есть
      markOnline();
      if (req.length > 1) {
        if (err.kind === 'abort' && SIZE_ABORTS.has(err.reason)) {
          const next = Math.max(1, Math.ceil(req.length / 2));
          if (next < learnedMaxObjects) {
            learnedMaxObjects = next;
            log('logInfoMessage', `запрос из ${req.length} объектов отвергнут (${err.message}), не больше ${next} объектов в запросе`);
          }
        }
        plan = null;
        for (const part of splitRequest(req)) {
          if (stopped || downEpoch !== epoch) return;
          await readRequest(part);
        }
        return;
      }
      setConfigError(req[0], err.message);
      return;
    }
    if (stopped || downEpoch !== epoch) return;
    markOnline();
    const ts = now();
    const byKey = new Map(req.map((o) => [o.key, o]));
    for (const r of results) {
      const o = byKey.get(codec.objectKey(r.objectId));
      if (o) publishObject(o, r.props, ts);
    }
  }

  async function heartbeat() {
    stats.reads += 1;
    try {
      await request(() => transport.readMultiple(address, [{ objectId: deviceObject, properties: [PROP.SYSTEM_STATUS] }]));
      markOnline();
    } catch (err) {
      stats.readErrors += 1;
      if (isTimeout(err)) onTimeout(err);
      else markOnline();
    }
  }

  // ── COV ──
  async function subscribe(o) {
    stats.subscribes += 1;
    const renewing = o.mode === 'cov';
    try {
      await request(() => transport.subscribeCov(address, o.objectId, covProcessId, covLifetimeS));
    } catch (err) {
      if (isTimeout(err)) {
        onTimeout(err);
        return false;
      }
      o.covRejected = true;
      o.mode = 'poll';
      plan = null;
      if (!covRejectLogged) {
        covRejectLogged = true;
        log('logInfoMessage', `подписка COV ${renewing ? 'не продлена' : 'не принята'} (${o.label}: ${err.message}), такие объекты опрашиваются`);
      }
      return true;
    }
    markOnline();
    if (!renewing) plan = null;
    o.mode = 'cov';
    o.renewAt = now() + (covLifetimeS * 1000) / 2;
    return true;
  }

  async function maintainCov() {
    const t = now();
    for (const o of objects.values()) {
      if (stopped || !online) return;
      if (o.configError || o.covRejected) continue;
      if (o.mode === 'cov' && o.renewAt > t) continue;
      const epoch = downEpoch;
      if (!(await enqueue(() => subscribe(o)))) return;
      if (downEpoch !== epoch) return;
    }
  }

  // Уведомление COV от драйвера (маршрутизация по номеру устройства)
  function onCov(note) {
    if (stopped) return;
    const o = objects.get(codec.objectKey(note.objectId));
    if (!o) return;
    stats.covNotifications += 1;
    const props = {};
    if (note.values[codec.PV]) props[codec.PV] = { value: note.values[codec.PV] };
    if (note.values[codec.STATUS_FLAGS]) props[codec.STATUS_FLAGS] = { value: note.values[codec.STATUS_FLAGS] };
    if (!props[codec.PV]) return;
    if (!online) return; // после потери связи значения придут опросом
    publishObject(o, props, now());
  }

  // ── Цикл ──
  function schedule(ms) {
    if (stopped) return;
    timer = timers.setTimeout(cycle, Math.max(0, ms));
  }

  async function cycle() {
    timer = null;
    if (stopped) return;
    if (!address) {
      unresolvedCycles += 1;
      if (unresolvedCycles >= failLimit && !downLogged) markDown('устройство не найдено: нет ответа I-Am на Who-Is');
      schedule(pollMs);
      return;
    }
    if (!identified) {
      let ok = false;
      try {
        ok = await enqueue(() => identify());
      } catch {
        return; // остановлено
      }
      if (!ok) {
        schedule(online ? pollMs : nextBackoff());
        return;
      }
    }
    const t0 = now();
    const epoch = downEpoch;
    try {
      const requests = currentPlan();
      if (requests.length === 0) await enqueue(() => heartbeat());
      for (const req of requests) {
        if (stopped || downEpoch !== epoch) break;
        await enqueue(() => readRequest(req));
      }
      if (cov && !stopped && downEpoch === epoch && online) await maintainCov();
    } catch {
      return; // очередь очищена при остановке
    }
    lastCycleMs = now() - t0;
    schedule(downEpoch === epoch && identified ? pollMs - lastCycleMs : nextBackoff());
  }

  // ── Запись ──
  async function writeAndConfirm(tagId, entry, obj, appValue, priority) {
    await request(() => transport.writeProperty(address, obj.objectId, codec.PV, appValue, priority));
    // Подтверждение — повторное чтение: в tagStore попадает то, что реально в устройстве
    const [res] = await request(() => transport.readMultiple(address, [{ objectId: obj.objectId, properties: [codec.PV, codec.STATUS_FLAGS] }]));
    if (!res || !res.props[codec.PV] || res.props[codec.PV].error) {
      throw Object.assign(new Error('запись выполнена, но значение не прочитано'), { kind: 'error' });
    }
    publishObject(obj, res.props, now());
    return codec.decode(entry.point, entry.dataType, res.props[codec.PV].value);
  }

  async function command(tagId, value, release) {
    const found = byTag.get(tagId);
    if (!found) return { ok: false, code: 'NOT_FOUND', message: `тег ${tagId} не обслуживается ${name}` };
    if (!online || !identified) return { ok: false, code: 'NOT_CONNECTED', message: `нет связи с ${name}` };
    const { entry, obj } = found;
    let appValue = codec.nullValue();
    if (!release) {
      try {
        appValue = codec.encode(entry.point, value);
      } catch (err) {
        return { ok: false, code: 'OUT_OF_RANGE', message: err.message };
      }
    }
    const priority = entry.point.priority || writePriority;
    const what = release ? `снятие команды ${tagId} (приоритет ${priority})` : `запись ${tagId} = ${value} (приоритет ${priority})`;
    stats.writes += 1;
    try {
      const actual = await enqueue(() => writeAndConfirm(tagId, entry, obj, appValue, priority), true);
      markOnline();
      return { ok: true, value: actual };
    } catch (err) {
      stats.writeErrors += 1;
      if (err.kind && isTimeout(err)) onTimeout(err);
      log('logErrorMessage', `${what}: ${err.message}`);
      return { ok: false, code: 'WRITE_FAILED', message: err.message };
    }
  }

  // Снятие подписок при остановке, не дольше cancelTimeoutMs
  async function cancelSubscriptions() {
    const subscribed = [...objects.values()].filter((o) => o.mode === 'cov');
    if (!subscribed.length || !address || !transport.isOpen()) return;
    let t = null;
    const all = (async () => {
      for (const o of subscribed) {
        try {
          await request(() => transport.subscribeCov(address, o.objectId, covProcessId, 0, true));
        } catch {
          return; // устройство не отвечает — подписка истечёт сама через lifetime
        }
      }
    })();
    await Promise.race([all, new Promise((r) => { t = timers.setTimeout(r, cancelTimeoutMs); })]);
    timers.clearTimeout(t);
  }

  return {
    deviceId,
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      drainQueue('драйвер остановлен');
      if (online) await cancelSubscriptions();
      online = false;
      identified = false;
      resetSubscriptions();
      setAll('bad', 'NOT_CONNECTED');
    },
    write: (tagId, value) => command(tagId, value, false),
    release: (tagId) => command(tagId, null, true),
    onCov,
    // Адрес найден по I-Am (только для устройств без адреса в конфигурации)
    setAddress(next) {
      if (configuredAddress || !next || next === address) return;
      if (address) log('logInfoMessage', `адрес изменился: ${address} → ${next}`);
      else log('logDevMessage', `найдено по I-Am: ${next}`);
      address = next;
      identified = false;
      unresolvedCycles = 0;
    },
    // Нужен ли поиск по Who-Is: адрес не задан и устройства нет на связи
    needsDiscovery: () => !configuredAddress && !online,
    address: () => address,
    status: () => {
      const all = [...objects.values()];
      return {
        deviceId,
        address,
        online,
        identified,
        maxApdu,
        objects: all.length,
        covObjects: all.filter((o) => o.mode === 'cov').length,
        configErrors: all.filter((o) => o.configError).length,
        requests: currentPlan().length,
        maxObjectsPerRequest: learnedMaxObjects,
        failCount,
        lastError,
        lastCycleMs,
        tags: entries.length,
        ...stats,
      };
    },
  };
}

module.exports = { createBacnetDevice, PRIORITY_MIN };
