// drivers/bacnetIp/index.js
// Драйвер BACnet/IP (Metasys N30). Один UDP-сокет на процесс (transport.js), теги
// группируются по номеру устройства (source.device): на устройство — своя очередь
// и свои подписки (device.js). Несколько установок на одном N30 обслуживаются вместе.
//
// Поиск устройств: для устройств без address в конфигурации драйвер рассылает Who-Is
// (диапазонами номеров) с паузой от reconnectMinMs до reconnectMaxMs, пока все не найдены;
// I-Am передаёт адрес устройству. Уведомления COV маршрутизируются по номеру устройства.
//
// Одновременно выполняется не больше maxInFlight запросов: номер запроса BACnet (invokeId)
// — 0–255 на весь сокет, и запоздавший ответ не должен совпасть с новым запросом.
// Контракт драйвера — rules.md, «Драйверы»; подробности — docs/bacnet.md.
'use strict';

const { createBacnetDevice } = require('./device');
const { createBacnetTransport, normalizeAddress } = require('./transport');

const MAX_IN_FLIGHT = 64;

// Простой семафор: не больше n одновременных fn()
function createLimiter(n) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= n || !waiting.length) return;
    active += 1;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) => new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject });
    next();
  });
}

// Номера устройств → диапазоны Who-Is (соседние номера с разрывом до gap — один запрос)
function whoIsRanges(ids, gap = 50) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const ranges = [];
  for (const id of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && id - last.high <= gap) last.high = id;
    else ranges.push({ low: id, high: id });
  }
  return ranges;
}

// tags — теги модели с source.driver === 'bacnet'.
// options: port, iface, broadcastAddress, apduTimeoutMs, pollMs, failLimit, cov, covLifetimeS,
//          writePriority, maxObjects, reconnectMinMs, reconnectMaxMs, maxInFlight.
function createBacnetIpDriver({ tags, tagStore, logger, options = {}, transportFactory = createBacnetTransport, timers = { setTimeout, clearTimeout }, now }) {
  const { reconnectMinMs = 1000, reconnectMaxMs = 30000, maxInFlight = MAX_IN_FLIGHT } = options;
  const transport = transportFactory({
    port: options.port,
    iface: options.iface,
    broadcastAddress: options.broadcastAddress,
    apduTimeoutMs: options.apduTimeoutMs,
  });
  const limit = createLimiter(maxInFlight);

  const groups = new Map();
  for (const tag of tags) {
    const { device, address } = tag.source.connection;
    const addr = normalizeAddress(address);
    if (!groups.has(device)) groups.set(device, { address: addr, entries: [] });
    const g = groups.get(device);
    if (addr && g.address && addr !== g.address) {
      logger.logErrorMessage(`[BACnet] - create - устройство ${device}: разные адреса ${g.address} и ${addr} (${tag.instance}), используется ${g.address}`);
    }
    if (!g.address) g.address = addr;
    g.entries.push({ tagId: tag.id, dataType: tag.dataType, point: tag.source.point });
  }

  const devices = new Map();
  const byTag = new Map();
  for (const [deviceId, { address, entries }] of groups) {
    const device = createBacnetDevice({ deviceId, address, entries, transport, tagStore, logger, options, limit, timers, now });
    devices.set(deviceId, device);
    for (const e of entries) byTag.set(e.tagId, device);
  }

  let started = false;
  let discoveryTimer = null;
  let discoveryMs = reconnectMinMs;
  const unsubscribe = [];

  function discover() {
    discoveryTimer = null;
    if (!started) return;
    const ids = [...devices.values()].filter((d) => d.needsDiscovery()).map((d) => d.deviceId);
    if (ids.length) {
      for (const r of whoIsRanges(ids)) {
        try {
          transport.whoIs(r);
        } catch (err) {
          logger.logErrorMessage(`[BACnet] - discover - Who-Is ${r.low}–${r.high}: ${err.message}`);
        }
      }
      discoveryMs = Math.min(discoveryMs * 2, reconnectMaxMs);
    } else {
      discoveryMs = reconnectMinMs;
    }
    discoveryTimer = timers.setTimeout(discover, ids.length ? discoveryMs : reconnectMaxMs);
  }

  return {
    async start() {
      if (started) return;
      await transport.open();
      started = true;
      unsubscribe.push(transport.onIAm((info) => {
        const d = devices.get(info.deviceId);
        if (d) d.setAddress(info.address);
      }));
      unsubscribe.push(transport.onCov((note) => {
        const d = devices.get(note.deviceId);
        if (d) d.onCov(note);
      }));
      unsubscribe.push(transport.onError((err) => {
        logger.logErrorMessage('[BACnet] - socket - ошибка сокета:', err);
      }));
      const unresolved = [...devices.values()].filter((d) => !d.address()).length;
      logger.logInfoMessage(`[BACnet] - start - устройств ${devices.size}, тегов ${byTag.size}${unresolved ? `, поиск по Who-Is: ${unresolved}` : ''}`);
      for (const d of devices.values()) d.start();
      discover();
    },
    async stop() {
      if (!started) return;
      started = false;
      if (discoveryTimer) timers.clearTimeout(discoveryTimer);
      discoveryTimer = null;
      await Promise.all([...devices.values()].map((d) => d.stop()));
      for (const off of unsubscribe.splice(0)) off();
      transport.close();
    },
    write(tagId, value) {
      const device = byTag.get(tagId);
      if (!device) return Promise.resolve({ ok: false, code: 'NOT_FOUND', message: `тег ${tagId} не обслуживается BACnet` });
      return device.write(tagId, value);
    },
    // Снятие команды: NULL в приоритет записи точки
    release(tagId) {
      const device = byTag.get(tagId);
      if (!device) return Promise.resolve({ ok: false, code: 'NOT_FOUND', message: `тег ${tagId} не обслуживается BACnet` });
      return device.release(tagId);
    },
    status: () => ({ devices: [...devices.values()].map((d) => d.status()) }),
  };
}

module.exports = { createBacnetIpDriver, whoIsRanges, createLimiter };
