// tools/bacnetEmulator.js
// Эмулятор устройств BACnet/IP (вместо N30): N устройств по шаблону параметров на
// 127.0.0.1, порты base-port, base-port+1, …, номера устройств base-device, base-device+1, …
// Объекты создаются по параметрам шаблона: Boolean — binaryInput (r) / binaryOutput (rw),
// параметры с states — multiStateInput / multiStateValue, числа — analogInput /
// analogValue, String — characterstringValue; номер объекта — порядковый номер
// параметра в шаблоне. Значения меняются раз в секунду (как в modbusEmulator),
// записи клиента с приоритетом сохраняются, COV поддерживается.
//
//   node tools/bacnetEmulator.js --template <id шаблона> [--count 10] [--base-port 47809]
//        [--base-device 40001] [--config <каталог>] [--write-instances <instances/файл.json>]
//        [--prefix BEMU] [--max-objects <N>] [--no-cov]
//
// --max-objects — сколько объектов устройство отдаёт в одном ReadPropertyMultiple
// (больше — Abort, как у устройства без сегментации); --no-cov — подписка отвергается.
// --write-instances записывает экземпляры BEMU-01 … BEMU-N с адресами эмуляторов.
// Порт сервера (BACNET_PORT) не должен совпадать с портами эмуляторов.
// Остановка — Ctrl+C.
'use strict';

const fs = require('fs');
const path = require('path');
const bacnet = require('@bacnet-js/client');
const { loadConfig } = require('../services/config');
const { loadModel } = require('../core/modelLoader');
const { simulate } = require('./modbusEmulator');
const { createBacnetDeviceEmulator } = require('./lib/bacnetDevice');

const UNITS = { '°C': bacnet.EngineeringUnits.DEGREES_CELSIUS, '%': bacnet.EngineeringUnits.PERCENT, ч: bacnet.EngineeringUnits.HOURS };

function argValue(args, name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

function objectTypeFor(param) {
  const rw = param.access === 'rw';
  if (param.dataType === 'Boolean') return rw ? 'binaryOutput' : 'binaryInput';
  if (param.dataType === 'String') return 'characterstringValue';
  if (param.states) return rw ? 'multiStateValue' : 'multiStateInput';
  return rw ? 'analogValue' : 'analogInput';
}

// Раскладка объектов по шаблону: [{ name, param, point: { objectType, instance[, offset] } }].
// Состояния multiState в BACnet нумеруются с 1; если в шаблоне они с 0 — offset −1.
function layoutPoints(template) {
  return Object.entries(template.params).map(([name, param], i) => {
    const point = { objectType: objectTypeFor(param), instance: i + 1 };
    if (param.states && Math.min(...Object.keys(param.states).map(Number)) === 0) point.offset = -1;
    return { name, param, point };
  });
}

// Значение объекта (presentValue) в момент t
function initialValue(p, t, phase) {
  if (p.param.dataType === 'String') return '';
  return simulate(p.name, p.param, t, phase) - (p.point.offset || 0);
}

// Запускает эмуляторы. Возвращает { devices, instances, stop }.
async function startBacnetEmulators({
  model, templateId, count, basePort = 0, baseDevice = 40001, prefix = 'BEMU', host = '127.0.0.1', maxObjectsPerRpm = null, cov = true,
}) {
  const template = model.templates.get(templateId);
  if (!template) throw new Error(`шаблон ${templateId} не найден в ${model.dir}`);
  const points = layoutPoints(template);
  const width = String(count).length < 2 ? 2 : String(count).length;

  const devices = [];
  const instances = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const deviceId = baseDevice + i;
      const id = `${prefix}-${String(i + 1).padStart(width, '0')}`;
      const dev = createBacnetDeviceEmulator({
        deviceId,
        host,
        port: basePort ? basePort + i : 0,
        name: id,
        maxObjectsPerRpm,
        cov,
        covIncrement: 0.2,
        objects: points.map((p) => ({
          objectType: p.point.objectType,
          instance: p.point.instance,
          name: `${id}.${p.name}`,
          value: initialValue(p, 0, i),
          units: UNITS[p.param.unit],
          states: p.param.states ? Math.max(...Object.keys(p.param.states).map(Number)) - (p.point.offset || 0) : undefined,
        })),
      });
      const port = await dev.start();
      devices.push(dev);
      instances.push({
        id,
        title: `Эмулятор ${id} (BACnet ${deviceId})`,
        template: template.id,
        source: {
          driver: 'bacnet',
          device: deviceId,
          address: `${host}:${port}`,
          points: Object.fromEntries(points.map((p) => [p.name, p.point])),
        },
      });
    }
  } catch (err) {
    await Promise.all(devices.map((d) => d.stop()));
    throw err;
  }

  const t0 = Date.now();
  const timer = setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    devices.forEach((dev, i) => {
      for (const p of points) {
        if (p.param.access === 'r' && p.param.dataType !== 'String') dev.setValue(p.point.objectType, p.point.instance, initialValue(p, t, i));
      }
    });
  }, 1000);
  timer.unref();

  return {
    devices,
    instances,
    async stop() {
      clearInterval(timer);
      await Promise.all(devices.map((d) => d.stop()));
    },
  };
}

const USAGE = 'Использование: node tools/bacnetEmulator.js --template <id шаблона> [--count 10] [--base-port 47809] '
  + '[--base-device 40001] [--config <каталог>] [--write-instances <файл>] [--prefix BEMU] [--max-objects N] [--no-cov]\n';

async function main(argv) {
  const args = argv.slice(2);
  const templateId = argValue(args, '--template');
  if (!templateId) {
    process.stderr.write(USAGE);
    return 2;
  }
  const count = Number(argValue(args, '--count', '1'));
  const basePort = Number(argValue(args, '--base-port', '47809'));
  const baseDevice = Number(argValue(args, '--base-device', '40001'));
  const maxObjects = argValue(args, '--max-objects');
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('--count: от 1 до 500');
  if (!Number.isInteger(basePort) || basePort < 1 || basePort + count > 65536) throw new Error('--base-port: недопустимый порт');
  if (!Number.isInteger(baseDevice) || baseDevice < 0 || baseDevice + count > 4194302) throw new Error('--base-device: недопустимый номер');

  const dirArg = argValue(args, '--config');
  const dir = dirArg ? path.resolve(dirArg) : loadConfig().config.configDir;
  const model = loadModel({ dir });
  const emu = await startBacnetEmulators({
    model,
    templateId,
    count,
    basePort,
    baseDevice,
    prefix: argValue(args, '--prefix', 'BEMU'),
    maxObjectsPerRpm: maxObjects ? Number(maxObjects) : null,
    cov: !args.includes('--no-cov'),
  });

  const out = argValue(args, '--write-instances');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(emu.instances, null, 2)}\n`);
    process.stdout.write(`Экземпляры записаны: ${out}\n`);
  }
  process.stdout.write(`Устройств BACnet: ${count}, 127.0.0.1:${basePort}–${basePort + count - 1}, `
    + `номера ${baseDevice}–${baseDevice + count - 1}, шаблон ${templateId}. Остановка — Ctrl+C.\n`);

  const shutdown = () => emu.stop().then(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return null;
}

if (require.main === module) {
  main(process.argv)
    .then((code) => { if (code !== null) process.exitCode = code; })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { startBacnetEmulators, layoutPoints, objectTypeFor };
