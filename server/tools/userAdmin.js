// tools/userAdmin.js
// Пользователи сервера без интерфейса: первый администратор, роли, пароли, блокировка.
// Работает напрямую с PostgreSQL (PG_URL из conf.env, пароль БД — PGPASSWORD или ~/.pgpass),
// при необходимости применяет миграции. Запущенный сервер узнаёт об изменении через
// NOTIFY и закрывает сессии изменённого пользователя.
//
//   node tools/userAdmin.js list
//   node tools/userAdmin.js add <имя> --role viewer|operator|engineer|admin [--name "Ф. И. О."]
//   node tools/userAdmin.js passwd <имя>
//   node tools/userAdmin.js role <имя> <роль>
//   node tools/userAdmin.js rename <имя> "Ф. И. О."
//   node tools/userAdmin.js disable <имя> | enable <имя>
//   node tools/userAdmin.js remove <имя>
// Пароль вводится дважды без отображения; из скрипта — --password-stdin (одна строка на stdin).
// Пароль в аргументах командной строки не принимается: его видно в списке процессов.
// Каждое изменение — запись в журнал (источник userAdmin, пользователь ОС).
//
// Код выхода: 0 — успешно, 1 — ошибка (нет пользователя, последний администратор, БД), 2 — неверные аргументы.
'use strict';

const os = require('os');
const readline = require('readline');
const { loadConfig } = require('../services/config');
const { createDb } = require('../storage/db');
const { createUserStore, ROLES } = require('../services/userStore');
const { createJournal } = require('../services/journal');

const USAGE = 'Использование:\n'
  + '  node tools/userAdmin.js list\n'
  + '  node tools/userAdmin.js add <имя> --role viewer|operator|engineer|admin [--name "Ф. И. О."] [--password-stdin]\n'
  + '  node tools/userAdmin.js passwd <имя> [--password-stdin]\n'
  + '  node tools/userAdmin.js role <имя> <роль>\n'
  + '  node tools/userAdmin.js rename <имя> "Ф. И. О."\n'
  + '  node tools/userAdmin.js disable <имя> | enable <имя> | remove <имя>\n';

// Тихий логгер: инструмент печатает своё, сообщения сервисов — только ошибки
const quietLogger = {
  logInfoMessage: () => {},
  logDevMessage: () => {},
  logErrorMessage: (...a) => process.stderr.write(`${a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')}\n`),
};

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// Чтение строки без эха (TTY) или первой строки stdin
function readSecret(prompt, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    const tty = input.isTTY;
    const rl = readline.createInterface({ input, output: tty ? output : undefined, terminal: tty });
    if (tty) {
      output.write(prompt);
      rl._writeToOutput = () => {}; // эхо выключено
    }
    rl.once('line', (line) => {
      if (tty) output.write('\n');
      resolve(line); // до close: close синхронно вызывает reject ниже
      rl.close();
    });
    rl.once('close', () => reject(new Error('пароль не введён')));
  });
}

async function askPassword(args, io = {}) {
  const input = io.input || process.stdin;
  if (args.includes('--password-stdin') || !input.isTTY) return readSecret('', io);
  const a = await readSecret('Пароль: ', io);
  const b = await readSecret('Повторите пароль: ', io);
  if (a !== b) throw Object.assign(new Error('пароли не совпадают'), { exit: 2 });
  return a;
}

const fmtUser = (u) => `${u.username.padEnd(20)} ${u.role.padEnd(9)} ${u.disabled ? 'заблокирован' : 'действует   '} ${u.displayName || ''}\n`;

async function run(command, args, { users, journal, write, io }) {
  const name = args[1];
  const actor = `userAdmin (ОС: ${os.userInfo().username})`;
  const log = (action, newValue, extra = {}) => journal.record({ source: actor, action, newValue, ok: true, ...extra });

  if (command === 'list') {
    const list = await users.list();
    write(`Пользователей: ${list.length}\n`);
    for (const u of list) write(fmtUser(u));
    return 0;
  }
  if (!name) return null;
  if (command === 'add') {
    const role = argValue(args, '--role');
    if (!(role in ROLES)) return null;
    const password = await askPassword(args, io);
    const u = await users.create({ username: name, password, role, displayName: argValue(args, '--name') || '' });
    await log('user.create', { username: u.username, role: u.role });
    write(`Создан: ${fmtUser(u)}`);
    return 0;
  }
  if (command === 'passwd') {
    const password = await askPassword(args, io);
    await users.setPassword(name, password);
    await log('user.password', { username: name });
    write(`Пароль ${name} изменён, сессии пользователя закрыты\n`);
    return 0;
  }
  if (command === 'role') {
    const role = args[2];
    if (!(role in ROLES)) return null;
    const before = await users.get(name);
    const u = await users.setRole(name, role);
    await log('user.role', { username: name, role }, { oldValue: before && { role: before.role } });
    write(`Роль ${name}: ${u.role}\n`);
    return 0;
  }
  if (command === 'rename') {
    if (args[2] === undefined) return null;
    await users.setDisplayName(name, args[2]);
    await log('user.rename', { username: name, displayName: args[2] });
    write(`Имя ${name}: ${args[2]}\n`);
    return 0;
  }
  if (command === 'disable' || command === 'enable') {
    await users.setDisabled(name, command === 'disable');
    await log(`user.${command}`, { username: name });
    write(`${name}: ${command === 'disable' ? 'заблокирован, сессии закрыты' : 'разблокирован'}\n`);
    return 0;
  }
  if (command === 'remove') {
    await users.remove(name);
    await log('user.remove', { username: name });
    write(`Удалён: ${name}\n`);
    return 0;
  }
  return null;
}

async function main(argv, write = (s) => process.stdout.write(s), { env = process.env, io } = {}) {
  const args = argv.slice(2);
  const command = args[0];
  let config;
  try {
    ({ config } = loadConfig({ env }));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  if (!command) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (!config.pgUrl) {
    process.stderr.write('PG_URL не задан: пользователи хранятся в PostgreSQL (docs/users.md)\n');
    return 1;
  }
  const db = createDb({ url: config.pgUrl, poolMax: 2, logger: quietLogger });
  try {
    await db.start();
    const users = createUserStore({ db, logger: quietLogger, bcryptRounds: config.bcryptRounds });
    const journal = createJournal({ db, logger: quietLogger });
    const code = await run(command, args, { users, journal, write, io });
    if (code === null) {
      process.stderr.write(USAGE);
      return 2;
    }
    return code;
  } catch (err) {
    process.stderr.write(`Ошибка: ${err.message}\n`);
    return err.exit || 1;
  } finally {
    await db.stop().catch(() => {});
  }
}

if (require.main === module) main(process.argv).then((code) => { process.exitCode = code; });

module.exports = { main, readSecret };
