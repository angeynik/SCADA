// tools/modbusEmulator.js
// Эмулятор контроллеров ОВЕН: N контроллеров Modbus TCP по одной карте привязки
// на 127.0.0.1, порты base-port, base-port+1, … Значения меняются раз в секунду
// (температуры — синус около 20 °C, проценты — около 50 %, счётчики растут), записанные
// клиентом значения rw-параметров сохраняются.
//
//   node tools/modbusEmulator.js --map <id карты> [--count 80] [--base-port 15020]
//        [--config <каталог>] [--write-instances <instances/файл.json>] [--prefix EMU]
//
// --write-instances записывает экземпляры EMU-01 … EMU-N, указывающие на эмулятор:
// положите файл в instances/ рабочей конфигурации и запустите сервер.
// Остановка — Ctrl+C.
'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../services/config');
const { loadModel } = require('../core/modelLoader');
const { encode, setBit } = require('../drivers/modbusTcp/codec');
const { createModbusSlave } = require('./lib/modbusSlave');

function argValue(args, name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

// Значение параметра в момент t (с) для установки с фазой phase
function simulate(name, param, t, phase) {
  if (param.dataType === 'Boolean') return /Running/.test(name);
  if (param.states) return Number(Object.keys(param.states)[0]);
  if (param.unit === '°C') return Math.round((20 + 3 * Math.sin(t / 60 + phase)) * 10) / 10;
  if (param.unit === '%') return Math.round(50 + 40 * Math.sin(t / 90 + phase));
  return Math.floor(t / 3600) + 1000;
}

function writePoint(slave, point, value, byteOrder) {
  const enc = encode(point, value, byteOrder);
  if ('coil' in enc) slave.setBit('coil', point.address, enc.coil);
  else if ('bit' in enc) {
    const area = point.area;
    slave.mem[area][point.address] = setBit(slave.mem[area][point.address], enc.bit, enc.state, byteOrder);
  } else slave.setRegisters(point.area, point.address, enc.words);
}

// Запускает эмуляторы. Возвращает { slaves, instances, stop }.
async function startEmulators({ model, mapId, count, basePort, prefix = 'EMU', host = '127.0.0.1' }) {
  const map = model.maps.get(mapId);
  if (!map) throw new Error(`карта ${mapId} не найдена в ${model.dir}`);
  if (map.driver !== 'modbus') throw new Error(`карта ${mapId} не для Modbus`);
  const template = model.templates.get(map.template);
  const points = Object.entries(map.points).map(([name, point]) => ({ name, point, param: template.params[name] }));
  const width = String(count).length < 2 ? 2 : String(count).length;

  const slaves = [];
  const instances = [];
  for (let i = 0; i < count; i += 1) {
    const slave = createModbusSlave({ host, port: basePort ? basePort + i : 0 });
    const port = await slave.start();
    slaves.push(slave);
    const id = `${prefix}-${String(i + 1).padStart(width, '0')}`;
    const exclude = Object.keys(template.params).filter((n) => !map.points[n]);
    instances.push({
      id,
      title: `Эмулятор ${id} (${map.id})`,
      template: template.id,
      source: { driver: 'modbus', map: map.id, host, port },
      ...(exclude.length ? { exclude } : {}),
    });
    for (const p of points) writePoint(slave, p.point, simulate(p.name, p.param, 0, i), map.byteOrder);
  }

  const t0 = Date.now();
  const timer = setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    slaves.forEach((slave, i) => {
      for (const p of points) {
        if (p.param.access === 'r') writePoint(slave, p.point, simulate(p.name, p.param, t, i), map.byteOrder);
      }
    });
  }, 1000);
  timer.unref();

  return {
    slaves,
    instances,
    async stop() {
      clearInterval(timer);
      await Promise.all(slaves.map((s) => s.stop()));
    },
  };
}

async function main(argv) {
  const args = argv.slice(2);
  const mapId = argValue(args, '--map');
  if (!mapId) {
    process.stderr.write('Использование: node tools/modbusEmulator.js --map <id карты> [--count 80] [--base-port 15020] [--config <каталог>] [--write-instances <файл>] [--prefix EMU]\n');
    return 2;
  }
  const count = Number(argValue(args, '--count', '1'));
  const basePort = Number(argValue(args, '--base-port', '15020'));
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('--count: от 1 до 500');
  if (!Number.isInteger(basePort) || basePort < 1 || basePort + count > 65536) throw new Error('--base-port: недопустимый порт');

  const dirArg = argValue(args, '--config');
  const dir = dirArg ? path.resolve(dirArg) : loadConfig().config.configDir;
  const model = loadModel({ dir });
  const emu = await startEmulators({ model, mapId, count, basePort, prefix: argValue(args, '--prefix', 'EMU') });

  const out = argValue(args, '--write-instances');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(emu.instances, null, 2)}\n`);
    process.stdout.write(`Экземпляры записаны: ${out}\n`);
  }
  process.stdout.write(`Эмуляторов: ${count}, 127.0.0.1:${basePort}–${basePort + count - 1}, карта ${mapId}. Остановка — Ctrl+C.\n`);

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

module.exports = { startEmulators, simulate };
