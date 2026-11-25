// drivers/modbusTcp/index.js
// Драйвер Modbus TCP (контроллеры ОВЕН). Теги группируются по контроллеру (host:port):
// на каждый — своё соединение и своя очередь (device.js). Несколько установок на одном
// контроллере (разные unitId или адреса) обслуживаются одним соединением.
// Контракт драйвера — rules.md, «Драйверы»; подробности — docs/modbus-tcp.md.
'use strict';

const { createModbusDevice } = require('./device');
const { createTcpTransport } = require('./transport');

// tags — теги модели с source.driver === 'modbus'.
// options: pollMs, timeoutMs, connectTimeoutMs, failLimit, maxGap, reconnectMinMs, reconnectMaxMs.
function createModbusTcpDriver({ tags, tagStore, logger, options = {}, transportFactory = createTcpTransport, timers, now }) {
  const groups = new Map();
  for (const tag of tags) {
    const { host, port, unitId } = tag.source.connection;
    const key = `${host}:${port}`;
    if (!groups.has(key)) groups.set(key, { host, port, entries: [] });
    groups.get(key).entries.push({ tagId: tag.id, unitId, byteOrder: tag.source.byteOrder, point: tag.source.point });
  }

  const devices = [];
  const byTag = new Map();
  for (const { host, port, entries } of groups.values()) {
    const transport = transportFactory({ host, port, timeoutMs: options.timeoutMs, connectTimeoutMs: options.connectTimeoutMs });
    const device = createModbusDevice({ host, port, entries, tagStore, logger, options, transport, timers, now });
    devices.push(device);
    for (const e of entries) byTag.set(e.tagId, device);
  }

  return {
    start() {
      logger.logInfoMessage(`[ModbusTCP] - start - контроллеров ${devices.length}, тегов ${byTag.size}`);
      for (const d of devices) d.start();
    },
    async stop() {
      await Promise.all(devices.map((d) => d.stop()));
    },
    write(tagId, value) {
      const device = byTag.get(tagId);
      if (!device) return Promise.resolve({ ok: false, code: 'NOT_FOUND', message: `тег ${tagId} не обслуживается Modbus TCP` });
      return device.write(tagId, value);
    },
    status: () => ({ devices: devices.map((d) => d.status()) }),
  };
}

module.exports = { createModbusTcpDriver };
