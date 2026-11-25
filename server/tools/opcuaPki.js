// tools/opcuaPki.js
// Доверие сертификатам клиентов OPC UA. Сервер не допускает неизвестного клиента и
// кладёт его сертификат в <PKI_DIR>/rejected; администратор проверяет отпечаток
// (тот же, что показывает клиент и лог сервера) и переносит сертификат в trusted/certs.
// Сервер следит за каталогами: перезапуск не нужен.
//
//   node tools/opcuaPki.js list [--pki <каталог>]            свой сертификат, доверенные, отклонённые
//   node tools/opcuaPki.js trust <отпечаток> [--pki <каталог>]   rejected → trusted
//   node tools/opcuaPki.js untrust <отпечаток> [--pki <каталог>] trusted → rejected
// Отпечаток SHA-1 — 40 шестнадцатеричных знаков; достаточно начала, если оно однозначно.
// Без --pki каталог берётся из PKI_DIR (conf.env).
//
// Код выхода: 0 — успешно, 1 — сертификат не найден или неоднозначен, 2 — неверные аргументы.
'use strict';

const fs = require('fs');
const path = require('path');
const { X509Certificate } = require('crypto');
const { loadConfig } = require('../services/config');

const USAGE = 'Использование:\n'
  + '  node tools/opcuaPki.js list [--pki <каталог>]\n'
  + '  node tools/opcuaPki.js trust <отпечаток> [--pki <каталог>]\n'
  + '  node tools/opcuaPki.js untrust <отпечаток> [--pki <каталог>]\n';

const CERT_RE = /\.(pem|der|crt|cer)$/i;

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// Сведения о сертификате файла или null, если файл не разобран
function readCertificate(file) {
  try {
    const cert = new X509Certificate(fs.readFileSync(file));
    const field = (re, text) => (text.match(re) || [])[1] || '';
    return {
      file,
      thumbprint: cert.fingerprint.replace(/:/g, '').toLowerCase(),
      subject: field(/CN=([^\n]+)/, cert.subject) || cert.subject.replace(/\n/g, ', '),
      applicationUri: field(/URI:([^,\s]+)/, cert.subjectAltName || ''),
      validTo: new Date(cert.validTo),
    };
  } catch {
    return null;
  }
}

function listDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => CERT_RE.test(n)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.map((n) => readCertificate(path.join(dir, n)) || { file: path.join(dir, n), broken: true });
}

const dirs = (pki) => ({
  own: path.join(pki, 'own', 'certs'),
  trusted: path.join(pki, 'trusted', 'certs'),
  rejected: path.join(pki, 'rejected'),
});

function formatCert(c) {
  if (c.broken) return `  ${path.basename(c.file)} — не удалось разобрать\n`;
  const expired = c.validTo < new Date() ? ' (ИСТЁК)' : '';
  return `  ${c.thumbprint}  ${c.subject}  ${c.applicationUri || '—'}  до ${c.validTo.toISOString().slice(0, 10)}${expired}\n`;
}

function list(pki, write) {
  const d = dirs(pki);
  write(`Каталог сертификатов: ${pki}\n`);
  for (const [title, dir] of [['Сертификат сервера', d.own], ['Доверенные клиенты', d.trusted], ['Отклонённые (ждут решения)', d.rejected]]) {
    const certs = listDir(dir);
    write(`\n${title}: ${certs.length}\n`);
    for (const c of certs) write(formatCert(c));
  }
  return 0;
}

function move(pki, prefix, from, to, write) {
  const p = String(prefix || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (p.length < 6) {
    process.stderr.write('Нужен отпечаток сертификата (не меньше 6 знаков), см. list\n');
    return 2;
  }
  const d = dirs(pki);
  const found = listDir(d[from]).filter((c) => !c.broken && c.thumbprint.startsWith(p));
  if (found.length !== 1) {
    process.stderr.write(found.length
      ? `Отпечаток ${p} неоднозначен: ${found.map((c) => c.thumbprint).join(', ')}\n`
      : `В ${d[from]} нет сертификата с отпечатком ${p}\n`);
    return 1;
  }
  const [cert] = found;
  fs.mkdirSync(d[to], { recursive: true });
  fs.renameSync(cert.file, path.join(d[to], path.basename(cert.file)));
  write(`${to === 'trusted' ? 'Доверен' : 'Отозван'}: ${cert.thumbprint} ${cert.subject} (${cert.applicationUri || '—'})\n`);
  return 0;
}

function main(argv, write = (s) => process.stdout.write(s)) {
  const args = argv.slice(2);
  const [command, arg] = args;
  let pki;
  try {
    const pkiArg = argValue(args, '--pki');
    pki = pkiArg ? path.resolve(pkiArg) : loadConfig().config.pkiDir;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  if (command === 'list') return list(pki, write);
  if (command === 'trust') return move(pki, arg, 'rejected', 'trusted', write);
  if (command === 'untrust') return move(pki, arg, 'trusted', 'rejected', write);
  process.stderr.write(USAGE);
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { main, readCertificate };
