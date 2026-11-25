// tools/lib/bacnetDevice.js
// Эмулятор устройства BACnet/IP (похожего на N30) для тестов и стенда без оборудования.
// Слушает свой UDP-порт (по умолчанию 127.0.0.1, свободный порт), отвечает на:
//   Who-Is (I-Am отправителю), ReadProperty, ReadPropertyMultiple, WriteProperty
//   (presentValue, массив приоритетов 1–16 у коммандируемых объектов, NULL — снятие),
//   SubscribeCOV (неподтверждаемые уведомления при изменении значения или флагов).
// Управление из теста: setValue, setFlags, setSilent, removeObject, addObject; журналы
// writes (записи) и requests (число запросов по службам), subscriptions().
// Ограничения устройства для проверки драйвера: maxApdu, maxObjectsPerRpm (больше —
// Abort segmentation-not-supported), cov (false — подписка отвергается), covLimit.
// Сервер этот модуль не загружает.
'use strict';

const dgram = require('dgram');
const bacnet = require('@bacnet-js/client');
const baApdu = require('@bacnet-js/client/dist/lib/apdu');
const baNpdu = require('@bacnet-js/client/dist/lib/npdu');
const { OBJECT_TYPES, OBJECT_TYPE_NAMES, kind } = require('../../drivers/bacnetIp/codec');
const { UdpTransport } = require('../../drivers/bacnetIp/transport');

const BacnetClient = bacnet.default;
const {
  ApplicationTag: TAG, PropertyIdentifier: P, ObjectType: OT, ErrorClass: ECL, ErrorCode: EC,
  AbortReason: AR, PduType, NpduControlPriority, Segmentation, EngineeringUnits,
} = bacnet;

const key = (type, instance) => `${type}:${instance}`;
const isCommandable = (objectType) => /Output$|Value$/.test(objectType) && objectType !== 'characterstringValue';
const isInput = (objectType) => objectType.endsWith('Input');

// Свободный UDP-порт (для клиента в тестах, которому порт нужен заранее)
function freeUdpPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(0, host, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function appValue(objectType, v) {
  if (v === null || v === undefined) return { type: TAG.NULL, value: null };
  const k = kind(objectType);
  if (k === 'binary') return { type: TAG.ENUMERATED, value: v ? 1 : 0 };
  if (k === 'multiState') return { type: TAG.UNSIGNED_INTEGER, value: v };
  if (k === 'string') return { type: TAG.CHARACTER_STRING, value: v };
  return { type: TAG.REAL, value: v };
}

// objects: [{ objectType, instance, name?, value, units?, states? }]
function createBacnetDeviceEmulator({
  deviceId,
  host = '127.0.0.1',
  port = 0,
  objects = [],
  name = `EMU-${deviceId}`,
  maxApdu = 480,
  maxObjectsPerRpm = null,
  cov = true,
  covLimit = Infinity,
  covIncrement = 0, // для analog: уведомление, только если значение изменилось не меньше чем на столько
  vendorId = 5, // Johnson Controls
} = {}) {
  let client = null;
  let actualPort = port;
  let silent = false;
  const store = new Map();
  const subs = new Map();
  const writes = [];
  const requests = { whoIs: 0, readProperty: 0, readPropertyMultiple: 0, writeProperty: 0, subscribeCov: 0 };

  function addObject(o) {
    const type = OBJECT_TYPES[o.objectType];
    if (type === undefined) throw new Error(`неизвестный тип объекта ${o.objectType}`);
    store.set(key(type, o.instance), {
      objectType: o.objectType,
      objectId: { type, instance: o.instance },
      name: o.name || `${o.objectType}-${o.instance}`,
      local: o.value === undefined ? (kind(o.objectType) === 'binary' ? false : kind(o.objectType) === 'multiState' ? 1 : 0) : o.value,
      priority: new Array(16).fill(null),
      units: o.units,
      states: o.states || 4,
      fault: false,
      outOfService: false,
    });
  }
  objects.forEach(addObject);

  const deviceObj = { objectId: { type: OT.DEVICE, instance: deviceId } };

  function presentValue(o) {
    const p = o.priority.find((v) => v !== null);
    return p === undefined ? o.local : p;
  }

  function flags(o) {
    const bits = [];
    if (o.fault) bits.push(bacnet.StatusFlags.FAULT);
    if (o.outOfService) bits.push(bacnet.StatusFlags.OUT_OF_SERVICE);
    return { type: TAG.BIT_STRING, value: new bacnet.StatusFlagsBitString(...bits) };
  }

  const error = (errorClass, errorCode) => ({ error: { errorClass, errorCode } });

  // Значение свойства: { values: [appData] } | { error }
  function readProp(objectId, propId, index) {
    if (objectId.type === OT.DEVICE) {
      if (objectId.instance !== deviceId && objectId.instance !== 4194303) return error(ECL.OBJECT, EC.UNKNOWN_OBJECT);
      switch (propId) {
        case P.OBJECT_NAME: return { values: [{ type: TAG.CHARACTER_STRING, value: name }] };
        case P.VENDOR_NAME: return { values: [{ type: TAG.CHARACTER_STRING, value: 'Emulator' }] };
        case P.MODEL_NAME: return { values: [{ type: TAG.CHARACTER_STRING, value: 'N30 emulator' }] };
        case P.MAX_APDU_LENGTH_ACCEPTED: return { values: [{ type: TAG.UNSIGNED_INTEGER, value: maxApdu }] };
        case P.SEGMENTATION_SUPPORTED: return { values: [{ type: TAG.ENUMERATED, value: Segmentation.NO_SEGMENTATION }] };
        case P.SYSTEM_STATUS: return { values: [{ type: TAG.ENUMERATED, value: 0 }] };
        case P.OBJECT_LIST: {
          const list = [{ type: TAG.OBJECTIDENTIFIER, value: { type: OT.DEVICE, instance: deviceId } },
            ...[...store.values()].map((o) => ({ type: TAG.OBJECTIDENTIFIER, value: o.objectId }))];
          if (index === undefined || index === bacnet.ASN1_ARRAY_ALL) return { values: list };
          if (index === 0) return { values: [{ type: TAG.UNSIGNED_INTEGER, value: list.length }] };
          if (index > list.length) return error(ECL.PROPERTY, EC.INVALID_ARRAY_INDEX);
          return { values: [list[index - 1]] };
        }
        default: return error(ECL.PROPERTY, EC.UNKNOWN_PROPERTY);
      }
    }
    const o = store.get(key(objectId.type, objectId.instance));
    if (!o) return error(ECL.OBJECT, EC.UNKNOWN_OBJECT);
    switch (propId) {
      case P.PRESENT_VALUE: return { values: [appValue(o.objectType, presentValue(o))] };
      case P.STATUS_FLAGS: return { values: [flags(o)] };
      case P.OBJECT_NAME: return { values: [{ type: TAG.CHARACTER_STRING, value: o.name }] };
      case P.OUT_OF_SERVICE: return { values: [{ type: TAG.BOOLEAN, value: o.outOfService }] };
      case P.UNITS:
        if (kind(o.objectType) !== 'analog') return error(ECL.PROPERTY, EC.UNKNOWN_PROPERTY);
        return { values: [{ type: TAG.ENUMERATED, value: o.units === undefined ? EngineeringUnits.NO_UNITS : o.units }] };
      case P.NUMBER_OF_STATES:
        if (kind(o.objectType) !== 'multiState') return error(ECL.PROPERTY, EC.UNKNOWN_PROPERTY);
        return { values: [{ type: TAG.UNSIGNED_INTEGER, value: o.states }] };
      default: return error(ECL.PROPERTY, EC.UNKNOWN_PROPERTY);
    }
  }

  function sendAbort(receiver, invokeId, reason) {
    const buffer = client._getApduBuffer(receiver);
    baNpdu.encode(buffer, NpduControlPriority.NORMAL_MESSAGE, receiver);
    baApdu.encodeAbort(buffer, PduType.ABORT | 1, invokeId, reason);
    client.sendBvlc(receiver, buffer);
  }

  // ── COV ──
  const subKey = (address, processId, k) => `${address}|${processId}|${k}`;

  function notify(o, force = true) {
    if (!force && kind(o.objectType) === 'analog' && covIncrement > 0 && o.lastNotified !== undefined
      && Math.abs(presentValue(o) - o.lastNotified) < covIncrement) return;
    const t = Date.now();
    for (const [sk, s] of subs) {
      if (s.key !== key(o.objectId.type, o.objectId.instance)) continue;
      if (s.expiresAt <= t) {
        subs.delete(sk);
        continue;
      }
      sendNotification(s, o);
    }
  }

  function sendNotification(s, o) {
    if (!client) return;
    o.lastNotified = presentValue(o);
    client.unconfirmedCOVNotification(
      { address: s.address },
      s.processId,
      deviceId,
      o.objectId,
      Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000)),
      [
        { property: { id: P.PRESENT_VALUE, index: bacnet.ASN1_ARRAY_ALL }, value: [appValue(o.objectType, presentValue(o))] },
        { property: { id: P.STATUS_FLAGS, index: bacnet.ASN1_ARRAY_ALL }, value: [flags(o)] },
      ],
    );
  }

  // ── Обработчики служб ──
  function onWhoIs(c) {
    requests.whoIs += 1;
    if (silent) return;
    const { lowLimit, highLimit } = c.payload || {};
    if (lowLimit !== undefined && (deviceId < lowLimit || deviceId > highLimit)) return;
    client.iAmResponse(c.header.sender, deviceId, Segmentation.NO_SEGMENTATION, vendorId);
  }

  function onReadProperty(c) {
    requests.readProperty += 1;
    if (silent) return;
    const { objectId, property } = c.payload;
    const r = readProp(objectId, property.id, property.index);
    if (r.error) {
      client.errorResponse(c.header.sender, c.service, c.invokeId, r.error.errorClass, r.error.errorCode);
      return;
    }
    client.readPropertyResponse(c.header.sender, c.invokeId, objectId, property, r.values);
  }

  function onReadPropertyMultiple(c) {
    requests.readPropertyMultiple += 1;
    if (silent) return;
    const specs = c.payload.properties;
    if (maxObjectsPerRpm && specs.length > maxObjectsPerRpm) {
      sendAbort(c.header.sender, c.invokeId, AR.SEGMENTATION_NOT_SUPPORTED);
      return;
    }
    const values = specs.map((spec) => ({
      objectId: spec.objectId,
      values: spec.properties.map((pr) => {
        const r = readProp(spec.objectId, pr.id, pr.index);
        return {
          property: { id: pr.id, index: pr.index },
          value: r.error ? [{ value: { type: 'BacnetError', ...r.error } }] : r.values,
        };
      }),
    }));
    client.readPropertyMultipleResponse(c.header.sender, c.invokeId, values);
  }

  function validWrite(o, v) {
    if (v === null) return true;
    const k = kind(o.objectType);
    if (k === 'binary') return v.type === TAG.ENUMERATED && (v.value === 0 || v.value === 1);
    if (k === 'multiState') return v.type === TAG.UNSIGNED_INTEGER && v.value >= 1 && v.value <= o.states;
    if (k === 'string') return v.type === TAG.CHARACTER_STRING;
    return v.type === TAG.REAL && Number.isFinite(v.value);
  }

  function onWriteProperty(c) {
    requests.writeProperty += 1;
    if (silent) return;
    const { objectId, value: w } = c.payload;
    const reply = (cls, code) => client.errorResponse(c.header.sender, c.service, c.invokeId, cls, code);
    const o = store.get(key(objectId.type, objectId.instance));
    if (!o) return reply(ECL.OBJECT, EC.UNKNOWN_OBJECT);
    if (w.property.id !== P.PRESENT_VALUE || isInput(o.objectType)) return reply(ECL.PROPERTY, EC.WRITE_ACCESS_DENIED);
    const item = w.value && w.value[0];
    const isNull = !item || item.type === TAG.NULL;
    if (!isNull && !validWrite(o, item)) return reply(ECL.PROPERTY, EC.VALUE_OUT_OF_RANGE);
    const priority = w.priority || 16;
    if (priority < 1 || priority > 16) return reply(ECL.PROPERTY, EC.VALUE_OUT_OF_RANGE);
    const before = JSON.stringify([presentValue(o), o.fault, o.outOfService]);
    const v = isNull ? null : kind(o.objectType) === 'binary' ? item.value === 1 : item.value;
    if (isCommandable(o.objectType)) o.priority[priority - 1] = v;
    else if (!isNull) o.local = v;
    writes.push({ object: `${o.objectType}:${o.objectId.instance}`, value: v, priority });
    client.simpleAckResponse(c.header.sender, c.service, c.invokeId);
    if (JSON.stringify([presentValue(o), o.fault, o.outOfService]) !== before) notify(o);
  }

  function onSubscribeCov(c) {
    requests.subscribeCov += 1;
    if (silent) return;
    const p = c.payload;
    const reply = (cls, code) => client.errorResponse(c.header.sender, c.service, c.invokeId, cls, code);
    const k = key(p.monitoredObjectId.type, p.monitoredObjectId.instance);
    const o = store.get(k);
    if (!o) return reply(ECL.OBJECT, EC.UNKNOWN_OBJECT);
    if (!cov) return reply(ECL.SERVICES, EC.SERVICE_REQUEST_DENIED);
    const address = c.header.sender.address;
    const sk = subKey(address, p.subscriberProcessId, k);
    if (p.cancellationRequest) {
      subs.delete(sk);
      client.simpleAckResponse(c.header.sender, c.service, c.invokeId);
      return;
    }
    if (!subs.has(sk) && subs.size >= covLimit) return reply(ECL.RESOURCES, EC.NO_SPACE_TO_ADD_LIST_ELEMENT);
    const lifetime = p.lifetime || 0;
    const s = { address, processId: p.subscriberProcessId, key: k, expiresAt: lifetime ? Date.now() + lifetime * 1000 : Infinity };
    subs.set(sk, s);
    client.simpleAckResponse(c.header.sender, c.service, c.invokeId);
    // По стандарту после подписки устройство сразу присылает текущее значение
    setImmediate(() => sendNotification(s, o));
  }

  function get(objectType, instance) {
    const o = store.get(key(OBJECT_TYPES[objectType], instance));
    if (!o) throw new Error(`нет объекта ${objectType}:${instance}`);
    return o;
  }

  return {
    deviceId,
    async start() {
      await new Promise((resolve, reject) => {
        const transport = new UdpTransport({ port: actualPort, iface: host, broadcastAddress: host });
        const c = new BacnetClient({ transport });
        c.once('error', reject);
        c.once('listening', () => {
          c.removeListener('error', reject);
          c.on('error', () => {});
          actualPort = transport.ownAddress.port;
          client = c;
          resolve();
        });
        c.on('whoIs', onWhoIs);
        c.on('readProperty', onReadProperty);
        c.on('readPropertyMultiple', onReadPropertyMultiple);
        c.on('writeProperty', onWriteProperty);
        c.on('subscribeCov', onSubscribeCov);
      });
      return actualPort;
    },
    async stop() {
      if (client) client.close();
      client = null;
    },
    port: () => actualPort,
    address: () => `${host}:${actualPort}`,
    // Значение, которое задаёт «программа контроллера» (без приоритета)
    setValue(objectType, instance, value) {
      const o = get(objectType, instance);
      const before = presentValue(o);
      o.local = value;
      if (presentValue(o) !== before) notify(o, false);
    },
    setFlags(objectType, instance, { fault, outOfService }) {
      const o = get(objectType, instance);
      if (fault !== undefined) o.fault = fault;
      if (outOfService !== undefined) o.outOfService = outOfService;
      notify(o);
    },
    value: (objectType, instance) => presentValue(get(objectType, instance)),
    priorityArray: (objectType, instance) => [...get(objectType, instance).priority],
    setSilent(v) { silent = Boolean(v); },
    removeObject(objectType, instance) { store.delete(key(OBJECT_TYPES[objectType], instance)); },
    addObject,
    objects: () => [...store.values()].map((o) => ({ objectType: o.objectType, instance: o.objectId.instance, name: o.name, value: presentValue(o) })),
    subscriptions: () => [...subs.values()].map((s) => ({ ...s, object: OBJECT_TYPE_NAMES[s.key.split(':')[0]] + ':' + s.key.split(':')[1] })),
    writes,
    requests,
    deviceObject: deviceObj,
  };
}

module.exports = { createBacnetDeviceEmulator, freeUdpPort };
