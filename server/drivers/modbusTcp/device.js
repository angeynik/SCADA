// drivers/modbusTcp/device.js
// Опрос одного контроллера (host:port): одно соединение, одна очередь запросов.
//
// Цикл: подключиться (при неудаче — повтор с паузой от reconnectMinMs, удваивается
// до reconnectMaxMs) → прочитать все блоки плана → следующий цикл через pollMs от начала
// предыдущего (если цикл длиннее pollMs — сразу). Запись встаёт в очередь раньше чтений.
//
// Ошибки:
//   - исключение Modbus (контроллер ответил) — связь есть. Блок из нескольких точек
//     разбивается на запросы по одной точке, чтобы найти неверную; точка, которую
//     контроллер отвергает отдельно, получает bad / CONFIG_ERROR (лог один раз);
//   - таймаут или обрыв — счётчик неудач; после failLimit неудач подряд (или при закрытии
//     соединения контроллером) все теги контроллера получают bad / COMM_ERROR,
//     соединение закрывается и устанавливается заново после паузы.
// Связь считается восстановленной только после успешного чтения, а не после TCP-подключения:
// контроллер может принимать соединение и не отвечать. Пауза переподключения сбрасывается
// тоже только после успешного чтения. Потеря и восстановление связи пишутся в лог по разу.
'use strict';

const { decode, encode, setBit, pointSize } = require('./codec');
const { buildBlocks } = require('./planner');

function createModbusDevice({ host, port, entries, tagStore, logger, options, transport, timers = { setTimeout, clearTimeout }, now = Date.now }) {
  const {
    pollMs = 1000,
    failLimit = 3,
    maxGap = 4,
    reconnectMinMs = 1000,
    reconnectMaxMs = 30000,
  } = options;
  const key = `${host}:${port}`;
  const log = (fn, msg, ...rest) => logger[fn](`[ModbusTCP] - ${key} - ${msg}`, ...rest);

  let blocks = buildBlocks(entries, { maxGap });
  const byTag = new Map(entries.map((e) => [e.tagId, e]));
  const configErrors = new Set();

  let stopped = true;
  let connected = false; // TCP-соединение открыто
  let online = false; // последнее чтение успешно — данные идут
  let everOnline = false;
  let downLogged = false;
  let failCount = 0;
  let backoffMs = reconnectMinMs;
  let timer = null;
  let lastError = null;
  let lastCycleMs = null;
  const stats = { reads: 0, readErrors: 0, writes: 0, writeErrors: 0 };

  // ── Очередь: запись (high) раньше чтения (low), запросы строго по одному ──
  const queue = { high: [], low: [] };
  let busy = false;

  function enqueue(fn, high = false) {
    return new Promise((resolve, reject) => {
      (high ? queue.high : queue.low).push({ fn, resolve, reject });
      pump();
    });
  }

  async function pump() {
    if (busy) return;
    busy = true;
    for (let task = queue.high.shift() || queue.low.shift(); task; task = queue.high.shift() || queue.low.shift()) {
      try {
        task.resolve(await task.fn());
      } catch (err) {
        task.reject(err);
      }
    }
    busy = false;
  }

  function drainQueue(reason) {
    for (const task of [...queue.high.splice(0), ...queue.low.splice(0)]) task.reject(new Error(reason));
  }

  // ── Состояние связи ──
  function setAll(quality, code) {
    for (const e of entries) tagStore.setQuality(e.tagId, quality, code);
  }

  function markDown(reason) {
    lastError = reason;
    if (!downLogged) {
      log('logErrorMessage', everOnline ? `нет связи: ${reason}` : `нет данных от контроллера: ${reason}`);
      downLogged = true;
    }
    online = false;
    if (connected) {
      connected = false;
      transport.close();
    }
    failCount = 0;
    setAll('bad', 'COMM_ERROR');
  }

  function onTransportError(err) {
    if (stopped) return;
    lastError = err.message;
    failCount += 1;
    if (failCount >= failLimit) markDown(`${err.message} (${failCount} раза подряд)`);
  }

  transport.onClose(() => {
    if (!stopped && connected) markDown('соединение закрыто контроллером');
  });

  async function tryConnect() {
    try {
      await transport.connect();
    } catch (err) {
      if (!stopped) markDown(err.message);
      return false;
    }
    if (stopped) {
      transport.close();
      return false;
    }
    connected = true;
    failCount = 0;
    log('logDevMessage', 'соединение установлено');
    return true;
  }

  function nextBackoff() {
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, reconnectMaxMs);
    return wait;
  }

  function markOnline() {
    if (online) return;
    online = true;
    backoffMs = reconnectMinMs;
    if (everOnline) log('logInfoMessage', 'связь восстановлена');
    else log('logDevMessage', 'на связи');
    everOnline = true;
    downLogged = false;
  }

  // ── Чтение ──
  function publish(block, data) {
    const ts = now();
    for (const item of block.items) {
      const words = data.slice(item.index, item.index + pointSize(item.point));
      configErrors.delete(item.tagId);
      tagStore.update(item.tagId, decode(item.point, words, item.byteOrder), { sourceTs: ts });
    }
  }

  function onException(block, err) {
    const single = buildBlocks(block.items.map((i) => ({ ...byTag.get(i.tagId) })), { maxGap: -1 });
    if (single.length > 1) {
      log('logInfoMessage', `блок ${block.area}:${block.address}+${block.length} отвергнут (${err.message}), опрос по одной точке`);
      blocks = blocks.flatMap((b) => (b === block ? single : [b]));
      return;
    }
    for (const item of block.items) {
      if (!configErrors.has(item.tagId)) {
        configErrors.add(item.tagId);
        log('logErrorMessage', `${item.tagId}: ${block.area}:${block.address} — ${err.message}`);
      }
      tagStore.setQuality(item.tagId, 'bad', 'CONFIG_ERROR');
    }
  }

  async function readBlock(block) {
    stats.reads += 1;
    try {
      const data = await transport.read(block.unitId, block.area, block.address, block.length);
      failCount = 0;
      markOnline();
      publish(block, data);
    } catch (err) {
      stats.readErrors += 1;
      if (err.kind === 'exception') {
        failCount = 0;
        onException(block, err);
      } else {
        onTransportError(err);
      }
    }
  }

  function schedule(ms) {
    if (stopped) return;
    timer = timers.setTimeout(cycle, Math.max(0, ms));
  }

  async function cycle() {
    timer = null;
    if (stopped) return;
    if (!connected && !(await tryConnect())) {
      schedule(nextBackoff());
      return;
    }
    const t0 = now();
    for (const block of [...blocks]) {
      if (stopped || !connected) break;
      try {
        await enqueue(() => readBlock(block));
      } catch {
        break;
      }
    }
    lastCycleMs = now() - t0;
    schedule(connected ? pollMs - lastCycleMs : nextBackoff());
  }

  // ── Запись ──
  async function doWrite(entry, value) {
    const { unitId, point, byteOrder, tagId } = entry;
    const enc = encode(point, value, byteOrder);
    if ('coil' in enc) await transport.writeCoil(unitId, point.address, enc.coil);
    else if ('bit' in enc) {
      // Чтение-изменение-запись: остальные биты регистра сохраняются
      const [word] = await transport.read(unitId, 'holding', point.address, 1);
      await transport.writeRegister(unitId, point.address, setBit(word, enc.bit, enc.state, byteOrder));
    } else if (enc.words.length === 1) await transport.writeRegister(unitId, point.address, enc.words[0]);
    else await transport.writeRegisters(unitId, point.address, enc.words);

    // Подтверждение — повторное чтение: в tagStore попадает то, что реально в контроллере
    const data = await transport.read(unitId, point.area, point.address, pointSize(point));
    const actual = decode(point, data, byteOrder);
    tagStore.update(tagId, actual, { sourceTs: now() });
    return actual;
  }

  async function write(tagId, value) {
    const entry = byTag.get(tagId);
    if (!entry) return { ok: false, code: 'NOT_FOUND', message: `тег ${tagId} не обслуживается ${key}` };
    if (!connected) return { ok: false, code: 'NOT_CONNECTED', message: `нет связи с ${key}` };
    try {
      encode(entry.point, value, entry.byteOrder);
    } catch (err) {
      return { ok: false, code: 'OUT_OF_RANGE', message: err.message };
    }
    stats.writes += 1;
    try {
      const actual = await enqueue(() => doWrite(entry, value), true);
      return { ok: true, value: actual };
    } catch (err) {
      stats.writeErrors += 1;
      if (err.kind === 'transport') onTransportError(err);
      log('logErrorMessage', `запись ${tagId} = ${value}: ${err.message}`);
      return { ok: false, code: 'WRITE_FAILED', message: err.message };
    }
  }

  return {
    key,
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      drainQueue('драйвер остановлен');
      connected = false;
      online = false;
      transport.close();
      setAll('bad', 'NOT_CONNECTED');
    },
    write,
    status: () => ({
      key,
      connected,
      online,
      failCount,
      lastError,
      lastCycleMs,
      blocks: blocks.length,
      tags: entries.length,
      ...stats,
    }),
  };
}

module.exports = { createModbusDevice };
