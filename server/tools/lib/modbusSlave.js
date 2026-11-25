// tools/lib/modbusSlave.js
// Эмулятор контроллера Modbus TCP для разработки и тестов (на основе ServerTCP из modbus-serial).
// Память — 65 536 слов в каждой области (holding, input) и 65 536 битов (coil, discrete),
// общая для всех unitId. Для проверки драйвера умеет:
//   illegal(area, from, to) — отвечать исключением 2 (недопустимый адрес) на этот диапазон;
//   setSilent(true)        — не отвечать на запросы (таймаут у клиента);
//   dropClients()          — закрыть все соединения (обрыв связи).
// Записи клиентов попадают в память и в журнал writes: [{ area, address, value }].
'use strict';

const net = require('net');
const ModbusRTU = require('modbus-serial');

function createModbusSlave({ host = '127.0.0.1', port = 0 } = {}) {
  const mem = {
    holding: new Uint16Array(65536),
    input: new Uint16Array(65536),
    coil: new Uint8Array(65536),
    discrete: new Uint8Array(65536),
  };
  const illegalRanges = [];
  const writes = [];
  let silent = false;
  let server = null;
  let actualPort = null;

  const isIllegal = (area, from, len) => illegalRanges
    .some((r) => r.area === area && from <= r.to && from + len - 1 >= r.from);

  // Ответ в стиле callback ServerTCP: ошибка { modbusErrorCode } или значение
  function reply(area, address, len, cb, fn) {
    if (silent) return;
    if (isIllegal(area, address, len)) {
      cb({ modbusErrorCode: 2, msg: 'Illegal data address' });
      return;
    }
    cb(null, fn());
  }

  const vector = {
    getMultipleHoldingRegisters: (addr, len, unit, cb) => reply('holding', addr, len, cb, () => Array.from(mem.holding.subarray(addr, addr + len))),
    getHoldingRegister: (addr, unit, cb) => reply('holding', addr, 1, cb, () => mem.holding[addr]),
    getMultipleInputRegisters: (addr, len, unit, cb) => reply('input', addr, len, cb, () => Array.from(mem.input.subarray(addr, addr + len))),
    getInputRegister: (addr, unit, cb) => reply('input', addr, 1, cb, () => mem.input[addr]),
    getCoil: (addr, unit, cb) => reply('coil', addr, 1, cb, () => mem.coil[addr] === 1),
    getDiscreteInput: (addr, unit, cb) => reply('discrete', addr, 1, cb, () => mem.discrete[addr] === 1),
    setRegister: (addr, value, unit, cb) => reply('holding', addr, 1, cb, () => {
      mem.holding[addr] = value;
      writes.push({ area: 'holding', address: addr, value });
    }),
    setCoil: (addr, value, unit, cb) => reply('coil', addr, 1, cb, () => {
      mem.coil[addr] = value ? 1 : 0;
      writes.push({ area: 'coil', address: addr, value: Boolean(value) });
    }),
  };

  // ServerTCP заменяет порт 0 на 502, поэтому свободный порт выбирается заранее
  function freePort() {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen({ host, port: 0 }, () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });
  }

  async function start() {
    const listenPort = port || await freePort();
    return new Promise((resolve, reject) => {
      server = new ModbusRTU.ServerTCP(vector, { host, port: listenPort });
      server.once('serverError', reject);
      server.once('initialized', () => {
        actualPort = server._server.address().port;
        resolve(actualPort);
      });
    });
  }

  function dropClients() {
    if (!server) return;
    for (const sock of server.socks.keys()) sock.destroy();
  }

  function stop() {
    if (!server) return Promise.resolve();
    dropClients();
    const s = server;
    server = null;
    return new Promise((resolve) => s.close(() => resolve()));
  }

  return {
    start,
    stop,
    dropClients,
    port: () => actualPort,
    mem,
    writes,
    illegal: (area, from, to = from) => illegalRanges.push({ area, from, to }),
    clearIllegal: () => illegalRanges.splice(0),
    setSilent: (v) => { silent = v; },
    setRegisters: (area, address, words) => mem[area].set(words, address),
    setBit: (area, address, state) => { mem[area][address] = state ? 1 : 0; },
  };
}

module.exports = { createModbusSlave };
