// tools/pgEmulator.js
// Эмулятор рабочего PostgreSQL для разработки: отдельный экземпляр (кластер) из программ
// PostgreSQL, установленных на машине. Общий PostgreSQL машины и сеть не затрагиваются:
// экземпляр слушает только Unix-сокет в своём каталоге, TCP выключен.
// На объекте вместо него — настоящий PostgreSQL (docs/users.md, «База данных»).
//
//   node tools/pgEmulator.js start        создать (при первом запуске) и запустить
//   node tools/pgEmulator.js status       запущен ли, адреса PG_URL и TEST_PG_URL
//   node tools/pgEmulator.js stop
//   node tools/pgEmulator.js reset --yes  остановить и удалить все данные эмулятора
//   node tools/pgEmulator.js exec -- <команда>   выполнить команду с PG_URL и TEST_PG_URL
//                                                эмулятора (запускает эмулятор, если нужно)
//     например: exec -- npm start, exec -- node tools/userAdmin.js list, exec -- npm test
// Параметры: --dir <каталог> (по умолчанию см. defaultDir), --port <номер> (55432 — входит
// в имя сокета, TCP не открывается).
//
// Что эмулируется: роль scada (владелец баз, без прав суперпользователя), база scada (работа)
// и scada_test (тесты). Данные сохраняются между запусками. Отличие от объекта: вход по сокету
// без пароля (trust) — на объекте пароль задаётся через PGPASSWORD или ~/.pgpass.
// TimescaleDB в эмуляторе нет, если расширение не установлено на машине.
//
// Под root (initdb и postgres под root не работают) программы запускаются от пользователя ОС
// postgres, каталог по умолчанию — /var/tmp/scada-pg-emu (в /root у postgres нет доступа).
//
// Код выхода: 0 — успешно, 1 — ошибка, 2 — неверные аргументы. exec — код выхода команды.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { loadConfig } = require('../services/config');

const DEFAULT_PORT = 55432;
const ROLE = 'scada';
const DATABASES = ['scada', 'scada_test'];
const USAGE = 'Использование:\n'
  + '  node tools/pgEmulator.js start | status | stop [--dir <каталог>] [--port 55432]\n'
  + '  node tools/pgEmulator.js reset --yes\n'
  + '  node tools/pgEmulator.js exec -- <команда> [аргументы]\n';

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// Каталог программ PostgreSQL: PG_BIN, pg_config --bindir или самая новая версия в /usr/lib/postgresql
function resolveBinDir({ env = process.env, run = spawnSync, readdir = fs.readdirSync, exists = fs.existsSync } = {}) {
  const ok = (dir) => dir && exists(path.join(dir, 'initdb')) && exists(path.join(dir, 'pg_ctl'));
  if (env.PG_BIN) {
    if (ok(env.PG_BIN)) return env.PG_BIN;
    throw new Error(`PG_BIN=${env.PG_BIN}: нет initdb и pg_ctl`);
  }
  const fromConfig = run('pg_config', ['--bindir'], { encoding: 'utf8' });
  if (fromConfig.status === 0 && ok(fromConfig.stdout.trim())) return fromConfig.stdout.trim();
  let versions = [];
  try {
    versions = readdir('/usr/lib/postgresql').filter((v) => /^\d+$/.test(v)).sort((a, b) => b - a);
  } catch {
    versions = [];
  }
  for (const v of versions) {
    const dir = `/usr/lib/postgresql/${v}/bin`;
    if (ok(dir)) return dir;
  }
  throw new Error('программы PostgreSQL (initdb, pg_ctl) не найдены: установите PostgreSQL или задайте PG_BIN');
}

// Каталог эмулятора: под root — вне /root (postgres туда не попадёт), иначе — в DATA_DIR
function defaultDir({ uid, dataDir }) {
  return uid === 0 ? '/var/tmp/scada-pg-emu' : path.join(dataDir, 'pg-emu');
}

// Адреса для conf.env и тестов: сокет в каталоге эмулятора, порт — часть имени сокета
function urls({ dir, port }) {
  const sock = path.join(dir, 'sock');
  const url = (db) => `postgresql:///${db}?host=${sock}&port=${port}&user=${ROLE}`;
  return { pgUrl: url('scada'), testPgUrl: url('scada_test'), sock };
}

function createEmulator({ dir, port, binDir, asRoot, log = (s) => process.stdout.write(s) }) {
  const dataDir = path.join(dir, 'data');
  const { sock } = urls({ dir, port });
  const logFile = path.join(dir, 'postgres.log');

  // Под root — от пользователя postgres
  function pg(tool, args, opts = {}) {
    const bin = path.join(binDir, tool);
    const [cmd, cmdArgs] = asRoot ? ['runuser', ['-u', 'postgres', '--', bin, ...args]] : [bin, args];
    const res = spawnSync(cmd, cmdArgs, { encoding: 'utf8', cwd: '/', ...opts });
    if (res.error) throw new Error(`${tool}: ${res.error.message}`);
    return res;
  }

  const initialized = () => fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  const running = () => initialized() && pg('pg_ctl', ['-D', dataDir, 'status']).status === 0;

  function prepareDir() {
    fs.mkdirSync(sock, { recursive: true });
    if (asRoot) {
      const r = spawnSync('chown', ['-R', 'postgres:postgres', dir]);
      if (r.status !== 0) throw new Error(`не удалось передать ${dir} пользователю postgres`);
    }
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(sock, 0o755);
  }

  function psql(sql, db = 'postgres') {
    const r = pg('psql', ['-h', sock, '-p', String(port), '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-Atqc', sql]);
    if (r.status !== 0) throw new Error(`psql: ${(r.stderr || '').trim()}`);
    return r.stdout.trim();
  }

  function start() {
    prepareDir();
    if (!initialized()) {
      log(`Создаю экземпляр PostgreSQL в ${dataDir}\n`);
      const r = pg('initdb', ['-D', dataDir, '--auth=trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C.UTF-8']);
      if (r.status !== 0) throw new Error(`initdb: ${(r.stderr || r.stdout).trim()}`);
    }
    if (!running()) {
      const opts = `-c listen_addresses='' -c unix_socket_directories='${sock}' -p ${port}`;
      const r = pg('pg_ctl', ['-D', dataDir, '-o', opts, '-l', logFile, '-w', '-t', '30', 'start']);
      if (r.status !== 0) {
        throw new Error(`pg_ctl start: ${(r.stderr || r.stdout).trim()}. Журнал PostgreSQL: ${logFile}`);
      }
    }
    // Роль и базы — как на объекте; повторный запуск ничего не меняет
    if (psql(`SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}'`) !== '1') psql(`CREATE ROLE ${ROLE} LOGIN`);
    for (const db of DATABASES) {
      if (psql(`SELECT 1 FROM pg_database WHERE datname = '${db}'`) !== '1') psql(`CREATE DATABASE ${db} OWNER ${ROLE}`);
    }
    return status();
  }

  function stop() {
    if (!running()) return false;
    const r = pg('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
    if (r.status !== 0) throw new Error(`pg_ctl stop: ${(r.stderr || r.stdout).trim()}`);
    return true;
  }

  function reset() {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  function status() {
    const isRunning = running();
    return {
      initialized: initialized(),
      running: isRunning,
      version: initialized() ? fs.readFileSync(path.join(dataDir, 'PG_VERSION'), 'utf8').trim() : null,
      timescaledb: isRunning ? psql("SELECT count(*) FROM pg_available_extensions WHERE name = 'timescaledb'") === '1' : null,
      dir,
      ...urls({ dir, port }),
    };
  }

  return { start, stop, reset, status };
}

function printStatus(s, write) {
  write(`Эмулятор PostgreSQL: ${s.running ? 'запущен' : s.initialized ? 'остановлен' : 'не создан'}${s.version ? ` (PostgreSQL ${s.version})` : ''}\n`);
  write(`Каталог: ${s.dir}\n`);
  if (s.running) {
    write(`TimescaleDB: ${s.timescaledb ? 'доступен' : 'не установлен на машине'}\n`);
    write('\nДля conf.env:\n');
    write(`PG_URL=${s.pgUrl}\n`);
    write(`\nДля тестов: TEST_PG_URL='${s.testPgUrl}' npm test\n`);
    write('или:       node tools/pgEmulator.js exec -- npm test\n');
  }
}

async function main(argv, write = (s) => process.stdout.write(s), { env = process.env, uid = process.getuid() } = {}) {
  const all = argv.slice(2);
  const sep = all.indexOf('--');
  const args = sep >= 0 ? all.slice(0, sep) : all;
  const rest = sep >= 0 ? all.slice(sep + 1) : [];
  const command = args[0];
  if (!['start', 'stop', 'status', 'reset', 'exec'].includes(command)) {
    process.stderr.write(USAGE);
    return 2;
  }
  const port = Number(argValue(args, '--port') || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    process.stderr.write('--port: от 1024 до 65535\n');
    return 2;
  }
  let emu;
  try {
    const dirArg = argValue(args, '--dir');
    const dir = dirArg ? path.resolve(dirArg) : defaultDir({ uid, dataDir: loadConfig({ env }).config.dataDir });
    emu = createEmulator({ dir, port, binDir: resolveBinDir({ env }), asRoot: uid === 0, log: write });
  } catch (err) {
    process.stderr.write(`Ошибка: ${err.message}\n`);
    return 1;
  }

  try {
    if (command === 'status') {
      printStatus(emu.status(), write);
      return 0;
    }
    if (command === 'start') {
      printStatus(emu.start(), write);
      return 0;
    }
    if (command === 'stop') {
      write(emu.stop() ? 'Эмулятор PostgreSQL остановлен\n' : 'Эмулятор PostgreSQL не был запущен\n');
      return 0;
    }
    if (command === 'reset') {
      if (!args.includes('--yes')) {
        process.stderr.write('reset удаляет все данные эмулятора (пользователей, журнал). Подтвердите: reset --yes\n');
        return 2;
      }
      emu.reset();
      write('Данные эмулятора PostgreSQL удалены\n');
      return 0;
    }
    // exec
    if (!rest.length) {
      process.stderr.write(USAGE);
      return 2;
    }
    const s = emu.start();
    const child = spawn(rest[0], rest.slice(1), {
      stdio: 'inherit',
      env: { ...env, PG_URL: s.pgUrl, TEST_PG_URL: s.testPgUrl },
    });
    // Сигнал остановки (Ctrl+C, systemd, timeout) — команде: сервер должен остановиться
    // корректно, а не потерять родителя
    const forward = (sig) => child.kill(sig);
    process.on('SIGTERM', forward);
    process.on('SIGINT', forward);
    try {
      return await new Promise((resolve) => {
        child.on('error', (err) => {
          process.stderr.write(`Ошибка: ${rest[0]}: ${err.message}\n`);
          resolve(1);
        });
        child.on('exit', (code, signal) => resolve(code === null ? (signal ? 1 : 0) : code));
      });
    } finally {
      process.off('SIGTERM', forward);
      process.off('SIGINT', forward);
    }
  } catch (err) {
    process.stderr.write(`Ошибка: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) main(process.argv).then((code) => { process.exitCode = code; });

module.exports = { main, createEmulator, resolveBinDir, defaultDir, urls, DEFAULT_PORT };
