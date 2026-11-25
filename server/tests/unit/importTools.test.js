'use strict';

const fs = require('fs');
const path = require('path');
const { parseCsv, detectDelimiter } = require('../../tools/lib/csv');
const { parsePoint } = require('../../tools/lib/pointNotation');
const { importInstances, main: importMain } = require('../../tools/importTags');
const { main: checkMain } = require('../../tools/checkModel');
const { loadModel } = require('../../core/modelLoader');
const fx = require('../helpers/modelFixture');

describe('csv', () => {
  test('разделитель «;» или «,» по первой строке', () => {
    expect(detectDelimiter('a;b;c\n1,2;3')).toBe(';');
    expect(detectDelimiter('a,b,c')).toBe(',');
  });

  test('кавычки, удвоенные кавычки, перевод строки в кавычках, BOM, CRLF, пустые строки', () => {
    const text = '﻿a;b\r\n"x;1";"он сказал ""да"""\r\n\r\n"много\nстрок";2\n';
    expect(parseCsv(text)).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['x;1', 'он сказал "да"'] },
      { line: 4, fields: ['много\nстрок', '2'] },
    ]);
  });

  test('последняя строка без перевода строки и строки только из разделителей', () => {
    expect(parseCsv('a,b\n;;\n1,2', { delimiter: ',' })).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: [';;'] },
      { line: 3, fields: ['1', '2'] },
    ]);
    expect(parseCsv('a;b\n;\n1;2')).toHaveLength(2);
  });

  test('незакрытая кавычка — ошибка с номером строки', () => {
    expect(() => parseCsv('a;b\n"x;1\n')).toThrow(/строка 2: незакрытая кавычка/);
  });
});

describe('pointNotation', () => {
  test.each([
    ['HR:100:F32', { area: 'holding', address: 100, type: 'float32' }],
    ['hr:12.3', { area: 'holding', address: 12, bit: 3 }],
    ['CO:0', { area: 'coil', address: 0 }],
    ['IR:30:i16', { area: 'input', address: 30, type: 'int16' }],
    ['DI:7', { area: 'discrete', address: 7 }],
  ])('modbus %s', (text, point) => {
    expect(parsePoint('modbus', text)).toEqual(point);
  });

  test.each([
    ['AI:1701', { objectType: 'analogInput', instance: 1701 }],
    ['av:5@10', { objectType: 'analogValue', instance: 5, priority: 10 }],
    ['MV:2', { objectType: 'multiStateValue', instance: 2 }],
    ['CSV:1', { objectType: 'characterstringValue', instance: 1 }],
  ])('bacnet %s', (text, point) => {
    expect(parsePoint('bacnet', text)).toEqual(point);
  });

  test('ошибки записи', () => {
    expect(() => parsePoint('modbus', 'AI:1')).toThrow(/ожидается HR\|IR/);
    expect(() => parsePoint('bacnet', 'HR:1')).toThrow(/ожидается AI\|AO/);
    expect(() => parsePoint('opc', 'x')).toThrow(/неизвестный драйвер/);
  });
});

describe('importTags', () => {
  const csv = (text) => importInstances(parseCsv(text));

  test('образец config/example/instances.csv даёт модель без ошибок', () => {
    const rows = parseCsv(fs.readFileSync(path.join(fx.EXAMPLE_DIR, 'instances.csv'), 'utf8'));
    const { instances, errors } = importInstances(rows);
    expect(errors).toEqual([]);
    expect(instances.map((i) => i.id)).toEqual(['AHU-03', 'AHU-18']);
    expect(instances[0]).toEqual({
      id: 'AHU-03',
      title: 'П3/В3 Конференц-зал, 2 этаж',
      template: 'AhuType',
      source: {
        driver: 'modbus', map: 'owen-ahu-v1', host: '10.10.1.13', unitId: 1,
        points: { HeaterValve: { area: 'holding', address: 140, type: 'int16', scale: 0.1 } },
      },
      exclude: ['Humidity'],
    });
    expect(instances[1].source.points.SupplyTempSp).toEqual({ objectType: 'analogValue', instance: 1801, priority: 10 });

    // Импорт рядом с примером загружается загрузчиком модели без ошибок
    const dir = fx.createConfigDir({});
    try {
      fs.cpSync(fx.EXAMPLE_DIR, dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'instances/imported.json'), JSON.stringify(instances));
      const model = loadModel({ dir });
      expect(model.issues).toEqual([]);
      expect(model.instances).toHaveLength(5);
    } finally {
      fx.removeDir(dir);
    }
  });

  test('строки точек могут идти раньше строки установки, exclude через пробел', () => {
    const { instances, errors } = csv('instance,param,point,title,template,driver,device,exclude\n'
      + 'N1,Temp,AI:1,,,,,\nN1,,,N30,Small,bacnet,7,Run Cmd\n');
    expect(errors).toEqual([]);
    expect(instances[0]).toMatchObject({ exclude: ['Run', 'Cmd'], source: { driver: 'bacnet', device: 7, points: { Temp: { objectType: 'analogInput', instance: 1 } } } });
  });

  test('ошибки таблицы собираются с номерами строк', () => {
    const { errors } = csv([
      'instance;title;template;driver;host;port;param;point;scale',
      'A1;a;Small;modbus;h;x;;;',
      'A1;b;Small;modbus;h;;;;',
      ';;;;;;Temp;HR:1;',
      'A2;;;;;;Temp;HR:1;',
      'A1;;;;;;Temp;AI:1;',
      'A1;;;;;;Sp;;',
      'A1;;;;h;;Run;CO:1;',
      'A1;;;;;;Cmd;CO:2;abc',
      'A1;;;;;;Cmd2;CO:3;',
      'A1;;;;;;Cmd2;CO:4;',
    ].join('\n'));
    const text = errors.join('\n');
    expect(text).toMatch(/строка 2: port — ожидается число/);
    expect(text).toMatch(/строка 3: установка A1 уже описана в строке 2/);
    expect(text).toMatch(/строка 4: пустая колонка instance/);
    expect(text).toMatch(/строка 5: установка A2 не описана/);
    expect(text).toMatch(/строка 6: A1.Temp — "AI:1": ожидается HR/);
    expect(text).toMatch(/строка 7: A1.Sp — пустая колонка point/);
    expect(text).toMatch(/строка 8: в строке точки заполнены поля установки \(host\)/);
    expect(text).toMatch(/строка 9: scale — ожидается число/);
    expect(text).toMatch(/строка 11: A1.Cmd2 — точка уже задана/);
  });

  test('ошибки заголовка', () => {
    expect(csv('title;foo;title\n').errors).toEqual([
      'заголовок: неизвестная колонка "foo"',
      'заголовок: колонка "title" повторяется',
      'заголовок: нет колонки instance',
    ]);
    expect(importInstances([]).errors).toEqual(['таблица пуста']);
  });

  test('CLI: запись файла и отказ при ошибках', () => {
    const dir = fx.createConfigDir({ 'ok.csv': 'instance;title;template;driver;map;host\nA1;a;Small;modbus;small-mb;h\n', 'bad.csv': 'foo\n' });
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const target = path.join(dir, 'instances/a.json');
      expect(importMain(['node', 'importTags', path.join(dir, 'ok.csv'), '--out', target])).toBe(0);
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))[0].id).toBe('A1');
      expect(importMain(['node', 'importTags', path.join(dir, 'bad.csv')])).toBe(1);
      expect(err.mock.calls.join('')).toMatch(/файл не записан/);
      expect(importMain(['node', 'importTags'])).toBe(2);
    } finally {
      out.mockRestore();
      err.mockRestore();
      fx.removeDir(dir);
    }
  });
});

describe('checkModel', () => {
  test('пример — код 0, ошибки — код 1 со списком', () => {
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const dir = fx.smallConfig([fx.modbusInstance('A1'), fx.modbusInstance('A2', { template: 'Nope' })]);
    try {
      expect(checkMain(['node', 'checkModel', '--config', fx.EXAMPLE_DIR, '--tags'])).toBe(0);
      expect(out.mock.calls.join('')).toMatch(/установок 3.*тегов 58[\s\S]*B1\/AHU-17\/SupplyTemp {2}Float {2}r {2}°C[\s\S]*Ошибок нет/);
      expect(checkMain(['node', 'checkModel', '--config', dir])).toBe(1);
      expect(out.mock.calls.join('')).toMatch(/A2 {2}ОТКЛЮЧЕНА: шаблон Nope/);
      expect(err.mock.calls.join('')).toMatch(/Ошибки \(1\):\n {2}list.json, A2: шаблон Nope/);
      expect(checkMain(['node', 'checkModel', '--config', '/nonexistent'])).toBe(1);
    } finally {
      out.mockRestore();
      err.mockRestore();
      fx.removeDir(dir);
    }
  });
});
