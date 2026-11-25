// Запуск настоящего процесса server.js: старт, остановка по сигналу, код выхода.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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
    });
    await waitFor(out, /сервер запущен/);
    expect(out.stdout).toMatch(/версия \S+/);
    expect(out.stdout).toMatch(/conf.env не найден/);
    expect(out.stdout).toMatch(/объект B1: шаблонов 1, карт 2, установок 3, отключено 0, тегов 58/);
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
    const { child, out, exited } = run({ CONF_ENV_FILE: path.join(dir, 'conf.env'), LOG_LEVEL: 'info', CONFIG_DIR: cfg });
    await waitFor(out, /сервер запущен/);
    expect(out.stdout).toMatch(/установок 3, отключено 1, тегов 58/);
    expect(out.stderr).toMatch(/zz.json, BAD: шаблон Nope не найден/);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  });

  test('сообщает, какие переменные окружения перекрывают conf.env', async () => {
    const file = path.join(dir, 'conf.env');
    fs.writeFileSync(file, 'LOG_LEVEL=error\nSHUTDOWN_TIMEOUT_MS=3000\n');
    const { child, out, exited } = run({ CONF_ENV_FILE: file, LOG_LEVEL: 'info', CONFIG_DIR: EXAMPLE });
    await waitFor(out, /сервер запущен/);
    expect(out.stdout).toMatch(/окружение перекрывает conf.env: LOG_LEVEL$/m);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  });
});
