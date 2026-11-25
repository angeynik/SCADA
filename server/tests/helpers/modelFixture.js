// tests/helpers/modelFixture.js
// Временный каталог конфигурации объекта для тестов загрузчика модели.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const EXAMPLE_DIR = path.resolve(__dirname, '../../config/example');

// Минимальный шаблон: по одному параметру основных видов
function smallTemplate(extra = {}) {
  return {
    id: 'Small',
    title: 'Тестовая установка',
    params: {
      Run: { title: 'Работа', dataType: 'Boolean' },
      Cmd: { title: 'Команда', dataType: 'Boolean', access: 'rw', writeLevel: 2 },
      Temp: { title: 'Температура', dataType: 'Float', unit: '°C', deadband: 0.1 },
      Sp: { title: 'Уставка', dataType: 'Float', access: 'rw', min: 10, max: 30 },
      ...extra,
    },
  };
}

const smallModbusMap = (extra = {}) => ({
  id: 'small-mb',
  driver: 'modbus',
  template: 'Small',
  points: {
    Run: { area: 'discrete', address: 0 },
    Cmd: { area: 'coil', address: 0 },
    Temp: { area: 'holding', address: 10, type: 'float32' },
    Sp: { area: 'holding', address: 12, type: 'float32' },
    ...extra,
  },
});

const modbusInstance = (id, extra = {}) => ({
  id,
  title: `Установка ${id}`,
  template: 'Small',
  source: { driver: 'modbus', map: 'small-mb', host: '127.0.0.1' },
  ...extra,
});

const bacnetPoints = () => ({
  Run: { objectType: 'binaryInput', instance: 1 },
  Cmd: { objectType: 'binaryOutput', instance: 1 },
  Temp: { objectType: 'analogInput', instance: 1 },
  Sp: { objectType: 'analogValue', instance: 1 },
});

// files: { 'site.json': {...}, 'templates/a.json': {...}, ... } — объект пишется как JSON,
// строка — как есть (для проверки битых файлов)
function createConfigDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scada-model-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

// Типовой набор: объект T1, шаблон Small, карта small-mb и переданные экземпляры
function smallConfig(instances, { template = smallTemplate(), map = smallModbusMap(), extraFiles = {} } = {}) {
  return createConfigDir({
    'site.json': { id: 'T1', title: 'Тест' },
    'templates/Small.json': template,
    'maps/small-mb.json': map,
    'instances/list.json': instances,
    ...extraFiles,
  });
}

const removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });

module.exports = {
  EXAMPLE_DIR,
  smallTemplate,
  smallModbusMap,
  modbusInstance,
  bacnetPoints,
  createConfigDir,
  smallConfig,
  removeDir,
};
