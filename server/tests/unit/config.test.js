'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, ROOT } = require('../../services/config');

describe('config.loadConfig', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scada-config-'));
    file = path.join(dir, 'conf.env');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('без файла и окружения — значения по умолчанию', () => {
    const { config, overrides, envFile } = loadConfig({ env: { CONF_ENV_FILE: file } });
    expect(envFile).toBeNull();
    expect(overrides).toEqual([]);
    expect(config).toEqual({
      logLevel: 'info',
      dataDir: path.join(ROOT, 'data'),
      configDir: path.join(ROOT, 'data/config'),
      shutdownTimeoutMs: 10000,
      reconnectMaxMs: 30000,
      modbusEnabled: true,
      modbusPollMs: 1000,
      modbusTimeoutMs: 1000,
      modbusConnectTimeoutMs: 3000,
      modbusFailLimit: 3,
      modbusMaxGap: 4,
      bacnetEnabled: true,
      bacnetPort: 47808,
      bacnetInterface: '0.0.0.0',
      bacnetBroadcastAddress: '255.255.255.255',
      bacnetApduTimeoutMs: 3000,
      bacnetPollMs: 2000,
      bacnetFailLimit: 3,
      bacnetCov: true,
      bacnetCovLifetimeS: 300,
      bacnetWritePriority: 8,
      bacnetMaxObjects: 20,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('значения из файла', () => {
    fs.writeFileSync(file, 'LOG_LEVEL=dev\nDATA_DIR=/var/lib/scada\nSHUTDOWN_TIMEOUT_MS=5000\n');
    const { config, envFile } = loadConfig({ env: { CONF_ENV_FILE: file } });
    expect(envFile).toBe(file);
    expect(config.logLevel).toBe('dev');
    expect(config.dataDir).toBe('/var/lib/scada');
    expect(config.shutdownTimeoutMs).toBe(5000);
  });

  test('окружение перекрывает файл, имя попадает в overrides', () => {
    fs.writeFileSync(file, 'LOG_LEVEL=dev\nSHUTDOWN_TIMEOUT_MS=5000\n');
    const { config, overrides } = loadConfig({
      env: { CONF_ENV_FILE: file, LOG_LEVEL: 'error', SHUTDOWN_TIMEOUT_MS: '5000' },
    });
    expect(config.logLevel).toBe('error');
    // Одинаковое значение — не перекрытие
    expect(overrides).toEqual(['LOG_LEVEL']);
  });

  test('пустое значение работает как отсутствующее', () => {
    fs.writeFileSync(file, 'LOG_LEVEL=\n');
    const { config } = loadConfig({ env: { CONF_ENV_FILE: file, SHUTDOWN_TIMEOUT_MS: '' } });
    expect(config.logLevel).toBe('info');
    expect(config.shutdownTimeoutMs).toBe(10000);
  });

  test('относительный DATA_DIR считается от каталога сервера', () => {
    const { config } = loadConfig({ env: { CONF_ENV_FILE: file, DATA_DIR: 'var/data' } });
    expect(config.dataDir).toBe(path.join(ROOT, 'var/data'));
  });

  test('недопустимые значения — одна ошибка со всеми параметрами', () => {
    expect(() => loadConfig({
      env: { CONF_ENV_FILE: file, LOG_LEVEL: 'verbose', SHUTDOWN_TIMEOUT_MS: '10s' },
    })).toThrow(/LOG_LEVEL.*verbose.*SHUTDOWN_TIMEOUT_MS.*10s/);
  });

  test('логический параметр: true | false', () => {
    expect(loadConfig({ env: { CONF_ENV_FILE: file, MODBUS_ENABLED: 'FALSE' } }).config.modbusEnabled).toBe(false);
    expect(() => loadConfig({ env: { CONF_ENV_FILE: file, MODBUS_ENABLED: 'yes' } }))
      .toThrow(/MODBUS_ENABLED: допустимо true \| false, получено "yes"/);
  });

  test('число вне диапазона — ошибка', () => {
    expect(() => loadConfig({ env: { CONF_ENV_FILE: file, SHUTDOWN_TIMEOUT_MS: '500' } }))
      .toThrow(/SHUTDOWN_TIMEOUT_MS: допустимо от 1000 до 120000/);
  });

  test('адреса BACnet: IPv4 и IPv4:порт', () => {
    const load = (env) => loadConfig({ env: { CONF_ENV_FILE: file, ...env } }).config;
    expect(load({ BACNET_BROADCAST_ADDRESS: '10.10.0.255:47808' }).bacnetBroadcastAddress).toBe('10.10.0.255:47808');
    expect(load({ BACNET_INTERFACE: '10.10.0.5' }).bacnetInterface).toBe('10.10.0.5');
    expect(() => load({ BACNET_INTERFACE: 'eth0' })).toThrow(/BACNET_INTERFACE: ожидается адрес IPv4/);
    expect(() => load({ BACNET_BROADCAST_ADDRESS: '10.10.0.255:0' })).toThrow(/BACNET_BROADCAST_ADDRESS: ожидается адрес IPv4\[:порт\]/);
    expect(() => load({ BACNET_BROADCAST_ADDRESS: '300.1.1.1' })).toThrow(/BACNET_BROADCAST_ADDRESS/);
  });

  test('приоритет записи BACnet 1–7 недопустим', () => {
    expect(() => loadConfig({ env: { CONF_ENV_FILE: file, BACNET_WRITE_PRIORITY: '7' } }))
      .toThrow(/BACNET_WRITE_PRIORITY: допустимо от 8 до 16/);
  });

  test('без CONF_ENV_FILE читается conf.env рядом с server.js', () => {
    const { envFile } = loadConfig({ env: {} });
    const expected = fs.existsSync(path.join(ROOT, 'conf.env')) ? path.join(ROOT, 'conf.env') : null;
    expect(envFile).toBe(expected);
  });
});
