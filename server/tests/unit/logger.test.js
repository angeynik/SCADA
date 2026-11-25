'use strict';

const logger = require('../../services/logger');

describe('logger', () => {
  let out;
  let err;

  beforeEach(() => {
    out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    out.mockRestore();
    err.mockRestore();
    logger.initLogging('none');
  });

  test.each([
    ['none', 0, 0, 0],
    ['error', 0, 0, 1],
    ['info', 1, 0, 1],
    ['dev', 1, 1, 1],
  ])('уровень %s: info=%i dev=%i error=%i', (level, info, dev, error) => {
    logger.initLogging(level);
    logger.logInfoMessage('i');
    logger.logDevMessage('d');
    logger.logErrorMessage('e');
    expect(out.mock.calls.filter(([s]) => s === 'i\n')).toHaveLength(info);
    expect(out.mock.calls.filter(([s]) => s === '[DEV] d\n')).toHaveLength(dev);
    expect(err.mock.calls.filter(([s]) => s === '[ERROR] e\n')).toHaveLength(error);
  });

  test('неизвестный уровень работает как info', () => {
    logger.initLogging('verbose');
    logger.logInfoMessage('i');
    logger.logDevMessage('d');
    expect(out).toHaveBeenCalledTimes(1);
  });

  test('аргументы: строка как есть, Error — message, объект — в одну строку', () => {
    logger.initLogging('info');
    logger.logInfoMessage('[M] - f -', new Error('сбой'), { a: { b: 1 } });
    expect(out).toHaveBeenCalledWith('[M] - f - сбой { a: { b: 1 } }\n');
  });

  test('redactSecrets маскирует пароль и токен', () => {
    const raw = '{"username":"op","password":"p\\"x","token":"abc","value":1}';
    expect(logger.redactSecrets(raw)).toBe('{"username":"op","password":"***","token":"***","value":1}');
  });

  // Последним: после него запись в stdout и stderr в этом процессе Jest отключена
  test('ошибка канала вывода отключает запись в него, без исключений', () => {
    logger.initLogging('info');
    err.mockImplementationOnce(() => { throw new Error('EPIPE'); });
    expect(() => logger.logErrorMessage('первая')).not.toThrow();
    logger.logErrorMessage('вторая');
    expect(err).toHaveBeenCalledTimes(1);
    process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    logger.logInfoMessage('после обрыва');
    expect(out).not.toHaveBeenCalled();
  });
});
