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
const net = require('net');
const { OPCUAClient, UserTokenType, AttributeIds, DataType, StatusCodes } = require('node-opcua');
const { Client: PgClient } = require('pg');
const { Readable } = require('stream');
const { main: userAdmin } = require('../../tools/userAdmin');

async function freeTcpPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

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
      OPCUA_ENABLED: 'false',
    });
    await waitFor(out, /сервер запущен/);
    expect(out.stdout).toMatch(/версия \S+/);
    expect(out.stdout).toMatch(/conf.env не найден/);
    expect(out.stdout).toMatch(/объект B1: шаблонов 1, карт 2, установок 3, отключено 0, тегов 58/);
    expect(out.stdout).toMatch(/Modbus TCP выключен \(MODBUS_ENABLED=false\), тегов без опроса: 39/);
    expect(out.stdout).toMatch(/BACnet выключен \(BACNET_ENABLED=false\), тегов без опроса: 19/);
    expect(out.stdout).toMatch(/OPC UA выключен \(OPCUA_ENABLED=false\)/);
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
    const { child, out, exited } = run({ CONF_ENV_FILE: path.join(dir, 'conf.env'), LOG_LEVEL: 'info', CONFIG_DIR: cfg, MODBUS_ENABLED: 'false', BACNET_ENABLED: 'false', OPCUA_ENABLED: 'false' });
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
      const { child, out, exited } = run({ CONF_ENV_FILE: path.join(dir, 'conf.env'), LOG_LEVEL: 'dev', CONFIG_DIR: cfg, OPCUA_ENABLED: 'false' });
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
        OPCUA_ENABLED: 'false',
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
        OPCUA_ENABLED: 'false',
        BACNET_PORT: String(sock.address().port),
        BACNET_INTERFACE: '127.0.0.1',
      });
      expect(await exited).toBe(1);
      expect(out.stderr).toMatch(/ошибка запуска bacnet: порт UDP \d+ занят/);
    } finally {
      sock.close();
    }
  });

  test('живые данные контроллера ОВЕН (эмулятор) видны клиенту OPC UA', async () => {
    const cfg = path.join(dir, 'config');
    fs.cpSync(EXAMPLE, cfg, { recursive: true });
    const model = loadModel({ dir: EXAMPLE });
    const emu = await startEmulators({ model, mapId: 'owen-ahu-v1', count: 1, basePort: 0 });
    const opcPort = await freeTcpPort();
    const client = OPCUAClient.create({ endpointMustExist: false, connectionStrategy: { maxRetry: 0 } });
    try {
      fs.writeFileSync(path.join(cfg, 'instances/floor1.json'), JSON.stringify(emu.instances));
      const { child, out, exited } = run({
        CONF_ENV_FILE: path.join(dir, 'conf.env'),
        LOG_LEVEL: 'dev',
        CONFIG_DIR: cfg,
        BACNET_ENABLED: 'false',
        OPCUA_PORT: String(opcPort),
        OPCUA_INTERFACE: '127.0.0.1',
        OPCUA_HOSTNAME: 'localhost',
        OPCUA_ALLOW_INSECURE: 'true',
        PKI_DIR: path.join(dir, 'pki'),
      });
      await waitFor(out, /сервер запущен/, 20000);
      expect(out.stdout).toMatch(new RegExp(`\\[OpcUa\\] - start - opc\\.tcp://localhost:${opcPort}; .*установок 1, переменных 20`));
      expect(out.stderr).toMatch(/ВНИМАНИЕ: OPCUA_ALLOW_INSECURE=true/);

      await client.connect(`opc.tcp://localhost:${opcPort}`);
      const session = await client.createSession();
      const ns = (await session.readNamespaceArray()).indexOf('urn:scada-bms:model');
      const id = `ns=${ns};s=B1/${emu.instances[0].id}/SupplyTemp`;
      let dv;
      for (let t = Date.now(); Date.now() - t < 5000; await new Promise((r) => setTimeout(r, 100))) {
        dv = await session.read({ nodeId: id });
        if (dv.statusCode.name === 'Good') break;
      }
      expect(dv.statusCode.name).toBe('Good');
      expect(typeof dv.value.value).toBe('number');
      await session.close();
      await client.disconnect();

      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      // OPC UA закрывается раньше драйверов
      expect(out.stdout).toMatch(/остановлен opcua[\s\S]*остановлен modbus/);
    } finally {
      await client.disconnect();
      await emu.stop();
    }
  });

  (process.env.TEST_PG_URL ? test : test.skip)('с PostgreSQL: вход по паролю, запись уставки в ОВЕН, журнал, отзыв сессии (TEST_PG_URL)', async () => {
    const schema = `scada_srv_${process.pid}_${Date.now()}`;
    const admin = new PgClient({ connectionString: process.env.TEST_PG_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const u = new URL(process.env.TEST_PG_URL);
    u.searchParams.set('options', `-c search_path=${schema}`);
    const pgUrl = u.toString();
    const cfg = path.join(dir, 'config');
    fs.cpSync(EXAMPLE, cfg, { recursive: true });
    const model = loadModel({ dir: EXAMPLE });
    const emu = await startEmulators({ model, mapId: 'owen-ahu-v1', count: 1, basePort: 0 });
    const opcPort = await freeTcpPort();
    const client = OPCUAClient.create({ endpointMustExist: false, connectionStrategy: { maxRetry: 0 } });
    const env = { CONF_ENV_FILE: path.join(dir, 'conf.env'), PG_URL: pgUrl, BCRYPT_ROUNDS: '10' };
    const quiet = () => {};
    let proc = null;
    try {
      expect(await userAdmin(['n', 't', 'add', 'eng', '--role', 'engineer'], quiet, { env, io: { input: Readable.from(['eng-pass-1\n']) } })).toBe(0);
      fs.writeFileSync(path.join(cfg, 'instances/floor1.json'), JSON.stringify(emu.instances));
      const { child, out, exited } = run({
        ...env,
        LOG_LEVEL: 'info',
        CONFIG_DIR: cfg,
        BACNET_ENABLED: 'false',
        OPCUA_PORT: String(opcPort),
        OPCUA_INTERFACE: '127.0.0.1',
        OPCUA_HOSTNAME: 'localhost',
        OPCUA_ALLOW_INSECURE: 'true',
        PKI_DIR: path.join(dir, 'pki'),
      });
      proc = child;
      await waitFor(out, /сервер запущен/, 20000);
      expect(out.stdout).toMatch(/\[Db\] - start - PostgreSQL .*миграций применено: 0/);
      expect(out.stdout).toMatch(/переменных 20 \(запись 3\), методов 2/);

      await client.connect(`opc.tcp://localhost:${opcPort}`);
      const session = await client.createSession({ type: UserTokenType.UserName, userName: 'eng', password: 'eng-pass-1' });
      const ns = (await session.readNamespaceArray()).indexOf('urn:scada-bms:model');
      const id = `B1/${emu.instances[0].id}/SupplyTempSp`;
      const status = await session.write({ nodeId: `ns=${ns};s=${id}`, attributeId: AttributeIds.Value, value: { value: { dataType: DataType.Float, value: 23.5 } } });
      expect(status).toBe(StatusCodes.Good);
      expect(emu.slaves[0].writes.some((w) => w.address === 102 || w.address === 103)).toBe(true);
      expect((await session.read({ nodeId: `ns=${ns};s=${id}` })).value.value).toBe(23.5);
      await waitFor(out, /\[Journal\] - write - eng@opcua\/\S+ B1\/EMU-01\/SupplyTempSp: \S+ → 23.5, выполнено/);
      const { rows } = await admin.query(`SELECT username, tag_id, new_value, ok FROM ${schema}.journal WHERE action = 'write'`);
      expect(rows).toEqual([{ username: 'eng', tag_id: id, new_value: 23.5, ok: true }]);

      // Роль меняет другой процесс (userAdmin): NOTIFY → сервер закрывает сессию eng
      expect(await userAdmin(['n', 't', 'role', 'eng', 'viewer'], quiet, { env })).toBe(0);
      await waitFor(out, /закрыта сессия eng: учётная запись изменена/);
      const after = await session.write({ nodeId: `ns=${ns};s=${id}`, attributeId: AttributeIds.Value, value: { value: { dataType: DataType.Float, value: 24 } } })
        .catch(() => StatusCodes.BadSessionClosed);
      expect(after).not.toBe(StatusCodes.Good);
      await client.disconnect();

      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(out.stdout).toMatch(/сервер остановлен/);
    } finally {
      // Упавший тест не должен оставить работающий server.js
      if (proc && proc.exitCode === null) proc.kill('SIGKILL');
      await client.disconnect();
      await emu.stop();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  test('PostgreSQL недоступен при запуске — выход с кодом 1 без пароля в сообщении', async () => {
    const port = await freeTcpPort(); // никто не слушает
    const { out, exited } = run({
      CONF_ENV_FILE: path.join(dir, 'conf.env'),
      CONFIG_DIR: EXAMPLE,
      MODBUS_ENABLED: 'false',
      BACNET_ENABLED: 'false',
      OPCUA_ENABLED: 'false',
      PG_URL: `postgresql://scada@127.0.0.1:${port}/scada`,
      PGPASSWORD: 'top-secret-pw',
    });
    expect(await exited).toBe(1);
    expect(out.stderr).toMatch(new RegExp(`ошибка запуска db: нет подключения к PostgreSQL 127\\.0\\.0\\.1:${port}/scada`));
    expect(out.stdout + out.stderr).not.toMatch(/top-secret-pw/);
  });

  test('сообщает, какие переменные окружения перекрывают conf.env', async () => {
    const file = path.join(dir, 'conf.env');
    fs.writeFileSync(file, 'LOG_LEVEL=error\nSHUTDOWN_TIMEOUT_MS=3000\n');
    const { child, out, exited } = run({ CONF_ENV_FILE: file, LOG_LEVEL: 'info', CONFIG_DIR: EXAMPLE, MODBUS_ENABLED: 'false', BACNET_ENABLED: 'false', OPCUA_ENABLED: 'false' });
    await waitFor(out, /сервер запущен/);
    expect(out.stdout).toMatch(/окружение перекрывает conf.env: LOG_LEVEL$/m);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  });
});
