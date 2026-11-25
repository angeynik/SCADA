// tools/modbusDiag.js
// Диагностика Modbus TCP без запуска сервера.
//
// Установка — читает каждую точку отдельным запросом и печатает таблицу
// «параметр, точка, сырые слова, значение или ошибка»:
//   node tools/modbusDiag.js --instance AHU-01 [--config <каталог>] [--host H] [--port P]
//   (--host и --port заменяют адрес из конфигурации, например для проверки на эмуляторе)
//
// Сырое чтение:
//   node tools/modbusDiag.js --host 10.10.1.11 [--port 502] [--unit 1] --area holding --address 100 [--count 10]
//
// Код выхода: 0 — всё прочитано, 1 — есть ошибки, 2 — неверные аргументы.
'use strict';

const path = require('path');
const { loadConfig } = require('../services/config');
const { loadModel } = require('../core/modelLoader');
const { createTcpTransport } = require('../drivers/modbusTcp/transport');
const { decode, pointSize } = require('../drivers/modbusTcp/codec');

const AREAS = ['coil', 'discrete', 'holding', 'input'];
const USAGE = 'Использование:\n'
  + '  node tools/modbusDiag.js --instance <id> [--config <каталог>] [--host H] [--port P]\n'
  + '  node tools/modbusDiag.js --host H [--port 502] [--unit 1] --area holding|input|coil|discrete --address N [--count 1]\n';

function argValue(args, name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

const fmtPoint = (p) => `${p.area}:${p.address}${p.bit !== undefined ? `.${p.bit}` : ''}${p.area === 'holding' || p.area === 'input' ? ` ${p.type}` : ''}`;
const fmtWords = (w) => w.map((x) => (typeof x === 'boolean' ? String(x) : `0x${x.toString(16).padStart(4, '0')}`)).join(' ');

async function diagInstance(args, write) {
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
  if (tags[0].source.driver !== 'modbus') throw new Error(`установка ${id} не на Modbus`);
  const conn = tags[0].source.connection;
  const host = argValue(args, '--host', conn.host);
  const port = Number(argValue(args, '--port', conn.port));

  const transport = createTcpTransport({ host, port });
  await transport.connect();
  write(`${id} — ${inst.title}\n${host}:${port}, unit ${conn.unitId}, byteOrder ${tags[0].source.byteOrder}\n\n`);
  let errors = 0;
  try {
    for (const tag of tags) {
      const { point, byteOrder } = tag.source;
      let result;
      try {
        const words = await transport.read(conn.unitId, point.area, point.address, pointSize(point));
        const value = decode(point, words, byteOrder);
        result = `${fmtWords(words).padEnd(14)} ${value}${tag.unit ? ` ${tag.unit}` : ''}`;
      } catch (err) {
        errors += 1;
        result = `ОШИБКА: ${err.message}`;
        if (err.kind === 'transport') {
          write(`${tag.param.padEnd(20)} ${fmtPoint(point).padEnd(22)} ${result}\n`);
          break;
        }
      }
      write(`${tag.param.padEnd(20)} ${fmtPoint(point).padEnd(22)} ${result}\n`);
    }
  } finally {
    transport.close();
  }
  return errors ? 1 : 0;
}

async function diagRaw(args, write) {
  const host = argValue(args, '--host');
  const port = Number(argValue(args, '--port', '502'));
  const unit = Number(argValue(args, '--unit', '1'));
  const area = argValue(args, '--area');
  const address = Number(argValue(args, '--address'));
  const count = Number(argValue(args, '--count', '1'));
  if (!AREAS.includes(area) || !Number.isInteger(address) || !Number.isInteger(count) || count < 1) return 2;

  const transport = createTcpTransport({ host, port });
  await transport.connect();
  try {
    const words = await transport.read(unit, area, address, count);
    words.forEach((w, i) => write(`${area}:${address + i}  ${typeof w === 'boolean' ? w : `${w}  0x${w.toString(16).padStart(4, '0')}`}\n`));
    return 0;
  } catch (err) {
    write(`ОШИБКА: ${err.message}\n`);
    return 1;
  } finally {
    transport.close();
  }
}

async function main(argv, write = (s) => process.stdout.write(s)) {
  const args = argv.slice(2);
  let code;
  try {
    if (args.includes('--instance')) code = await diagInstance(args, write);
    else if (args.includes('--host')) code = await diagRaw(args, write);
    else code = 2;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
  if (code === 2) process.stderr.write(USAGE);
  return code;
}

if (require.main === module) main(process.argv).then((code) => { process.exitCode = code; });

module.exports = { main };
