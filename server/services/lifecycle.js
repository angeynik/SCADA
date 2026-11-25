// services/lifecycle.js
// Запуск и остановка сервисов сервера.
// Сервис — объект { start?, stop? } (обе функции могут быть async). Сервисы запускаются
// по очереди в порядке добавления и останавливаются в обратном порядке: драйверы
// добавляются раньше OPC UA и WebSocket, поэтому при остановке сначала перестают
// приниматься команды, потом останавливаются драйверы, в конце дописывается архив.
//
// start(): ошибка запуска останавливает уже запущенные сервисы и пробрасывается дальше.
// stop(reason): повторный вызов возвращает тот же промис. Ошибка остановки одного сервиса
// не мешает остановить остальные. Вся остановка ограничена timeoutMs.
// Результат stop — { ok, timedOut }: ok = false, если был таймаут или ошибка.
//
// Пока сервисы работают, lifecycle держит таймер, чтобы процесс не завершился сам,
// если ни один сервис не держит цикл событий (например, на этапе каркаса).
'use strict';

const KEEPALIVE_MS = 60 * 60 * 1000;

function createLifecycle({ logger, timeoutMs = 10000, timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
  const services = [];
  const started = [];
  let state = 'idle';
  let startPromise = null;
  let stopPromise = null;
  let keepAlive = null;

  function add(name, service) {
    if (state !== 'idle') throw new Error(`[Lifecycle] сервис "${name}" добавлен после запуска`);
    if (!name || !service) throw new Error('[Lifecycle] нужны имя и сервис');
    if (services.some((s) => s.name === name)) throw new Error(`[Lifecycle] сервис "${name}" уже добавлен`);
    services.push({ name, service });
  }

  async function runStart() {
    state = 'starting';
    keepAlive = timers.setInterval(() => {}, KEEPALIVE_MS);
    for (const entry of services) {
      if (stopPromise) break;
      try {
        if (entry.service.start) await entry.service.start();
        started.push(entry);
        logger.logDevMessage(`[Lifecycle] - start - запущен ${entry.name}`);
      } catch (err) {
        logger.logErrorMessage(`[Lifecycle] - start - ошибка запуска ${entry.name}:`, err);
        // state меняется до stop: иначе stop стал бы ждать этот же start.
        // Если остановку уже запросили снаружи, она сама дождётся этого start и всё остановит.
        state = 'failed';
        if (!stopPromise) await stop('ошибка запуска');
        throw err;
      }
    }
    if (!stopPromise) state = 'running';
  }

  function start() {
    if (state !== 'idle') return Promise.reject(new Error('[Lifecycle] повторный запуск'));
    startPromise = runStart();
    return startPromise;
  }

  async function stopServices() {
    let ok = true;
    while (started.length) {
      const entry = started.pop();
      try {
        if (entry.service.stop) await entry.service.stop();
        logger.logDevMessage(`[Lifecycle] - stop - остановлен ${entry.name}`);
      } catch (err) {
        ok = false;
        logger.logErrorMessage(`[Lifecycle] - stop - ошибка остановки ${entry.name}:`, err);
      }
    }
    return ok;
  }

  async function runStop(reason) {
    logger.logInfoMessage(`[Lifecycle] - stop - остановка сервера (${reason})`);
    // Остановка во время запуска ждёт, пока завершится текущий start сервиса
    if (startPromise && state === 'starting') await startPromise.catch(() => {});
    state = 'stopping';

    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve('timeout'), timeoutMs);
      if (timer && timer.unref) timer.unref();
    });
    const result = await Promise.race([stopServices(), timeout]);
    timers.clearTimeout(timer);
    timers.clearInterval(keepAlive);
    keepAlive = null;
    state = 'stopped';

    if (result === 'timeout') {
      logger.logErrorMessage(`[Lifecycle] - stop - остановка не уложилась в ${timeoutMs} мс`);
      return { ok: false, timedOut: true };
    }
    logger.logInfoMessage('[Lifecycle] - stop - сервер остановлен');
    return { ok: result, timedOut: false };
  }

  function stop(reason = 'запрос') {
    if (!stopPromise) stopPromise = runStop(reason);
    return stopPromise;
  }

  return {
    add,
    start,
    stop,
    state: () => state,
    names: () => services.map((s) => s.name),
  };
}

module.exports = { createLifecycle };
