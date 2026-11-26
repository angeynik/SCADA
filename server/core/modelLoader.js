// core/modelLoader.js
// Загрузка конфигурации объекта из каталога (формат — docs/model.md):
//   site.json, templates/*.json, maps/*.json, instances/*.json.
// Результат — плоский список тегов: экземпляр × параметр шаблона → тег с идентификатором
// `<объект>/<установка>/<параметр>` и привязкой к контроллеру.
//
// Ошибки:
//   - нет каталога или site.json, site.json с ошибкой — исключение (сервер не запускается);
//   - ошибка в шаблоне или карте — они не загружаются, экземпляры с ними отключаются;
//   - ошибка в экземпляре — отключается только этот экземпляр.
// Все ошибки собираются в `issues` ({ file, instance?, message }), выводит их вызывающий.
'use strict';

const fs = require('fs');
const path = require('path');
const { schemas, check, NUMERIC_TYPES, LIMIT_ALARMS } = require('./modelSchema');

// ── Чтение файлов ────────────────────────────────────────────────────────
function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(err.code === 'ENOENT' ? 'файл не найден' : err.message);
  }
  try {
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`ошибка JSON: ${err.message}`);
  }
}

// Все *.json каталога по имени файла. Нет каталога — пустой список.
function readJsonDir(dir, issues) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      out.push({ file, data: readJson(file) });
    } catch (err) {
      issues.push({ file, message: err.message });
    }
  }
  return out;
}

// ── Точки привязки ───────────────────────────────────────────────────────
// Modbus: тип по умолчанию и проверка сочетаний area / type / bit.
// Возвращает { point } с заполненным type или { error }.
function normalizeModbusPoint(p) {
  const isBitArea = p.area === 'coil' || p.area === 'discrete';
  if (isBitArea) {
    if (p.bit !== undefined) return { error: `${p.area}: бит задаётся только для регистров` };
    if (p.type && p.type !== 'bool') return { error: `${p.area}: допустим только тип bool` };
    return { point: { ...p, type: 'bool' } };
  }
  if (p.bit !== undefined) {
    if (p.type && p.type !== 'bool') return { error: 'бит регистра читается как bool, тип не задаётся' };
    return { point: { ...p, type: 'bool' } };
  }
  if (p.type === 'bool') return { error: 'для регистра тип bool задаётся через bit' };
  const type = p.type || 'uint16';
  if (/32$/.test(type) && p.address > 65534) return { error: `${type} занимает 2 регистра, адрес не больше 65534` };
  return { point: { ...p, type } };
}

const isBacnetBinary = (t) => t.startsWith('binary');
const isBacnetInput = (t) => t.endsWith('Input');

// Совместимость параметра шаблона с точкой. Возвращает текст ошибки или null.
function checkBinding(param, driver, point) {
  const { dataType, access } = param;
  const integer = /Int/.test(dataType);
  if (integer && (!Number.isInteger(point.scale ?? 1) || !Number.isInteger(point.offset ?? 0))) {
    return `${dataType} с дробным scale или offset даёт дробные значения — используйте Float`;
  }
  if (driver === 'modbus') {
    if (dataType === 'String') return 'тип String не поддерживается Modbus';
    if (dataType === 'Boolean' && point.type !== 'bool') return 'Boolean привязывается к coil, discrete или биту регистра';
    if (dataType !== 'Boolean' && point.type === 'bool') return `${dataType} нельзя привязать к дискретной точке`;
    if (access === 'rw' && (point.area === 'input' || point.area === 'discrete')) {
      return `запись невозможна: область ${point.area} только для чтения`;
    }
    return null;
  }
  const t = point.objectType;
  if (dataType === 'String' && t !== 'characterstringValue') return 'String привязывается к characterstringValue';
  if (dataType !== 'String' && t === 'characterstringValue') return `${dataType} нельзя привязать к characterstringValue`;
  if (dataType === 'Boolean' && !isBacnetBinary(t)) return 'Boolean привязывается к binaryInput, binaryOutput или binaryValue';
  if (dataType !== 'Boolean' && isBacnetBinary(t)) return `${dataType} нельзя привязать к ${t}`;
  if (access === 'rw' && isBacnetInput(t)) return `запись невозможна: ${t} только для чтения`;
  return null;
}

// Проверки параметра после слияния с переопределением экземпляра
function checkParam(name, p) {
  const errors = [];
  if (p.min !== undefined && p.max !== undefined && p.min > p.max) errors.push(`${name}: min больше max`);
  const numeric = NUMERIC_TYPES.includes(p.dataType);
  for (const a of p.alarms) {
    if (LIMIT_ALARMS.includes(a.type) && !numeric) errors.push(`${name}: тревога ${a.type} только для числовых параметров`);
    if (a.type === 'state') {
      const ok = p.dataType === 'Boolean' ? typeof a.value === 'boolean' : typeof a.value === 'number';
      if (!ok) errors.push(`${name}: значение тревоги state не соответствует типу ${p.dataType}`);
    }
  }
  if (p.states && !numeric) errors.push(`${name}: states только для числовых параметров`);
  return errors;
}

// Метод шаблона: параметр есть, доступен для записи, значение его типа; имя не совпадает
// с параметром (у них общее пространство NodeId установки)
function checkMethod(name, m, params) {
  const p = params[m.param];
  if (params[name]) return `метод ${name}: совпадает с именем параметра`;
  if (!p) return `метод ${name}: нет параметра ${m.param}`;
  if (p.access !== 'rw') return `метод ${name}: параметр ${m.param} только для чтения`;
  if ((p.dataType === 'Boolean') !== (typeof m.value === 'boolean') || p.dataType === 'String') {
    return `метод ${name}: значение ${JSON.stringify(m.value)} не подходит к типу ${p.dataType}`;
  }
  return null;
}

function mergeParam(base, override) {
  if (!override) return base;
  const merged = { ...base, ...override };
  if (override.archive) merged.archive = { ...base.archive, ...override.archive };
  return merged;
}

// ── Сборка ───────────────────────────────────────────────────────────────
function loadTemplates(dir, issues) {
  const templates = new Map();
  for (const { file, data } of readJsonDir(path.join(dir, 'templates'), issues)) {
    const { value, error } = check(schemas.template, data);
    if (error) { issues.push({ file, message: error }); continue; }
    if (templates.has(value.id)) { issues.push({ file, message: `шаблон ${value.id} уже определён` }); continue; }
    const errors = [
      ...Object.entries(value.params).flatMap(([n, p]) => checkParam(n, p)),
      ...Object.entries(value.methods).map(([n, m]) => checkMethod(n, m, value.params)).filter(Boolean),
    ];
    if (errors.length) { issues.push({ file, message: errors.join('; ') }); continue; }
    templates.set(value.id, { ...value, file });
  }
  return templates;
}

function loadMaps(dir, templates, issues) {
  const maps = new Map();
  for (const { file, data } of readJsonDir(path.join(dir, 'maps'), issues)) {
    const { value, error } = check(schemas.map, data);
    if (error) { issues.push({ file, message: error }); continue; }
    if (maps.has(value.id)) { issues.push({ file, message: `карта ${value.id} уже определена` }); continue; }
    const tpl = templates.get(value.template);
    if (!tpl) { issues.push({ file, message: `шаблон ${value.template} не найден` }); continue; }
    const errors = [];
    const pts = {};
    for (const [name, raw] of Object.entries(value.points)) {
      const param = tpl.params[name];
      if (!param) { errors.push(`${name}: нет такого параметра в шаблоне ${tpl.id}`); continue; }
      const res = value.driver === 'modbus' ? normalizeModbusPoint(raw) : { point: raw };
      const err = res.error || checkBinding(param, value.driver, res.point);
      if (err) errors.push(`${name}: ${err}`);
      else pts[name] = res.point;
    }
    if (errors.length) { issues.push({ file, message: errors.join('; ') }); continue; }
    maps.set(value.id, { ...value, points: pts, file });
  }
  return maps;
}

function connectionOf(src) {
  return src.driver === 'modbus'
    ? { host: src.host, port: src.port, unitId: src.unitId }
    : { device: src.device, address: src.address || null };
}

// Возвращает { tags } или { error }
function buildInstance(site, inst, templates, maps) {
  const tpl = templates.get(inst.template);
  if (!tpl) return { error: `шаблон ${inst.template} не найден или содержит ошибки` };

  const driver = inst.source.driver;
  const { value: src, error: srcError } = check(schemas.source[driver], inst.source, 'source');
  if (srcError) return { error: srcError };

  let map = null;
  if (src.map) {
    map = maps.get(src.map);
    if (!map) return { error: `карта ${src.map} не найдена или содержит ошибки` };
    if (map.driver !== driver) return { error: `карта ${map.id} для драйвера ${map.driver}, а экземпляр — ${driver}` };
    if (map.template !== tpl.id) return { error: `карта ${map.id} для шаблона ${map.template}, а экземпляр — ${tpl.id}` };
  }

  const errors = [];
  const excluded = new Set(inst.exclude);
  for (const name of [...excluded, ...Object.keys(inst.params), ...Object.keys(src.points || {})]) {
    if (!tpl.params[name]) errors.push(`${name}: нет такого параметра в шаблоне ${tpl.id}`);
  }
  for (const name of Object.keys(src.points || {})) {
    if (excluded.has(name)) errors.push(`${name}: параметр исключён (exclude), но привязан`);
  }
  if (errors.length) return { error: [...new Set(errors)].join('; ') };

  const byteOrder = driver === 'modbus' ? src.byteOrder || (map && map.byteOrder) || 'ABCD' : undefined;
  const connection = connectionOf(src);
  const tags = [];

  for (const [name, base] of Object.entries(tpl.params)) {
    if (excluded.has(name)) continue;
    const param = mergeParam(base, inst.params[name]);
    errors.push(...checkParam(name, param));

    const own = src.points && src.points[name];
    let point = map && map.points[name];
    if (own) {
      const res = driver === 'modbus' ? normalizeModbusPoint(own) : { point: own };
      if (res.error) { errors.push(`${name}: ${res.error}`); continue; }
      point = res.point;
    }
    if (!point) { errors.push(`${name}: нет привязки к контроллеру (добавьте точку или exclude)`); continue; }
    const bindError = checkBinding(param, driver, point);
    if (bindError) { errors.push(`${name}: ${bindError}`); continue; }

    const archive = { ...param.archive };
    if (archive.deadband === undefined) archive.deadband = param.deadband;

    tags.push({
      id: `${site.id}/${inst.id}/${name}`,
      site: site.id,
      instance: inst.id,
      param: name,
      template: tpl.id,
      title: param.title,
      instanceTitle: inst.title,
      description: param.description,
      dataType: param.dataType,
      access: param.access,
      unit: param.unit,
      min: param.min,
      max: param.max,
      writeLevel: param.writeLevel,
      states: param.states,
      deadband: param.deadband,
      archive,
      alarms: param.alarms,
      source: { driver, connection, byteOrder, point },
    });
  }
  if (errors.length) return { error: errors.join('; ') };
  return { tags };
}

// Загружает модель. Возвращает { site, templates, maps, instances, disabled, tags, issues }:
//   instances — включённые экземпляры без ошибок; disabled — { id, reason } отключённых;
//   tags — Map(id → тег) в порядке файлов экземпляров и параметров шаблона.
function loadModel({ dir }) {
  if (!fs.existsSync(dir)) {
    throw new Error(`каталог конфигурации ${dir} не найден (образец — config/example, см. docs/model.md)`);
  }
  const siteFile = path.join(dir, 'site.json');
  let siteData;
  try {
    siteData = readJson(siteFile);
  } catch (err) {
    throw new Error(`${siteFile}: ${err.message}`);
  }
  const { value: site, error: siteError } = check(schemas.site, siteData);
  if (siteError) throw new Error(`${siteFile}: ${siteError}`);

  const issues = [];
  const templates = loadTemplates(dir, issues);
  const maps = loadMaps(dir, templates, issues);

  const instances = [];
  const disabled = [];
  const tags = new Map();
  const fail = (file, id, reason) => {
    issues.push({ file, instance: id, message: reason });
    disabled.push({ id, reason });
  };

  // Первый проход — форма каждого экземпляра и подсчёт идентификаторов
  const entries = [];
  const files = new Map();
  for (const { file, data } of readJsonDir(path.join(dir, 'instances'), issues)) {
    const list = Array.isArray(data) ? data : [data];
    list.forEach((raw, index) => {
      const id = raw && typeof raw.id === 'string' ? raw.id : `#${index + 1}`;
      const { value: inst, error } = check(schemas.instance, raw);
      if (error) { fail(file, id, error); return; }
      entries.push({ file, inst });
      files.set(inst.id, [...(files.get(inst.id) || []), path.basename(file)]);
    });
  }

  // Второй проход. Повтор идентификатора отключает все его копии: какая из них верная,
  // сервер не угадывает, а молча выбранная «первая по алфавиту» могла бы быть ошибочной.
  for (const { file, inst } of entries) {
    const where = files.get(inst.id);
    if (where.length > 1) {
      fail(file, inst.id, `установка определена ${where.length} раза (${where.join(', ')}), отключены все копии`);
      continue;
    }
    if (!inst.enabled) {
      disabled.push({ id: inst.id, reason: 'выключена (enabled: false)' });
      continue;
    }
    const res = buildInstance(site, inst, templates, maps);
    if (res.error) { fail(file, inst.id, res.error); continue; }
    for (const tag of res.tags) tags.set(tag.id, tag);
    // Методы — только для параметров, которые есть у установки (не исключены)
    const tpl = templates.get(inst.template);
    const methods = Object.entries(tpl.methods)
      .map(([name, m]) => ({ name, title: m.title, tagId: `${site.id}/${inst.id}/${m.param}`, value: m.value }))
      .filter((m) => tags.has(m.tagId));
    instances.push({ ...inst, file, tagIds: res.tags.map((t) => t.id), methods });
  }

  return { dir, site, templates, maps, instances, disabled, tags, issues };
}

// Сводка модели в лог: итог одной строкой и каждая ошибка отдельной строкой
function reportModel(model, logger) {
  const { site, templates, maps, instances, disabled, tags, issues } = model;
  logger.logInfoMessage(
    `[Model] - load - объект ${site.id}: шаблонов ${templates.size}, карт ${maps.size}, `
    + `установок ${instances.length}, отключено ${disabled.length}, тегов ${tags.size}`,
  );
  for (const i of issues) {
    const where = i.instance ? `${path.basename(i.file)}, ${i.instance}` : path.basename(i.file);
    logger.logErrorMessage(`[Model] - load - ${where}: ${i.message}`);
  }
}

module.exports = { loadModel, reportModel, normalizeModbusPoint, checkBinding };
