// tools/pgEmulator: создание, запуск, адреса, exec с пересылкой сигнала, остановка, сброс.
// Свой каталог и порт, рабочий эмулятор разработчика не затрагивается. Если программ
// PostgreSQL на машине нет — тесты пропускаются.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { main, resolveBinDir, defaultDir, urls } = require('../../tools/pgEmulator');

let hasPg = true;
try {
  resolveBinDir();
} catch {
  hasPg = false;
}
const maybe = hasPg ? describe : describe.skip;
const TOOL = path.resolve(__dirname, '../../tools/pgEmulator.js');

describe('pgEmulator: адреса и каталоги', () => {
  test('каталог: под root — вне /root, иначе в DATA_DIR', () => {
    expect(defaultDir({ uid: 0, dataDir: '/root/x/data' })).toBe('/var/tmp/scada-pg-emu');
    expect(defaultDir({ uid: 1000, dataDir: '/home/dev/scada/data' })).toBe('/home/dev/scada/data/pg-emu');
  });

  test('адреса через сокет, без пароля, проходят проверку PG_URL', () => {
    const u = urls({ dir: '/var/tmp/e', port: 55432 });
    expect(u.pgUrl).toBe('postgresql:///scada?host=/var/tmp/e/sock&port=55432&user=scada');
    expect(u.testPgUrl).toBe('postgresql:///scada_test?host=/var/tmp/e/sock&port=55432&user=scada');
    const { loadConfig } = require('../../services/config');
    expect(loadConfig({ env: { CONF_ENV_FILE: '/nope', PG_URL: u.pgUrl } }).config.pgUrl).toBe(u.pgUrl);
  });

  test('программы PostgreSQL: PG_BIN, pg_config, /usr/lib/postgresql', () => {
    const exists = (p) => p.startsWith('/opt/pg/bin') || p.startsWith('/usr/lib/postgresql/17/bin');
    expect(resolveBinDir({ env: { PG_BIN: '/opt/pg/bin' }, exists })).toBe('/opt/pg/bin');
    expect(() => resolveBinDir({ env: { PG_BIN: '/nope' }, exists })).toThrow(/PG_BIN=\/nope: нет initdb и pg_ctl/);
    const noConfig = () => ({ status: 1 });
    expect(resolveBinDir({ env: {}, run: noConfig, readdir: () => ['16', '17', 'x'], exists })).toBe('/usr/lib/postgresql/17/bin');
    expect(() => resolveBinDir({ env: {}, run: noConfig, readdir: () => [], exists })).toThrow(/не найдены/);
  });

  test('неверные аргументы', async () => {
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main(['n', 't'], () => {})).toBe(2);
      expect(await main(['n', 't', 'start', '--port', '80'], () => {})).toBe(2);
    } finally {
      err.mockRestore();
    }
  });
});

maybe('pgEmulator: экземпляр PostgreSQL', () => {
  const base = process.getuid() === 0 ? '/var/tmp' : os.tmpdir();
  const dir = path.join(base, `scada-pg-emu-test-${process.pid}`);
  const port = 56000 + (process.pid % 1000);
  const args = ['--dir', dir, '--port', String(port)];
  const out = [];
  const write = (s) => out.push(s);

  afterAll(async () => {
    await main(['n', 't', 'reset', '--yes', ...args], () => {});
  });

  test('start создаёт роль и базы, повторный start ничего не ломает, status показывает адреса', async () => {
    expect(await main(['n', 't', 'start', ...args], write)).toBe(0);
    expect(out.join('')).toMatch(/Создаю экземпляр PostgreSQL/);
    expect(out.join('')).toMatch(/запущен \(PostgreSQL \d+\)/);
    out.length = 0;
    expect(await main(['n', 't', 'start', ...args], write)).toBe(0);
    expect(out.join('')).not.toMatch(/Создаю/);

    const { pgUrl, testPgUrl } = urls({ dir, port });
    expect(out.join('')).toContain(`PG_URL=${pgUrl}`);
    const c = new Client({ connectionString: pgUrl });
    await c.connect();
    const { rows } = await c.query("SELECT current_user AS u, rolsuper FROM pg_roles WHERE rolname = current_user");
    expect(rows[0]).toEqual({ u: 'scada', rolsuper: false });
    // Только сокет: TCP не открыт
    expect((await c.query('SHOW listen_addresses')).rows[0].listen_addresses).toBe('');
    await c.end();
    const t = new Client({ connectionString: testPgUrl });
    await t.connect();
    await t.end();
  });

  test('exec: адреса в окружении команды, код выхода команды, сигнал пересылается', async () => {
    const script = path.join(os.tmpdir(), `scada-exec-${process.pid}.js`);
    fs.writeFileSync(script, `
      process.stdout.write('PG_URL=' + process.env.PG_URL + '\\n');
      process.on('SIGTERM', () => { process.stdout.write('получен SIGTERM\\n'); process.exit(0); });
      setInterval(() => {}, 1000);
    `);
    try {
      const child = spawn(process.execPath, [TOOL, 'exec', ...args, '--', process.execPath, script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (d) => { text += d; });
      const exited = new Promise((r) => child.on('exit', (code) => r(code)));
      for (let t = Date.now(); !/PG_URL=/.test(text) && Date.now() - t < 10000;) await new Promise((r) => setTimeout(r, 50));
      expect(text).toContain(`PG_URL=${urls({ dir, port }).pgUrl}`);
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(text).toMatch(/получен SIGTERM/);

      expect(await main(['n', 't', 'exec', ...args, '--', process.execPath, '-e', 'process.exit(3)'], () => {})).toBe(3);
    } finally {
      fs.rmSync(script, { force: true });
    }
  });

  test('stop, status, reset', async () => {
    out.length = 0;
    expect(await main(['n', 't', 'stop', ...args], write)).toBe(0);
    expect(out.join('')).toMatch(/остановлен/);
    out.length = 0;
    expect(await main(['n', 't', 'status', ...args], write)).toBe(0);
    expect(out.join('')).toMatch(/Эмулятор PostgreSQL: остановлен/);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main(['n', 't', 'reset', ...args], () => {})).toBe(2);
    } finally {
      err.mockRestore();
    }
    expect(await main(['n', 't', 'reset', '--yes', ...args], write)).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
