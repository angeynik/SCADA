// tools/checkModel.js
// Проверка конфигурации объекта без запуска сервера: загружает модель так же, как
// сервер, и печатает сводку, список установок и все ошибки.
//
//   node tools/checkModel.js [--config <каталог>] [--tags]
//
// Каталог по умолчанию — CONFIG_DIR из conf.env. --tags печатает все теги.
// Код выхода: 0 — ошибок нет, 1 — есть ошибки или модель не загружена.
'use strict';

const path = require('path');
const { loadConfig } = require('../services/config');
const { loadModel } = require('../core/modelLoader');

function describeSource(src) {
  const c = src.connection;
  return src.driver === 'modbus'
    ? `modbus ${c.host}:${c.port} unit ${c.unitId}`
    : `bacnet device ${c.device}${c.address ? ` @ ${c.address}` : ''}`;
}

function main(argv) {
  const args = argv.slice(2);
  const at = args.indexOf('--config');
  let dir;
  try {
    dir = at >= 0 ? path.resolve(args[at + 1] || '') : loadConfig().config.configDir;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }

  let model;
  try {
    model = loadModel({ dir });
  } catch (err) {
    process.stderr.write(`Модель не загружена: ${err.message}\n`);
    return 1;
  }
  const { site, templates, maps, instances, disabled, tags, issues } = model;
  const out = [];
  out.push(`Каталог: ${dir}`);
  out.push(`Объект ${site.id} — ${site.title}`);
  out.push(`Шаблонов ${templates.size}, карт ${maps.size}, установок ${instances.length}, отключено ${disabled.length}, тегов ${tags.size}`);
  out.push('', 'Установки:');
  for (const inst of instances) {
    const first = tags.get(inst.tagIds[0]);
    out.push(`  ${inst.id}  ${inst.template}  ${describeSource(first.source)}  тегов ${inst.tagIds.length}  — ${inst.title}`);
  }
  for (const d of disabled) out.push(`  ${d.id}  ОТКЛЮЧЕНА: ${d.reason}`);
  if (args.includes('--tags')) {
    out.push('', 'Теги:');
    for (const t of tags.values()) out.push(`  ${t.id}  ${t.dataType}  ${t.access}${t.unit ? `  ${t.unit}` : ''}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);

  if (issues.length) {
    const lines = issues.map((i) => `  ${path.basename(i.file)}${i.instance ? `, ${i.instance}` : ''}: ${i.message}`);
    process.stderr.write(`\nОшибки (${issues.length}):\n${lines.join('\n')}\n`);
    return 1;
  }
  process.stdout.write('\nОшибок нет.\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { main };
