// Запуск настоящего процесса server.js: старт, остановка по сигналу, код выхода.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { loadModel } = require('../../core/modelLoader');
const { startEmulators } = require('../../tools/modbusEmulator');
const { startBacnetEmulators } = require('../../tools/bacnetEmulator');
const { freeUdpPort } = require('../../tools/lib/bacnetDevice');

const SERVER = path.resolve(__dirname, '../../server.js');
const EXAMPLE = path.resolve(__dirname, '../../config/example');

function run(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, out, exited };
}

async function waitFor(out, re, ms = 10000) {
  const until = Date.now() + ms;
  while (!re.test(out.stdout)) {
    if (Date.now() > until) throw new Error(`не дождались ${re}: ${out.stdout}${out.stderr}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('server.js', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scada-server-'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test.each(['SIGTERM', 'SIGINT'])('запускается и останавливается по %s с кодом 0', async (signal) => {
    const { child, out, exited } = run({
      CONF_ENV_FILE: path.join(dir, 'conf.env'),
      LOG_LEVEL: 'info',
      DATA_DIR: dir,
      CONFIG_DIR: EXAMPLE,
      // В примере адреса контроллеров 10.10.x.x недоступны
      MODBUS_ENABLED: 'false',
      BACNET_ENABLED: 'false',
    });
    await waitFor(out, /сервер запущен/);
    expect(out.stdout).toMatch(/версия \S+/);
    expect(out.stdout).toMatch(/conf.env не найден/);
    expect(out.stdout).toMatch(/объект B1: шаблонов 1, карт 2, установок 3, отключено 0, тегов 58/);
    expect(out.stdout).toMatch(/Modbus TCP выключен \(MODBUS_ENABLED=false\), тегов без опроса: 39/);
    expect(out.stdout).toMatch(/BACnet выключен \(BACNET_ENABLED=false\), тегов без опроса: 19/);
    child.kill(signal);
    expect(await exited).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`остановка сервера \\(${signal}\\)`));
    expect(out.stdout).toMatch(/сервер остановлен/);
    expect(out.stderr).toBe('');
  });

  test('ошибка настроек — выход с кодом 1 и понятным сообщением', async () => {
    const { out, exited } = run({
      CONF_ENV_FILE: path.join(dir, 'conf.env'),
      SHUTDOWN_TIMEOUT_MS: 'abc',
    });
    expect(await exited).toBe(1);
    expect(out.stderr).toMatch(/SHUTDOWN_TIMEOUT_MS: ожидается целое число/);
  });

  test('нет конфигурации объекта — выход с кодом 1 и подсказкой', async () => {
    const { out, exited } = run({ CONF_ENV_FILE: path.join(dir, 'conf.env'), CONFIG_DIR: path.join(dir, 'nope') });
    expect(await exited).toBe(1);
    expect(out.stderr).toMatch(/модель не загружена: каталог конфигурации .*nope не найден \(образец — config\/example/);
  });

  test('ошибочная установка отключается, сервер работает', async () => {
    const cfg = path.join(dir, 'config');
    fs.cpSync(EXAMPLE, cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, 'instances/zz.json'), JSON.stringify([{ id: 'BAD', title: 'x', template: 'Nope', source: { driver: 'modbus', map: 'owen-ahu-v1', host: '127.0.0.1' } }]));
    const { child, out, exited } = run({ CONF_ENV_FILE: path.join(dir, 'conf.env'), LOG_LEVEL: 'info', CONFIG_DIR: cfg, MODBUS_ENABLED: 'false', BACNET_ENABLED: 'false' });
    await waitFor(out, /сервер запущен/);
    expect(out.stdout).toMatch(/установок 3, отключено 1, тегов 58/);
    expect(out.stderr).toMatch(/zz.json, BAD: шаблон Nope не найден/);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  });

  test('опрашивает контроллеры Modbus (эмулятор) и останавливается по SIGTERM', async () => {
    const cfg = path.join(dir, 'config');
    fs.cpSync(EXAMPLE, cfg, { recursive: true });
    const model = loadModel({ dir: EXAMPLE });
    const emu = await startEmulators({ model, mapId: 'owen-ahu-v1', count: 2, basePort: 0 });
    try {
      fs.writeFileSync(path.join(cfg, 'instances/floor1.json'), JSON.stringify(emu.instances));
      const { child, out, exited } = run({ CONF_ENV_FILE: path.join(dir, 'conf.env'), LOG_LEVEL: 'dev', CONFIG_DIR: cfg });
      await waitFor(out, /127\.0\.0\.1:\d+ - на связи[\s\S]*127\.0\.0\.1:\d+ - на связи/);
      expect(out.stdout).toMatch(/\[ModbusTCP\] - start - контроллеров 2, тегов 40/);
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(out.stdout).toMatch(/остановлен modbus/);
      expect(out.stderr).toBe('');
    } finally {
      await emu.stop();
    }
  });

  test('опрашивает устройства BACnet (эмулятор N30) и снимает подписки при остановке', async () => {
    const cfg = path.join(dir, 'config');
    fs.cpSync(EXAMPLE, cfg, { recursive: true });
    const model = loadModel({ dir: EXAMPLE });
    const emu = await startBacnetEmulators({ model, templateId: 'AhuType', count: 2 });
    try {
      fs.writeFileSync(path.join(cfg, 'instances/floor1.json'), JSON.stringify(emu.instances));
      const { child, out, exited } = run({
        CONF_ENV_FILE: path.join(dir, 'conf.env'),
        LOG_LEVEL: 'dev',
        CONFIG_DIR: cfg,
        BACNET_PORT: String(await freeUdpPort()),
        BACNET_INTERFACE: '127.0.0.1',
        BACNET_POLL_MS: '200',
      });
      await waitFor(out, /device 40001 - на связи[\s\S]*device 40002 - на связи|device 40002 - на связи[\s\S]*device 40001 - на связи/);
      expect(out.stdout).toMatch(/\[BACnet\] - start - устройств 2, тегов 40/);
      const subscribed = () => emu.devices.every((d) => d.subscriptions().length === 20);
      for (let t = Date.now(); !subscribed() && Date.now() - t < 5000;) await new Promise((r) => setTimeout(r, 50));
      expect(subscribed()).toBe(true);
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(out.stdout).toMatch(/остановлен bacnet/);
      expect(emu.devices.map((d) => d.subscriptions().length)).toEqual([0, 0]);
      expect(out.stderr).toBe('');
    } finally {
      await emu.stop();
    }
  });

  test('порт BACnet занят — выход с кодом 1 и понятной причиной', async () => {
    const dgram = require('dgram');
    const sock = dgram.createSocket('udp4');
    await new Promise((r) => sock.bind(0, '127.0.0.1', r));
    try {
      const { out, exited } = run({
        CONF_ENV_FILE: path.join(dir, 'conf.env'),
        CONFIG_DIR: EXAMPLE,
        MODBUS_ENABLED: 'false',
        BACNET_PORT: String(sock.address().port),
        BACNET_INTERFACE: '127.0.0.1',
      });
      expect(await exited).toBe(1);
      expect(out.stderr).toMatch(/ошибка запуска bacnet: порт UDP \d+ занят/);
    } finally {
      sock.close();
    }
  });

  test('сообщает, какие переменные окружения перекрывают conf.env', async () => {
    const file = path.join(dir, 'conf.env');
    fs.writeFileSync(file, 'LOG_LEVEL=error\nSHUTDOWN_TIMEOUT_MS=3000\n');
    const { child, out, exited } = run({ CONF_ENV_FILE: file, LOG_LEVEL: 'info', CONFIG_DIR: EXAMPLE, MODBUS_ENABLED: 'false', BACNET_ENABLED: 'false' });
    await waitFor(out, /сервер запущен/);
    expect(out.stdout).toMatch(/окружение перекрывает conf.env: LOG_LEVEL$/m);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  });
});
