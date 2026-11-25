'use strict';

const { buildBlocks } = require('../../drivers/modbusTcp/planner');

const e = (tagId, area, address, extra = {}) => ({
  tagId,
  unitId: extra.unitId || 1,
  byteOrder: 'ABCD',
  point: { area, address, type: area === 'coil' || area === 'discrete' ? 'bool' : 'uint16', ...extra.point },
});
const summary = (blocks) => blocks.map((b) => [b.unitId, b.area, b.address, b.length, b.items.map((i) => `${i.tagId}@${i.index}`)]);

describe('modbus planner', () => {
  test('соседние регистры — один блок, смещения точек', () => {
    const blocks = buildBlocks([
      e('c', 'holding', 102, { point: { type: 'float32' } }),
      e('a', 'holding', 100),
      e('b', 'holding', 101),
    ]);
    expect(summary(blocks)).toEqual([[1, 'holding', 100, 4, ['a@0', 'b@1', 'c@2']]]);
  });

  test('разрыв: до maxGap — один блок, больше — новый', () => {
    const list = [e('a', 'holding', 0), e('b', 'holding', 5), e('c', 'holding', 20)];
    expect(summary(buildBlocks(list, { maxGap: 4 }))).toEqual([
      [1, 'holding', 0, 6, ['a@0', 'b@5']],
      [1, 'holding', 20, 1, ['c@0']],
    ]);
    expect(buildBlocks(list, { maxGap: 0 })).toHaveLength(3);
    expect(buildBlocks(list, { maxGap: 100 })).toHaveLength(1);
  });

  test('биты одного регистра — одна точка чтения, в том числе при maxGap = -1', () => {
    const list = [
      e('b0', 'holding', 12, { point: { type: 'bool', bit: 0 } }),
      e('b5', 'holding', 12, { point: { type: 'bool', bit: 5 } }),
      e('r', 'holding', 13),
    ];
    expect(summary(buildBlocks(list, { maxGap: -1 }))).toEqual([
      [1, 'holding', 12, 1, ['b0@0', 'b5@0']],
      [1, 'holding', 13, 1, ['r@0']],
    ]);
  });

  test('области и unitId не смешиваются', () => {
    const blocks = buildBlocks([
      e('h', 'holding', 0), e('i', 'input', 1), e('c', 'coil', 0),
      e('h2', 'holding', 1, { unitId: 2 }),
    ], { maxGap: 10 });
    expect(summary(blocks).map((b) => [b[0], b[1]])).toEqual([[1, 'holding'], [1, 'input'], [1, 'coil'], [2, 'holding']]);
  });

  test('блок не длиннее 125 регистров и 2000 битов', () => {
    const regs = Array.from({ length: 130 }, (_, i) => e(`r${i}`, 'holding', i));
    expect(buildBlocks(regs).map((b) => b.length)).toEqual([125, 5]);
    // float32 на границе не разрезается
    const floats = [e('a', 'holding', 0), e('f', 'holding', 124, { point: { type: 'float32' } })];
    expect(buildBlocks(floats, { maxGap: 200 }).map((b) => [b.address, b.length])).toEqual([[0, 1], [124, 2]]);
    const bits = Array.from({ length: 2001 }, (_, i) => e(`c${i}`, 'coil', i));
    expect(buildBlocks(bits).map((b) => b.length)).toEqual([2000, 1]);
  });
});
