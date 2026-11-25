'use strict';

const { createLifecycle } = require('../../services/lifecycle');
const { createFakeLogger } = require('../helpers/fakeLogger');

function service(name, calls, { failStart, failStop, stopDelayMs } = {}) {
  return {
    start: jest.fn(async () => {
      calls.push(`start:${name}`);
      if (failStart) throw new Error(`сбой ${name}`);
    }),
    stop: jest.fn(async () => {
      calls.push(`stop:${name}`);
      if (stopDelayMs) await new Promise((r) => setTimeout(r, stopDelayMs));
      if (failStop) throw new Error(`сбой остановки ${name}`);
    }),
  };
}

describe('lifecycle', () => {
  let logger;
  let calls;

  beforeEach(() => {
    logger = createFakeLogger();
    calls = [];
  });

  test('запуск по порядку, остановка в обратном порядке', async () => {
    const lc = createLifecycle({ logger });
    lc.add('db', service('db', calls));
    lc.add('drivers', service('drivers', calls));
    lc.add('opcua', service('opcua', calls));
    await lc.start();
    expect(lc.state()).toBe('running');
    const res = await lc.stop('тест');
    expect(res).toEqual({ ok: true, timedOut: false });
    expect(calls).toEqual(['start:db', 'start:drivers', 'start:opcua', 'stop:opcua', 'stop:drivers', 'stop:db']);
    expect(lc.state()).toBe('stopped');
  });

  test('ошибка запуска останавливает уже запущенные и пробрасывается', async () => {
    const lc = createLifecycle({ logger });
    lc.add('db', service('db', calls));
    lc.add('drivers', service('drivers', calls, { failStart: true }));
    lc.add('opcua', service('opcua', calls));
    await expect(lc.start()).rejects.toThrow('сбой drivers');
    expect(calls).toEqual(['start:db', 'start:drivers', 'stop:db']);
    expect(lc.state()).toBe('stopped');
    expect(logger.lines.error.join('\n')).toMatch(/ошибка запуска drivers/);
  });

  test('повторный stop возвращает тот же результат и не останавливает дважды', async () => {
    const lc = createLifecycle({ logger });
    const db = service('db', calls);
    lc.add('db', db);
    await lc.start();
    const [a, b] = await Promise.all([lc.stop('a'), lc.stop('b')]);
    expect(a).toBe(b);
    expect(db.stop).toHaveBeenCalledTimes(1);
  });

  test('ошибка остановки одного сервиса не мешает остальным, ok = false', async () => {
    const lc = createLifecycle({ logger });
    lc.add('db', service('db', calls));
    lc.add('drivers', service('drivers', calls, { failStop: true }));
    await lc.start();
    const res = await lc.stop();
    expect(res).toEqual({ ok: false, timedOut: false });
    expect(calls).toEqual(['start:db', 'start:drivers', 'stop:drivers', 'stop:db']);
  });

  test('остановка ограничена таймаутом', async () => {
    const lc = createLifecycle({ logger, timeoutMs: 50 });
    lc.add('slow', service('slow', calls, { stopDelayMs: 500 }));
    await lc.start();
    const res = await lc.stop();
    expect(res).toEqual({ ok: false, timedOut: true });
    expect(logger.lines.error.join('\n')).toMatch(/не уложилась в 50 мс/);
  });

  test('stop во время запуска дожидается текущего сервиса и не запускает следующие', async () => {
    const lc = createLifecycle({ logger });
    let release;
    lc.add('db', {
      start: () => new Promise((r) => { release = r; calls.push('start:db'); }),
      stop: async () => calls.push('stop:db'),
    });
    lc.add('opcua', service('opcua', calls));
    const starting = lc.start();
    const stopping = lc.stop('сигнал');
    release();
    await starting;
    await stopping;
    expect(calls).toEqual(['start:db', 'stop:db']);
    expect(lc.state()).toBe('stopped');
  });

  test('сервис без start/stop допустим', async () => {
    const lc = createLifecycle({ logger });
    lc.add('empty', {});
    await lc.start();
    await expect(lc.stop()).resolves.toEqual({ ok: true, timedOut: false });
  });

  test('add после запуска, повтор имени и повторный start — ошибки', async () => {
    const lc = createLifecycle({ logger });
    lc.add('db', {});
    expect(() => lc.add('db', {})).toThrow(/уже добавлен/);
    await lc.start();
    expect(() => lc.add('late', {})).toThrow(/после запуска/);
    await expect(lc.start()).rejects.toThrow(/повторный запуск/);
    await lc.stop();
  });

  test('таймер удержания процесса снимается при остановке', async () => {
    const timers = {
      setTimeout, clearTimeout,
      setInterval: jest.fn(() => 'keep'),
      clearInterval: jest.fn(),
    };
    const lc = createLifecycle({ logger, timers });
    await lc.start();
    expect(timers.setInterval).toHaveBeenCalledTimes(1);
    await lc.stop();
    expect(timers.clearInterval).toHaveBeenCalledWith('keep');
  });
});
