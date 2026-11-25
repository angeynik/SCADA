// drivers/modbusTcp/planner.js
// План опроса: точки одного контроллера объединяются в блоки — один запрос на блок.
// Блок — подряд идущие адреса одной области (и одного unitId); между точками
// допускается разрыв не больше maxGap слов (лишние регистры читаются и отбрасываются).
// Длина блока ограничена протоколом: 125 регистров или 2000 битов за запрос.
// maxGap < 0 — объединяются только точки, перекрывающие друг друга (биты одного регистра):
// так строится план «по одной точке», когда контроллер отвергает блок.
//
// Вход: [{ tagId, unitId, byteOrder, point }]. Выход: [{ unitId, area, address, length,
// items: [{ tagId, byteOrder, point, index }] }], index — смещение точки в ответе.
'use strict';

const { pointSize, isBitArea } = require('./codec');

const MAX_REGISTERS = 125;
const MAX_BITS = 2000;

function buildBlocks(entries, { maxGap = 0 } = {}) {
  const groups = new Map();
  for (const e of entries) {
    const key = `${e.unitId}|${e.point.area}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const blocks = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.point.address - b.point.address || pointSize(b.point) - pointSize(a.point));
    const maxLen = isBitArea(list[0].point.area) ? MAX_BITS : MAX_REGISTERS;
    let block = null;
    for (const e of list) {
      const start = e.point.address;
      const end = start + pointSize(e.point);
      const blockEnd = block ? block.address + block.length : 0;
      // При maxGap = -1 условие разрыва означает start < blockEnd — перекрытие
      const fits = block
        && start - blockEnd <= Math.max(maxGap, -1)
        && Math.max(end, blockEnd) - block.address <= maxLen;
      if (!fits) {
        block = { unitId: e.unitId, area: e.point.area, address: start, length: 0, items: [] };
        blocks.push(block);
      }
      block.length = Math.max(block.length, end - block.address);
      block.items.push({ tagId: e.tagId, byteOrder: e.byteOrder, point: e.point, index: start - block.address });
    }
  }
  return blocks;
}

module.exports = { buildBlocks, MAX_REGISTERS, MAX_BITS };
