'use strict';

const { loadModel, reportModel, normalizeModbusPoint } = require('../../core/modelLoader');
const { createFakeLogger } = require('../helpers/fakeLogger');
const fx = require('../helpers/modelFixture');

describe('modelLoader.loadModel', () => {
  const dirs = [];
  const make = (...args) => {
    const dir = fx.smallConfig(...args);
    dirs.push(dir);
    return dir;
  };
  const makeFiles = (files) => {
    const dir = fx.createConfigDir(files);
    dirs.push(dir);
    return dir;
  };
  const messages = (model) => model.issues.map((i) => `${i.instance || ''}: ${i.message}`).join('\n');

  afterEach(() => {
    while (dirs.length) fx.removeDir(dirs.pop());
  });

  test('пример config/example загружается без ошибок', () => {
    const model = loadModel({ dir: fx.EXAMPLE_DIR });
    expect(model.issues).toEqual([]);
    expect(model.site.id).toBe('B1');
    expect(model.instances.map((i) => i.id)).toEqual(['AHU-01', 'AHU-02', 'AHU-17']);
    // 20 параметров шаблона; у AHU-02 и AHU-17 исключена влажность
    expect(model.tags.size).toBe(58);
  });

  test('теги: идентификатор, порядок, свойства параметра и привязка', () => {
    const model = loadModel({ dir: make([fx.modbusInstance('A1'), fx.modbusInstance('A2')]) });
    expect([...model.tags.keys()]).toEqual([
      'T1/A1/Run', 'T1/A1/Cmd', 'T1/A1/Temp', 'T1/A1/Sp',
      'T1/A2/Run', 'T1/A2/Cmd', 'T1/A2/Temp', 'T1/A2/Sp',
    ]);
    const sp = model.tags.get('T1/A1/Sp');
    expect(sp).toMatchObject({
      site: 'T1',
      instance: 'A1',
      param: 'Sp',
      template: 'Small',
      dataType: 'Float',
      access: 'rw',
      min: 10,
      max: 30,
      writeLevel: 3,
      archive: { mode: 'change', deadband: 0 },
      alarms: [],
      source: {
        driver: 'modbus',
        connection: { host: '127.0.0.1', port: 502, unitId: 1 },
        byteOrder: 'ABCD',
        point: { area: 'holding', address: 12, type: 'float32', scale: 1, offset: 0 },
      },
    });
    expect(model.tags.get('T1/A1/Temp').archive.deadband).toBe(0.1);
    expect(model.instances[0].tagIds).toHaveLength(4);
  });

  test('нет каталога, нет site.json или в нём ошибка — исключение', () => {
    expect(() => loadModel({ dir: '/nonexistent/scada' })).toThrow(/не найден.*config\/example/);
    expect(() => loadModel({ dir: makeFiles({ 'templates/x.json': {} }) })).toThrow(/site.json: файл не найден/);
    expect(() => loadModel({ dir: makeFiles({ 'site.json': { id: 'B 1', title: 'x' } }) }))
      .toThrow(/site.json: id: недопустимые символы/);
    expect(() => loadModel({ dir: makeFiles({ 'site.json': '{oops' }) })).toThrow(/ошибка JSON/);
  });

  test('ошибка в одном экземпляре отключает только его', () => {
    const model = loadModel({
      dir: make([
        fx.modbusInstance('A1'),
        fx.modbusInstance('A2', { source: { driver: 'modbus', map: 'small-mb', host: '127.0.0.1', port: 0 } }),
      ]),
    });
    expect(model.instances.map((i) => i.id)).toEqual(['A1']);
    expect(model.disabled).toEqual([{ id: 'A2', reason: expect.stringMatching(/port: не меньше 1/) }]);
    expect(model.tags.size).toBe(4);
  });

  test('повтор идентификатора отключает все копии', () => {
    const dir = make([fx.modbusInstance('A1'), fx.modbusInstance('A2')], {
      extraFiles: { 'instances/more.json': [fx.modbusInstance('A1', { title: 'Дубль' })] },
    });
    const model = loadModel({ dir });
    expect(model.instances.map((i) => i.id)).toEqual(['A2']);
    expect(model.disabled.map((d) => d.id)).toEqual(['A1', 'A1']);
    expect(messages(model)).toMatch(/определена 2 раза \(list.json, more.json\)/);
  });

  test('enabled: false — установка отключена без ошибки', () => {
    const model = loadModel({ dir: make([fx.modbusInstance('A1', { enabled: false })]) });
    expect(model.issues).toEqual([]);
    expect(model.disabled).toEqual([{ id: 'A1', reason: expect.stringMatching(/выключена/) }]);
  });

  test('файл экземпляров может содержать один объект', () => {
    const model = loadModel({ dir: make(fx.modbusInstance('A1')) });
    expect(model.instances).toHaveLength(1);
  });

  test('битый JSON в файле — ошибка этого файла, остальное загружается', () => {
    const model = loadModel({ dir: make([fx.modbusInstance('A1')], { extraFiles: { 'instances/bad.json': '[{' } }) });
    expect(model.instances).toHaveLength(1);
    expect(model.issues).toEqual([{ file: expect.stringMatching(/bad.json$/), message: expect.stringMatching(/ошибка JSON/) }]);
  });

  test('ошибка в шаблоне — шаблон не загружен, его установки отключены', () => {
    const tpl = fx.smallTemplate({ Bad: { title: 'x', dataType: 'Real' } });
    const model = loadModel({ dir: make([fx.modbusInstance('A1')], { template: tpl }) });
    expect(model.templates.size).toBe(0);
    expect(messages(model)).toMatch(/Small.json.*|params.Bad.dataType: допустимо/);
    expect(messages(model)).toMatch(/шаблон Small не найден или содержит ошибки/);
  });

  test('методы шаблона: у установки — только для её параметров', () => {
    const tpl = { ...fx.smallTemplate(), methods: { Start: { title: 'Пуск', param: 'Cmd', value: true } } };
    const model = loadModel({ dir: make([fx.modbusInstance('A1'), fx.modbusInstance('A2', { exclude: ['Cmd'] })], { template: tpl }) });
    expect(model.issues).toEqual([]);
    expect(model.instances[0].methods).toEqual([{ name: 'Start', title: 'Пуск', tagId: 'T1/A1/Cmd', value: true }]);
    expect(model.instances[1].methods).toEqual([]);
    const example = loadModel({ dir: fx.EXAMPLE_DIR });
    expect(example.instances[2].methods.map((m) => m.name)).toEqual(['Start', 'Stop']);
  });

  test.each([
    [{ X: { title: 'x', param: 'Nope', value: true } }, /метод X: нет параметра Nope/],
    [{ X: { title: 'x', param: 'Run', value: true } }, /метод X: параметр Run только для чтения/],
    [{ X: { title: 'x', param: 'Cmd', value: 1 } }, /метод X: значение 1 не подходит к типу Boolean/],
    [{ X: { title: 'x', param: 'Sp', value: true } }, /метод X: значение true не подходит к типу Float/],
    [{ Temp: { title: 'x', param: 'Cmd', value: true } }, /метод Temp: совпадает с именем параметра/],
  ])('ошибка метода %o', (methods, re) => {
    const model = loadModel({ dir: make([fx.modbusInstance('A1')], { template: { ...fx.smallTemplate(), methods } }) });
    expect(model.templates.size).toBe(0);
    expect(messages(model)).toMatch(re);
  });

  test('проверки параметра: min > max, тревога по пределу у Boolean, states у Boolean', () => {
    const tpl = fx.smallTemplate({
      A: { title: 'a', dataType: 'Float', min: 5, max: 1 },
      B: { title: 'b', dataType: 'Boolean', alarms: [{ type: 'hi', limit: 1, priority: 100 }] },
      C: { title: 'c', dataType: 'Boolean', states: { 0: 'нет' } },
    });
    const model = loadModel({ dir: make([], { template: tpl }) });
    const text = model.issues.map((i) => i.message).join('\n');
    expect(text).toMatch(/A: min больше max/);
    expect(text).toMatch(/B: тревога hi только для числовых/);
    expect(text).toMatch(/C: states только для числовых/);
  });

  test('схема тревоги: limit обязателен для hi, запрещён для state', () => {
    const tpl = fx.smallTemplate({
      A: { title: 'a', dataType: 'Float', alarms: [{ type: 'hi', priority: 100 }] },
      B: { title: 'b', dataType: 'Boolean', alarms: [{ type: 'state', value: true, limit: 1, priority: 100 }] },
    });
    const text = messages(loadModel({ dir: make([], { template: tpl }) }));
    expect(text).toMatch(/params.A.alarms\[0\].limit: обязательное поле/);
    expect(text).toMatch(/params.B.alarms\[0\].limit: поле не допускается/);
  });

  test('карта: неизвестный параметр, несовместимая точка, чужой шаблон', () => {
    const map = fx.smallModbusMap({ Nope: { area: 'coil', address: 1 }, Temp: { area: 'coil', address: 2 } });
    const model = loadModel({ dir: make([fx.modbusInstance('A1')], { map }) });
    const text = messages(model);
    expect(text).toMatch(/Nope: нет такого параметра/);
    expect(text).toMatch(/Temp: Float нельзя привязать к дискретной точке/);
    expect(text).toMatch(/A1: карта small-mb не найдена/);
  });

  test('карта другого драйвера или шаблона — установка отключена', () => {
    const other = { ...fx.smallTemplate(), id: 'Other' };
    const dir = make([
      fx.modbusInstance('A1', { source: { driver: 'modbus', map: 'small-bn', host: '127.0.0.1' } }),
      fx.modbusInstance('A2', { template: 'Other' }),
    ], {
      extraFiles: {
        'templates/Other.json': other,
        'maps/small-bn.json': { id: 'small-bn', driver: 'bacnet', template: 'Small', points: {} },
      },
    });
    const text = messages(loadModel({ dir }));
    expect(text).toMatch(/A1: карта small-bn для драйвера bacnet, а экземпляр — modbus/);
    expect(text).toMatch(/A2: карта small-mb для шаблона Small, а экземпляр — Other/);
  });

  test('exclude, переопределение точки и параметра', () => {
    const model = loadModel({
      dir: make([fx.modbusInstance('A1', {
        exclude: ['Run'],
        source: {
          driver: 'modbus',
          map: 'small-mb',
          host: '127.0.0.1',
          byteOrder: 'CDAB',
          points: { Temp: { area: 'input', address: 5, type: 'int16', scale: 0.1 } },
        },
        params: { Sp: { min: 15, archive: { mode: 'interval', periodMs: 60000 } }, Temp: { title: 'Приток' } },
      })]),
    });
    expect(model.issues).toEqual([]);
    expect(model.tags.has('T1/A1/Run')).toBe(false);
    const temp = model.tags.get('T1/A1/Temp');
    expect(temp.title).toBe('Приток');
    expect(temp.source.point).toEqual({ area: 'input', address: 5, type: 'int16', scale: 0.1, offset: 0 });
    expect(temp.source.byteOrder).toBe('CDAB');
    const sp = model.tags.get('T1/A1/Sp');
    expect(sp).toMatchObject({ min: 15, max: 30, archive: { mode: 'interval', periodMs: 60000, deadband: 0 } });
  });

  test('ошибки экземпляра: неизвестные имена, точка исключённого параметра, нет привязки', () => {
    const map = fx.smallModbusMap();
    delete map.points.Sp;
    const model = loadModel({
      dir: make([fx.modbusInstance('A1', {
        exclude: ['Ghost', 'Run'],
        params: { Nope: { min: 1 } },
        source: { driver: 'modbus', map: 'small-mb', host: '127.0.0.1', points: { Run: { area: 'discrete', address: 1 } } },
      })], { map }),
    });
    const text = messages(model);
    expect(text).toMatch(/Ghost: нет такого параметра/);
    expect(text).toMatch(/Nope: нет такого параметра/);
    expect(text).toMatch(/Run: параметр исключён \(exclude\), но привязан/);
  });

  test('нет привязки параметра — подсказка про exclude', () => {
    const map = fx.smallModbusMap();
    delete map.points.Sp;
    const text = messages(loadModel({ dir: make([fx.modbusInstance('A1')], { map }) }));
    expect(text).toMatch(/Sp: нет привязки к контроллеру \(добавьте точку или exclude\)/);
  });

  test('переопределение параметра проверяется: min > max после слияния', () => {
    const text = messages(loadModel({ dir: make([fx.modbusInstance('A1', { params: { Sp: { min: 40 } } })]) }));
    expect(text).toMatch(/Sp: min больше max/);
  });

  test('BACnet без карты: точки экземпляра, адрес необязателен, запись в Input запрещена', () => {
    const ok = {
      id: 'N1', title: 'N30', template: 'Small',
      source: { driver: 'bacnet', device: 30001, points: fx.bacnetPoints() },
    };
    const badPoints = { ...fx.bacnetPoints(), Cmd: { objectType: 'binaryInput', instance: 2 }, Temp: { objectType: 'binaryInput', instance: 3 } };
    const bad = { ...ok, id: 'N2', source: { ...ok.source, points: badPoints } };
    const model = loadModel({ dir: make([ok, bad]) });
    expect(model.instances.map((i) => i.id)).toEqual(['N1']);
    expect(model.tags.get('T1/N1/Temp').source).toEqual({
      driver: 'bacnet',
      connection: { device: 30001, address: null },
      byteOrder: undefined,
      point: { objectType: 'analogInput', instance: 1, scale: 1, offset: 0 },
    });
    const text = messages(model);
    expect(text).toMatch(/Cmd: запись невозможна: binaryInput только для чтения/);
    expect(text).toMatch(/Temp: Float нельзя привязать к binaryInput/);
  });

  test('BACnet: приоритет записи 1–7 запрещён', () => {
    const points = { ...fx.bacnetPoints(), Sp: { objectType: 'analogValue', instance: 1, priority: 5 } };
    const inst = { id: 'N1', title: 'N30', template: 'Small', source: { driver: 'bacnet', device: 1, points } };
    expect(messages(loadModel({ dir: make([inst]) }))).toMatch(/points.Sp.priority: не меньше 8/);
  });

  test('Modbus: запись в input/discrete запрещена', () => {
    const map = fx.smallModbusMap({ Cmd: { area: 'discrete', address: 3 }, Sp: { area: 'input', address: 12, type: 'float32' } });
    const text = messages(loadModel({ dir: make([], { map }) }));
    expect(text).toMatch(/Cmd: запись невозможна: область discrete только для чтения/);
    expect(text).toMatch(/Sp: запись невозможна: область input только для чтения/);
  });

  test('целочисленный параметр с дробным масштабом — ошибка привязки', () => {
    const tpl = fx.smallTemplate({ Hours: { title: 'Наработка', dataType: 'UInt32' } });
    const map = fx.smallModbusMap({ Hours: { area: 'holding', address: 20, type: 'uint32', scale: 0.1 } });
    const text = messages(loadModel({ dir: make([], { template: tpl, map }) }));
    expect(text).toMatch(/Hours: UInt32 с дробным scale или offset даёт дробные значения — используйте Float/);
  });

  test('reportModel: сводка в info, каждая ошибка в error', () => {
    const logger = createFakeLogger();
    const model = loadModel({ dir: make([fx.modbusInstance('A1'), fx.modbusInstance('A1')]) });
    reportModel(model, logger);
    expect(logger.lines.info[0]).toMatch(/объект T1: шаблонов 1, карт 1, установок 0, отключено 2, тегов 0/);
    expect(logger.lines.error).toHaveLength(2);
    expect(logger.lines.error[0]).toMatch(/list.json, A1: установка определена 2 раза/);
  });
});

describe('modelLoader.normalizeModbusPoint', () => {
  test.each([
    [{ area: 'coil', address: 1 }, { type: 'bool' }],
    [{ area: 'discrete', address: 1, type: 'bool' }, { type: 'bool' }],
    [{ area: 'holding', address: 1 }, { type: 'uint16' }],
    [{ area: 'holding', address: 1, bit: 15 }, { type: 'bool', bit: 15 }],
    [{ area: 'input', address: 65534, type: 'float32' }, { type: 'float32' }],
  ])('%j → %j', (p, expected) => {
    expect(normalizeModbusPoint(p).point).toMatchObject(expected);
  });

  test.each([
    [{ area: 'coil', address: 1, bit: 2 }, /бит задаётся только для регистров/],
    [{ area: 'coil', address: 1, type: 'int16' }, /допустим только тип bool/],
    [{ area: 'holding', address: 1, bit: 2, type: 'int16' }, /тип не задаётся/],
    [{ area: 'holding', address: 1, type: 'bool' }, /через bit/],
    [{ area: 'holding', address: 65535, type: 'uint32' }, /адрес не больше 65534/],
  ])('%j — ошибка', (p, re) => {
    expect(normalizeModbusPoint(p).error).toMatch(re);
  });
});
