'use strict';

const { createTagStore, fitsType } = require('../../core/tagStore');
const { createFakeLogger } = require('../helpers/fakeLogger');

function tagsOf(list) {
  return new Map(list.map((t) => [t.id, { deadband: 0, ...t }]));
}

const TAGS = tagsOf([
  { id: 'B1/A1/Temp', dataType: 'Float', deadband: 0.5 },
  { id: 'B1/A1/Run', dataType: 'Boolean' },
  { id: 'B1/A1/State', dataType: 'UInt16' },
  { id: 'B1/A2/Temp', dataType: 'Float' },
]);

describe('tagStore', () => {
  let logger;
  let clock;
  let store;

  beforeEach(() => {
    logger = createFakeLogger();
    clock = 1000;
    store = createTagStore({ tags: TAGS, logger, now: () => clock });
  });

  test('после запуска все теги bad / NOT_CONNECTED без значения', () => {
    expect(store.size()).toBe(4);
    expect(store.get('B1/A1/Temp')).toEqual({ value: null, quality: 'bad', code: 'NOT_CONNECTED', sourceTs: null, serverTs: 1000 });
  });

  test('новое значение публикуется с метками времени', () => {
    const seen = [];
    store.subscribe((c) => seen.push(c));
    clock = 2000;
    expect(store.update('B1/A1/Run', true, { sourceTs: 1990 })).toBe(true);
    expect(seen).toEqual([{ id: 'B1/A1/Run', value: true, quality: 'good', code: null, sourceTs: 1990, serverTs: 2000 }]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(store.get('B1/A1/Run').value).toBe(true);
  });

  test('без sourceTs берётся время сервера', () => {
    clock = 3000;
    store.update('B1/A1/Run', false);
    expect(store.get('B1/A1/Run').sourceTs).toBe(3000);
  });

  test('то же значение и качество не публикуются', () => {
    const fn = jest.fn();
    store.update('B1/A1/State', 3);
    store.subscribe(fn);
    expect(store.update('B1/A1/State', 3)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  test('мёртвая зона считается от последнего опубликованного значения', () => {
    const values = [];
    store.subscribe((c) => values.push(c.value), { ids: ['B1/A1/Temp'] });
    for (const v of [20, 20.3, 20.5, 20.6, 20.2, 19.9]) store.update('B1/A1/Temp', v);
    // 20 → (20.3, 20.5 в пределах 0.5) → 20.6 → (20.2 в пределах) → 19.9
    expect(values).toEqual([20, 20.6, 19.9]);
  });

  test('без мёртвой зоны публикуется любое изменение', () => {
    const values = [];
    store.subscribe((c) => values.push(c.value), { ids: ['B1/A2/Temp'] });
    for (const v of [1, 1.0001, 1.0001]) store.update('B1/A2/Temp', v);
    expect(values).toEqual([1, 1.0001]);
  });

  test('смена качества публикуется даже в пределах мёртвой зоны', () => {
    const seen = [];
    store.update('B1/A1/Temp', 20);
    store.subscribe((c) => seen.push([c.value, c.quality, c.code]));
    store.update('B1/A1/Temp', 20.1, { quality: 'uncertain', code: 'STALE' });
    expect(seen).toEqual([[20.1, 'uncertain', 'STALE']]);
  });

  test('setQuality сохраняет значение и метку источника', () => {
    store.update('B1/A1/Temp', 21, { sourceTs: 500 });
    clock = 5000;
    expect(store.setQuality('B1/A1/Temp', 'bad', 'COMM_ERROR')).toBe(true);
    expect(store.get('B1/A1/Temp')).toEqual({ value: 21, quality: 'bad', code: 'COMM_ERROR', sourceTs: 500, serverTs: 5000 });
    expect(store.setQuality('B1/A1/Temp', 'bad', 'COMM_ERROR')).toBe(false);
  });

  test('setQuality с good запрещён', () => {
    expect(store.setQuality('B1/A1/Temp', 'good', null)).toBe(false);
    expect(logger.lines.error[0]).toMatch(/good ставится только вместе со значением/);
  });

  test('значение не того типа: bad / BAD_VALUE, старое значение сохраняется, лог один раз', () => {
    store.update('B1/A1/State', 3);
    expect(store.update('B1/A1/State', 3.5)).toBe(true);
    expect(store.get('B1/A1/State')).toMatchObject({ value: 3, quality: 'bad', code: 'BAD_VALUE' });
    store.update('B1/A1/State', 'x');
    expect(logger.lines.error).toHaveLength(1);
    store.update('B1/A1/State', 4);
    expect(store.get('B1/A1/State')).toMatchObject({ value: 4, quality: 'good', code: null });
    store.update('B1/A1/State', -1);
    expect(logger.lines.error).toHaveLength(2);
  });

  test('неверная пара качество/код отклоняется', () => {
    expect(store.update('B1/A1/Run', true, { quality: 'good', code: 'STALE' })).toBe(false);
    expect(store.update('B1/A1/Run', true, { quality: 'bad', code: 'STALE' })).toBe(false);
    expect(store.update('B1/A1/Run', true, { quality: 'bad', code: 'NOPE' })).toBe(false);
    expect(store.get('B1/A1/Run').code).toBe('NOT_CONNECTED');
    expect(logger.lines.error).toHaveLength(3);
  });

  test('неизвестный тег — false без исключения', () => {
    expect(store.update('B1/X/Y', 1)).toBe(false);
    expect(store.setQuality('B1/X/Y', 'bad', 'COMM_ERROR')).toBe(false);
    expect(store.get('B1/X/Y')).toBeUndefined();
  });

  test('подписка по префиксу установки и отписка', () => {
    const ids = [];
    const off = store.subscribe((c) => ids.push(c.id), { prefix: 'B1/A1/' });
    store.update('B1/A1/Run', true);
    store.update('B1/A2/Temp', 1);
    off();
    store.update('B1/A1/Run', false);
    expect(ids).toEqual(['B1/A1/Run']);
  });

  test('ошибка подписчика не мешает остальным и драйверу', () => {
    const good = jest.fn();
    store.subscribe(() => { throw new Error('сбой подписчика'); });
    store.subscribe(good);
    expect(store.update('B1/A1/Run', true)).toBe(true);
    expect(good).toHaveBeenCalledTimes(1);
    expect(logger.lines.error[0]).toMatch(/ошибка подписчика.*сбой подписчика/);
  });

  test('snapshot: все, по списку, по префиксу; get возвращает копию', () => {
    store.update('B1/A2/Temp', 7);
    expect(store.snapshot().map((s) => s.id)).toEqual([...TAGS.keys()]);
    expect(store.snapshot({ ids: ['B1/A2/Temp', 'nope'] })).toEqual([expect.objectContaining({ id: 'B1/A2/Temp', value: 7 })]);
    expect(store.snapshot({ prefix: 'B1/A1/' })).toHaveLength(3);
    const copy = store.get('B1/A2/Temp');
    copy.value = 99;
    expect(store.get('B1/A2/Temp').value).toBe(7);
    expect(store.tag('B1/A2/Temp').dataType).toBe('Float');
    expect(store.has('B1/A2/Temp')).toBe(true);
  });
});

describe('tagStore.fitsType', () => {
  test.each([
    ['Boolean', true, true], ['Boolean', 1, false],
    ['Int16', -32768, true], ['Int16', 32768, false], ['Int16', 1.5, false],
    ['UInt16', 65535, true], ['UInt16', -1, false],
    ['Int32', -2147483648, true], ['UInt32', 4294967295, true], ['UInt32', 4294967296, false],
    ['Float', 1.5, true], ['Float', NaN, false], ['Double', Infinity, false], ['Float', '1', false],
    ['String', 'abc', true], ['String', 'x'.repeat(4097), false], ['String', 1, false],
  ])('%s %p → %s', (type, v, ok) => {
    expect(fitsType(type, v)).toBe(ok);
  });
});
