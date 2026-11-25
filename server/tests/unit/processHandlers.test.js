'use strict';

const { EventEmitter } = require('events');
const { installProcessHandlers } = require('../../services/processHandlers');
const { createFakeLogger } = require('../helpers/fakeLogger');

const flush = () => new Promise((r) => setImmediate(r));

describe('processHandlers', () => {
  let proc;
  let logger;
  let exit;
  let lifecycle;
  let uninstall;

  beforeEach(() => {
    proc = new EventEmitter();
    logger = createFakeLogger();
    exit = jest.fn();
    lifecycle = { stop: jest.fn(async () => ({ ok: true, timedOut: false })) };
    uninstall = installProcessHandlers({ proc, lifecycle, logger, exit });
  });

  afterEach(() => uninstall());

  test.each(['SIGTERM', 'SIGINT'])('%s — остановка и выход с кодом 0', async (signal) => {
    proc.emit(signal, signal);
    await flush();
    expect(lifecycle.stop).toHaveBeenCalledWith(signal);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('остановка с ошибкой — код 1', async () => {
    lifecycle.stop.mockResolvedValueOnce({ ok: false, timedOut: true });
    proc.emit('SIGTERM', 'SIGTERM');
    await flush();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('повторный сигнал во время остановки — немедленный выход с кодом 1', async () => {
    lifecycle.stop.mockReturnValueOnce(new Promise(() => {}));
    proc.emit('SIGTERM', 'SIGTERM');
    proc.emit('SIGINT', 'SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
    expect(lifecycle.stop).toHaveBeenCalledTimes(1);
  });

  test('uncaughtException — лог, остановка, код 1 даже при успешной остановке', async () => {
    proc.emit('uncaughtException', new Error('бах'));
    await flush();
    expect(logger.lines.error.join('\n')).toMatch(/uncaughtException/);
    expect(lifecycle.stop).toHaveBeenCalledWith('uncaughtException');
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('повторная uncaughtException во время остановки — немедленный выход', () => {
    lifecycle.stop.mockReturnValueOnce(new Promise(() => {}));
    proc.emit('uncaughtException', new Error('первая'));
    proc.emit('uncaughtException', new Error('вторая'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(lifecycle.stop).toHaveBeenCalledTimes(1);
  });

  test('unhandledRejection — только лог, процесс продолжает работу', async () => {
    proc.emit('unhandledRejection', new Error('отказ'));
    await flush();
    expect(logger.lines.error.join('\n')).toMatch(/unhandledRejection.*отказ/);
    expect(lifecycle.stop).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test('сбой lifecycle.stop — код 1', async () => {
    lifecycle.stop.mockRejectedValueOnce(new Error('сломалось'));
    proc.emit('SIGTERM', 'SIGTERM');
    await flush();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('uninstall снимает обработчики', () => {
    uninstall();
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.listenerCount('uncaughtException')).toBe(0);
  });
});
