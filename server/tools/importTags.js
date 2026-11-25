// tools/importTags.js
// Импорт таблицы установок и привязок (CSV) в файл экземпляров instances/*.json.
//
//   node tools/importTags.js <таблица.csv> [--out <instances/файл.json>]
//
// Без --out результат печатается в stdout. После импорта проверьте всю модель:
//   node tools/checkModel.js
//
// Колонки (заголовок обязателен, порядок любой, регистр не важен):
//   instance, title, template, driver, map, host, port, unitId, device, address, exclude,
//   param, point, scale, offset.
// Строка без param описывает установку (instance, title, template, driver и параметры связи).
// Строка с param — точка привязки этой установки: point в короткой записи
// (tools/lib/pointNotation.js), при необходимости scale и offset. Такие строки
// переопределяют и дополняют карту (map), а для BACnet без карты задают все точки.
// exclude — параметры шаблона, которых нет у установки, через запятую или пробел.
// Формат таблицы с примером — docs/model.md, образец — config/example/instances.csv.
'use strict';

const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./lib/csv');
const { parsePoint } = require('./lib/pointNotation');

const COLUMNS = [
  'instance', 'title', 'template', 'driver', 'map', 'host', 'port', 'unitId', 'device', 'address',
  'exclude', 'param', 'point', 'scale', 'offset',
];
const INSTANCE_ONLY = ['title', 'template', 'driver', 'map', 'host', 'port', 'unitId', 'device', 'address', 'exclude'];
const INT_FIELDS = ['port', 'unitId', 'device'];

function toNumber(text, name, line, errors) {
  const n = Number(String(text).replace(',', '.'));
  if (!Number.isFinite(n)) {
    errors.push(`строка ${line}: ${name} — ожидается число, получено "${text}"`);
    return undefined;
  }
  return n;
}

// rows — результат parseCsv. Возвращает { instances, errors }.
function importInstances(rows) {
  const errors = [];
  if (!rows.length) return { instances: [], errors: ['таблица пуста'] };

  const header = rows[0].fields.map((h) => h.trim());
  const index = {};
  header.forEach((h, i) => {
    const col = COLUMNS.find((c) => c.toLowerCase() === h.toLowerCase());
    if (!col) errors.push(`заголовок: неизвестная колонка "${h}"`);
    else if (col in index) errors.push(`заголовок: колонка "${h}" повторяется`);
    else index[col] = i;
  });
  if (!('instance' in index)) errors.push('заголовок: нет колонки instance');
  if (errors.length) return { instances: [], errors };

  const byId = new Map();
  const pointRows = [];

  for (const { line, fields } of rows.slice(1)) {
    const cell = (c) => (c in index ? (fields[index[c]] || '').trim() : '');
    const id = cell('instance');
    if (!id) { errors.push(`строка ${line}: пустая колонка instance`); continue; }

    if (cell('param')) {
      const extra = INSTANCE_ONLY.filter((c) => cell(c));
      if (extra.length) errors.push(`строка ${line}: в строке точки заполнены поля установки (${extra.join(', ')})`);
      pointRows.push({ line, id, param: cell('param'), point: cell('point'), scale: cell('scale'), offset: cell('offset') });
      continue;
    }
    if (byId.has(id)) { errors.push(`строка ${line}: установка ${id} уже описана в строке ${byId.get(id).line}`); continue; }

    const source = { driver: cell('driver') };
    for (const c of ['map', 'host', 'address']) if (cell(c)) source[c] = cell(c);
    for (const c of INT_FIELDS) {
      if (cell(c)) {
        const n = toNumber(cell(c), c, line, errors);
        if (n !== undefined) source[c] = n;
      }
    }
    const inst = { id, title: cell('title'), template: cell('template'), source };
    const exclude = cell('exclude').split(/[\s,]+/).filter(Boolean);
    if (exclude.length) inst.exclude = exclude;
    byId.set(id, { line, inst });
  }

  for (const r of pointRows) {
    const entry = byId.get(r.id);
    if (!entry) { errors.push(`строка ${r.line}: установка ${r.id} не описана (нет строки без param)`); continue; }
    if (!r.point) { errors.push(`строка ${r.line}: ${r.id}.${r.param} — пустая колонка point`); continue; }
    const src = entry.inst.source;
    let point;
    try {
      point = parsePoint(src.driver, r.point);
    } catch (err) {
      errors.push(`строка ${r.line}: ${r.id}.${r.param} — ${err.message}`);
      continue;
    }
    if (r.scale) point.scale = toNumber(r.scale, 'scale', r.line, errors);
    if (r.offset) point.offset = toNumber(r.offset, 'offset', r.line, errors);
    src.points = src.points || {};
    if (src.points[r.param]) { errors.push(`строка ${r.line}: ${r.id}.${r.param} — точка уже задана`); continue; }
    src.points[r.param] = point;
  }

  return { instances: [...byId.values()].map((e) => e.inst), errors };
}

function main(argv) {
  const args = argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args[outAt + 1] : null;
  const input = args.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
  if (!input || (outAt >= 0 && !out)) {
    process.stderr.write('Использование: node tools/importTags.js <таблица.csv> [--out <instances/файл.json>]\n');
    return 2;
  }

  let rows;
  try {
    rows = parseCsv(fs.readFileSync(input, 'utf8'));
  } catch (err) {
    process.stderr.write(`${input}: ${err.message}\n`);
    return 1;
  }
  const { instances, errors } = importInstances(rows);
  if (errors.length) {
    process.stderr.write(`Ошибки (${errors.length}), файл не записан:\n${errors.map((e) => `  ${e}`).join('\n')}\n`);
    return 1;
  }

  const json = `${JSON.stringify(instances, null, 2)}\n`;
  if (!out) {
    process.stdout.write(json);
    return 0;
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, json);
  process.stdout.write(`Записано установок: ${instances.length} → ${out}\nПроверьте модель: node tools/checkModel.js\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { importInstances, main };
