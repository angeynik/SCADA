// drivers/bacnetIp/transport.js
// Тонкая обёртка над @bacnet-js/client: один UDP-сокет BACnet/IP на процесс.
// Задачи обёртки:
//   - открыть сокет и дождаться привязки к порту (ошибка EADDRINUSE — понятным текстом);
//   - привести адреса к одному виду: «10.10.0.30» и «10.10.0.30:47808» — одно устройство;
//   - привести ошибки библиотеки к BacnetError с полем kind:
//       timeout — устройство не ответило за apduTimeoutMs;
//       error   — устройство ответило ошибкой BACnet (errorClass, errorCode);
//       abort   — устройство прервало или отвергло запрос (reason), например, ответ
//                 не помещается в APDU без сегментации;
//       transport — сокет закрыт или ответ не разобран;
//   - разобрать ответ ReadPropertyMultiple в { objectId, props: { [propId]: { value } | { error } } };
//   - передать уведомления COV (подтверждаемые и нет) одним обработчиком; на подтверждаемое
//     уведомление отвечается SimpleAck.
// Остальная логика (очереди, качество, COV-подписки) — в device.js и index.js.
'use strict';

const dgram = require('dgram');
const { EventEmitter } = require('events');
const bacnet = require('@bacnet-js/client');

const BacnetClient = bacnet.default;
const DEFAULT_PORT = bacnet.DEFAULT_BACNET_PORT; // 47808
const ARRAY_ALL = bacnet.ASN1_ARRAY_ALL;
const ERROR_TAG = bacnet.ApplicationTag.ERROR;

const ERROR_CLASS_NAMES = invert(bacnet.ErrorClass);
const ERROR_CODE_NAMES = invert(bacnet.ErrorCode);
const ABORT_NAMES = invert(bacnet.AbortReason);

function invert(en) {
  const out = {};
  for (const [k, v] of Object.entries(en)) if (typeof v === 'number') out[v] = k.toLowerCase();
  return out;
}

class BacnetError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'BacnetError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const describeError = (cls, code) => `${ERROR_CLASS_NAMES[cls] || cls}/${ERROR_CODE_NAMES[code] || code}`;

// Ошибка библиотеки → BacnetError
function normalizeError(err) {
  if (err instanceof BacnetError) return err;
  const msg = String((err && err.message) || err);
  if (msg === 'ERR_TIMEOUT') return new BacnetError('timeout', 'нет ответа (таймаут)');
  let m = /BacnetError - Class:(\d+) - Code:(\d+)/.exec(msg);
  if (m) {
    const errorClass = Number(m[1]);
    const errorCode = Number(m[2]);
    return new BacnetError('error', `ошибка BACnet ${describeError(errorClass, errorCode)}`, { errorClass, errorCode });
  }
  m = /BacnetAbort - Reason:(\d+)/.exec(msg);
  if (m) {
    const reason = Number(m[1]);
    return new BacnetError('abort', `запрос прерван устройством (${ABORT_NAMES[reason] || reason})`, { reason });
  }
  return new BacnetError('transport', msg);
}

// «host» и «host:47808» — один адрес; другой порт сохраняется
function normalizeAddress(address) {
  if (!address) return null;
  const s = String(address).trim();
  const [host, port] = s.split(':');
  return !port || Number(port) === DEFAULT_PORT ? host : `${host}:${Number(port)}`;
}

function parseReadMultiple(result) {
  return (result.values || []).map((obj) => {
    const props = {};
    for (const v of obj.values) {
      const first = v.value && v.value[0];
      if (first && first.type === ERROR_TAG) {
        const { errorClass, errorCode } = first.value;
        props[v.id] = { error: { errorClass, errorCode, message: `ошибка BACnet ${describeError(errorClass, errorCode)}` } };
      } else {
        props[v.id] = { value: v.value || [] };
      }
    }
    return { objectId: obj.objectId, props };
  });
}

// UDP-транспорт для @bacnet-js/client (опция transport). Повторяет встроенный, но таймер
// фильтра собственного широковещательного эха не удерживает процесс (unref): иначе после
// каждого Who-Is процесс (инструмент, тест) не завершался бы ещё 10 с.
class UdpTransport extends EventEmitter {
  constructor({ port, iface, broadcastAddress }) {
    super();
    this.port = port;
    this.iface = iface;
    this.broadcastAddress = broadcastAddress;
    this.ownAddress = { address: '', port: 0 };
    this.sentBroadcasts = new Map();
    this.socket = dgram.createSocket({ type: 'udp4' });
    this.socket.on('message', (msg, rinfo) => {
      // Свой широковещательный запрос, вернувшийся по сети, — не входящее сообщение
      if (rinfo.port === this.ownAddress.port) {
        for (const sent of this.sentBroadcasts.values()) if (msg.equals(sent)) return;
      }
      this.emit('message', msg, rinfo.port === DEFAULT_PORT ? rinfo.address : `${rinfo.address}:${rinfo.port}`);
    });
    this.socket.on('listening', () => {
      this.ownAddress = this.socket.address();
      this.emit('listening', this.ownAddress);
    });
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => this.emit('close'));
  }

  getBroadcastAddress() { return this.broadcastAddress; }

  getMaxPayload() { return 1482; }

  send(buffer, offset, receiver) {
    let target = receiver;
    if (!target) {
      target = this.broadcastAddress;
      const id = Symbol('broadcast');
      this.sentBroadcasts.set(id, Buffer.from(buffer.subarray(0, offset)));
      setTimeout(() => this.sentBroadcasts.delete(id), 10000).unref();
    }
    const [host, port] = String(target).split(':');
    this.socket.send(buffer, 0, offset, Number(port) || DEFAULT_PORT, host);
  }

  open() {
    this.socket.bind(this.port, this.iface, () => this.socket.setBroadcast(true));
  }

  close() {
    try { this.socket.close(); } catch { /* уже закрыт */ }
  }
}

// options: port (UDP, по умолчанию 47808), iface (адрес привязки), broadcastAddress
// (может быть host:port), apduTimeoutMs. ClientClass — для тестов.
function createBacnetTransport({ port = DEFAULT_PORT, iface, broadcastAddress = '255.255.255.255', apduTimeoutMs = 3000, ClientClass = BacnetClient } = {}) {
  let client = null;
  let closed = false;
  const iAmHandlers = new Set();
  const covHandlers = new Set();
  const errorHandlers = new Set();

  function requireClient() {
    if (!client || closed) throw new BacnetError('transport', 'сокет BACnet закрыт');
    return client;
  }

  async function call(fn) {
    const c = requireClient();
    try {
      return await fn(c);
    } catch (err) {
      throw normalizeError(err);
    }
  }

  function emitCov(content, confirmed) {
    const p = content.payload;
    const sender = content.header && content.header.sender;
    if (confirmed && sender && client) {
      try {
        client.simpleAckResponse(sender, content.service, content.invokeId);
      } catch {
        // ответ не отправлен — устройство повторит уведомление
      }
    }
    const values = {};
    for (const v of p.values || []) values[v.property.id] = v.value || [];
    const note = {
      address: normalizeAddress(sender && sender.address),
      processId: p.subscriberProcessId,
      deviceId: typeof p.initiatingDeviceId === 'object' && p.initiatingDeviceId ? p.initiatingDeviceId.instance : p.initiatingDeviceId,
      objectId: p.monitoredObjectId,
      timeRemaining: p.timeRemaining,
      values,
    };
    for (const fn of covHandlers) fn(note);
  }

  return {
    // Открывает сокет. Ошибка привязки (порт занят) — исключение
    open() {
      if (client) return Promise.resolve();
      closed = false;
      return new Promise((resolve, reject) => {
        let listening = false;
        const c = new ClientClass({
          apduTimeout: apduTimeoutMs,
          transport: new UdpTransport({ port, iface, broadcastAddress }),
        });
        client = c;
        c.on('error', (err) => {
          if (!listening) {
            client = null;
            try { c.close(); } catch { /* сокет не открыт */ }
            const text = err && err.code === 'EADDRINUSE'
              ? `порт UDP ${port} занят (на порту BACnet может слушать только один процесс)`
              : `сокет BACnet: ${err.message}`;
            reject(new BacnetError('transport', text, { code: err && err.code }));
            return;
          }
          for (const fn of errorHandlers) fn(err);
        });
        c.on('listening', () => {
          listening = true;
          resolve();
        });
        c.on('iAm', (content) => {
          const p = content.payload;
          const info = {
            address: normalizeAddress(p.address || (content.header && content.header.sender && content.header.sender.address)),
            deviceId: p.deviceId,
            maxApdu: p.maxApdu,
            segmentation: p.segmentation,
            vendorId: p.vendorId,
          };
          for (const fn of iAmHandlers) fn(info);
        });
        c.on('covNotifyUnconfirmed', (content) => emitCov(content, false));
        c.on('covNotify', (content) => emitCov(content, true));
      });
    },

    close() {
      closed = true;
      if (client) {
        try { client.close(); } catch { /* уже закрыт */ }
      }
      client = null;
    },

    isOpen: () => Boolean(client) && !closed,
    onIAm: (fn) => { iAmHandlers.add(fn); return () => iAmHandlers.delete(fn); },
    onCov: (fn) => { covHandlers.add(fn); return () => covHandlers.delete(fn); },
    onError: (fn) => { errorHandlers.add(fn); return () => errorHandlers.delete(fn); },

    // Who-Is: без address — широковещательно (broadcastAddress), с address — одному устройству
    whoIs({ low, high, address } = {}) {
      const c = requireClient();
      const range = low === undefined ? {} : { lowLimit: low, highLimit: high === undefined ? low : high };
      if (address) c.whoIs({ address }, range);
      else c.whoIs(range);
    },

    // specs: [{ objectId: {type, instance}, properties: [propId, ...] }]
    readMultiple(address, specs) {
      const req = specs.map((s) => ({ objectId: s.objectId, properties: s.properties.map((id) => ({ id, index: ARRAY_ALL })) }));
      return call(async (c) => parseReadMultiple(await c.readPropertyMultiple({ address }, req)));
    },

    // Возвращает массив значений свойства (application data)
    readProperty(address, objectId, propId, arrayIndex) {
      const opts = arrayIndex === undefined ? {} : { arrayIndex };
      return call(async (c) => (await c.readProperty({ address }, objectId, propId, opts)).values || []);
    },

    // value — { type: ApplicationTag, value }; priority 1–16 (драйвер использует только 8–16)
    writeProperty(address, objectId, propId, value, priority) {
      return call((c) => c.writeProperty({ address }, objectId, propId, [value], { priority }));
    },

    // Подписка на COV с неподтверждаемыми уведомлениями; cancel — снятие подписки
    subscribeCov(address, objectId, processId, lifetimeS, cancel = false) {
      return call((c) => c.subscribeCov({ address }, objectId, processId, cancel, false, cancel ? 0 : lifetimeS));
    },
  };
}

module.exports = {
  createBacnetTransport,
  UdpTransport,
  BacnetError,
  normalizeError,
  normalizeAddress,
  parseReadMultiple,
  describeError,
  DEFAULT_PORT,
};
