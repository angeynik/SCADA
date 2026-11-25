// tools/bacnetDiscover.js
// Поиск и диагностика устройств BACnet/IP без запуска сервера.
//
// Поиск устройств — Who-Is, затем имя, производитель и модель каждого ответившего:
//   node tools/bacnetDiscover.js [--broadcast 10.10.0.255] [--low N --high M] [--wait 3000]
//
// Объекты устройства — список объектов с именами, значениями и единицами; --csv пишет
// черновик таблицы для tools/importTags.js (колонку param заполнить именами параметров шаблона):
//   node tools/bacnetDiscover.js --device 30001 [--address 10.10.0.30] [--csv draft.csv]
//        [--id AHU-17] [--template AhuType]
//
// Проверка привязок установки — каждая точка: объект, имя на устройстве, значение, флаги:
//   node tools/bacnetDiscover.js --instance AHU-17 [--config <каталог>] [--address A]
//
// --local-port — свой порт UDP. По умолчанию для поиска 47808 (устройства отвечают I-Am
// широковещательно на этот порт), для остальных режимов — любой свободный.
// Если на машине работает сервер, порт 47808 занят: искать с другой машины или после остановки.
// --address без порта — 47808. Код выхода: 0 — без ошибок, 1 — есть ошибки, 2 — неверные аргументы.
'use strict';

const fs = require('fs');
const path = require('path');
const bacnet = require('@bacnet-js/client');
const { loadConfig } = require('../services/config');
const { loadModel } = require('../core/modelLoader');
const { createBacnetTransport, DEFAULT_PORT } = require('../drivers/bacnetIp/transport');
const codec = require('../drivers/bacnetIp/codec');
const { formatBacnetPoint } = require('./lib/pointNotation');

const { PropertyIdentifier: P, ObjectType: OT, ApplicationTag: TAG } = bacnet;
const UNIT_NAMES = Object.fromEntries(Object.entries(bacnet.EngineeringUnits).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k.toLowerCase()]));
const CHUNK = 10;

const USAGE = 'Использование:\n'
  + '  node tools/bacnetDiscover.js [--broadcast A] [--low N --high M] [--wait 3000] [--local-port P]\n'
  + '  node tools/bacnetDiscover.js --device N [--address A] [--csv файл] [--id AHU-17] [--template AhuType] [--local-port P]\n'
  + '  node tools/bacnetDiscover.js --instance <id> [--config <каталог>] [--address A] [--local-port P]\n';

function argValue(args, name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const first = (prop) => (prop && prop.value && prop.value[0] ? prop.value[0].value : undefined);

function fmtRaw(item) {
  if (!item) return '—';
  if (item.type === TAG.REAL) return String(Number(item.value.toPrecision(7)));
  if (item.type === TAG.NULL) return 'NULL';
  if (item.type === TAG.BIT_STRING) return JSON.stringify(item.value.value);
  return String(item.value);
}

function fmtFlags(prop) {
  const q = codec.statusQuality(prop && prop.value);
  return q.code ? q.code : '';
}

async function openTransport(args, defaultPort) {
  const { config } = loadConfig();
  const transport = createBacnetTransport({
    port: Number(argValue(args, '--local-port', defaultPort)),
    iface: config.bacnetInterface,
    broadcastAddress: argValue(args, '--broadcast', config.bacnetBroadcastAddress),
    apduTimeoutMs: config.bacnetApduTimeoutMs,
  });
  await transport.open();
  return transport;
}

// Адрес устройства: задан или найден по Who-Is
async function resolveAddress(transport, deviceId, address, waitMs) {
  if (address) return address;
  let found = null;
  const off = transport.onIAm((i) => { if (i.deviceId === deviceId) found = i.address; });
  transport.whoIs({ low: deviceId, high: deviceId });
  for (let t = 0; t < waitMs && !found; t += 50) await sleep(50);
  off();
  if (!found) throw new Error(`устройство ${deviceId} не ответило на Who-Is за ${waitMs} мс (задайте --address)`);
  return found;
}

// ── Поиск устройств ──
async function discover(args, write) {
  const waitMs = Number(argValue(args, '--wait', '3000'));
  const low = argValue(args, '--low');
  const high = argValue(args, '--high');
  const transport = await openTransport(args, String(DEFAULT_PORT));
  const found = new Map();
  try {
    transport.onIAm((i) => { if (!found.has(i.deviceId)) found.set(i.deviceId, i); });
    transport.whoIs(low === undefined ? {} : { low: Number(low), high: Number(high === undefined ? low : high) });
    await sleep(waitMs);
    const list = [...found.values()].sort((a, b) => a.deviceId - b.deviceId);
    write(`Ответили устройств: ${list.length}\n\n`);
    for (const d of list) {
      let info = '';
      try {
        const [r] = await transport.readMultiple(d.address, [{ objectId: { type: OT.DEVICE, instance: d.deviceId }, properties: [P.OBJECT_NAME, P.VENDOR_NAME, P.MODEL_NAME] }]);
        info = [first(r.props[P.OBJECT_NAME]), first(r.props[P.VENDOR_NAME]), first(r.props[P.MODEL_NAME])].filter(Boolean).join(' · ');
      } catch (err) {
        info = `(${err.message})`;
      }
      write(`${String(d.deviceId).padEnd(9)} ${d.address.padEnd(22)} maxApdu ${String(d.maxApdu).padEnd(5)} vendor ${String(d.vendorId).padEnd(4)} ${info}\n`);
    }
    return 0;
  } finally {
    transport.close();
  }
}

// ── Объекты устройства ──
async function readObjectList(transport, address, deviceId) {
  const dev = { type: OT.DEVICE, instance: deviceId };
  try {
    return (await transport.readProperty(address, dev, P.OBJECT_LIST)).map((v) => v.value);
  } catch {
    // Весь список не помещается без сегментации — читаем по одному элементу
    const [count] = await transport.readProperty(address, dev, P.OBJECT_LIST, 0);
    const list = [];
    for (let i = 1; i <= count.value; i += 1) list.push((await transport.readProperty(address, dev, P.OBJECT_LIST, i))[0].value);
    return list;
  }
}

function paramGuess(name, used) {
  let base = String(name || 'Point').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[^A-Za-z]+/, '').slice(0, 60) || 'Point';
  if (!/^[A-Za-z]/.test(base)) base = `P${base}`;
  let v = base;
  for (let i = 2; used.has(v); i += 1) v = `${base}_${i}`;
  used.add(v);
  return v;
}

const csvCell = (v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

async function deviceObjects(args, write) {
  const deviceId = Number(argValue(args, '--device'));
  if (!Number.isInteger(deviceId) || deviceId < 0) return 2;
  const transport = await openTransport(args, argValue(args, '--address') ? '0' : String(DEFAULT_PORT));
  try {
    const address = await resolveAddress(transport, deviceId, argValue(args, '--address'), Number(argValue(args, '--wait', '3000')));
    const objects = (await readObjectList(transport, address, deviceId)).filter((o) => codec.OBJECT_TYPE_NAMES[o.type]);
    write(`Устройство ${deviceId} (${address}): поддерживаемых объектов ${objects.length}\n\n`);
    const rows = [];
    for (let i = 0; i < objects.length; i += CHUNK) {
      const part = objects.slice(i, i + CHUNK);
      const res = await transport.readMultiple(address, part.map((objectId) => ({ objectId, properties: [P.OBJECT_NAME, P.PRESENT_VALUE, P.STATUS_FLAGS, P.UNITS] })));
      for (const r of res) {
        const point = { objectType: codec.OBJECT_TYPE_NAMES[r.objectId.type], instance: r.objectId.instance };
        const units = first(r.props[P.UNITS]);
        rows.push({
          point,
          name: first(r.props[P.OBJECT_NAME]) || '',
          value: r.props[P.PRESENT_VALUE] && r.props[P.PRESENT_VALUE].error ? r.props[P.PRESENT_VALUE].error.message : fmtRaw(r.props[P.PRESENT_VALUE] && r.props[P.PRESENT_VALUE].value[0]),
          units: units === undefined ? '' : UNIT_NAMES[units] || String(units),
          flags: fmtFlags(r.props[P.STATUS_FLAGS]),
        });
      }
    }
    for (const r of rows) {
      write(`${formatBacnetPoint(r.point).padEnd(10)} ${r.name.padEnd(32)} ${String(r.value).padEnd(12)} ${r.units.padEnd(18)} ${r.flags}\n`);
    }
    const csv = argValue(args, '--csv');
    if (csv) {
      const id = argValue(args, '--id', `DEV-${deviceId}`);
      const used = new Set();
      const lines = [
        'instance;title;template;driver;device;address;param;point',
        [id, `Устройство ${deviceId}`, argValue(args, '--template', ''), 'bacnet', deviceId, address, '', ''].map(csvCell).join(';'),
        ...rows.map((r) => [id, '', '', '', '', '', paramGuess(r.name, used), formatBacnetPoint(r.point)].map(csvCell).join(';')),
      ];
      fs.writeFileSync(csv, `${lines.join('\n')}\n`);
      write(`\nЧерновик таблицы: ${csv} — замените param на имена параметров шаблона, лишние строки удалите,\n`
        + 'затем node tools/importTags.js <файл> --out <instances/файл.json>\n');
    }
    return 0;
  } finally {
    transport.close();
  }
}

// ── Проверка установки ──
async function checkInstance(args, write) {
  const id = argValue(args, '--instance');
  const dirArg = argValue(args, '--config');
  const dir = dirArg ? path.resolve(dirArg) : loadConfig().config.configDir;
  const model = loadModel({ dir });
  const inst = model.instances.find((i) => i.id === id);
  if (!inst) {
    const off = model.disabled.find((d) => d.id === id);
    throw new Error(off ? `установка ${id} отключена: ${off.reason}` : `установка ${id} не найдена`);
  }
  const tags = inst.tagIds.map((t) => model.tags.get(t));
  if (tags[0].source.driver !== 'bacnet') throw new Error(`установка ${id} не на BACnet`);
  const { device } = tags[0].source.connection;
  const configured = argValue(args, '--address', tags[0].source.connection.address);
  const transport = await openTransport(args, configured ? '0' : String(DEFAULT_PORT));
  let errors = 0;
  try {
    const address = await resolveAddress(transport, device, configured, Number(argValue(args, '--wait', '3000')));
    write(`${id} — ${inst.title}\nустройство ${device}, ${address}\n\n`);
    for (const tag of tags) {
      const { point } = tag.source;
      const objectId = codec.objectIdOf(point);
      let result;
      try {
        const [r] = await transport.readMultiple(address, [{ objectId, properties: [P.PRESENT_VALUE, P.STATUS_FLAGS, P.OBJECT_NAME] }]);
        const pv = r.props[P.PRESENT_VALUE];
        if (pv.error) throw new Error(pv.error.message);
        const value = codec.decode(point, tag.dataType, pv.value);
        const flags = fmtFlags(r.props[P.STATUS_FLAGS]);
        result = `${String(first(r.props[P.OBJECT_NAME]) || '').padEnd(28)} ${fmtRaw(pv.value[0]).padEnd(10)} ${value}${tag.unit ? ` ${tag.unit}` : ''}${flags ? `  ${flags}` : ''}`;
      } catch (err) {
        errors += 1;
        result = `ОШИБКА: ${err.message}`;
        if (err.kind === 'timeout') {
          write(`${tag.param.padEnd(20)} ${formatBacnetPoint(point).padEnd(10)} ${result}\n`);
          break;
        }
      }
      write(`${tag.param.padEnd(20)} ${formatBacnetPoint(point).padEnd(10)} ${result}\n`);
    }
  } finally {
    transport.close();
  }
  return errors ? 1 : 0;
}

async function main(argv, write = (s) => process.stdout.write(s)) {
  const args = argv.slice(2);
  let code;
  try {
    if (args.includes('--help')) code = 2;
    else if (args.includes('--instance')) code = await checkInstance(args, write);
    else if (args.includes('--device')) code = await deviceObjects(args, write);
    else code = await discover(args, write);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
  if (code === 2) process.stderr.write(USAGE);
  return code;
}

if (require.main === module) main(process.argv).then((code) => { process.exitCode = code; });

module.exports = { main, paramGuess };
