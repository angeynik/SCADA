// opcua/values.js
// Значения тегов в переменные OPC UA: текущее значение при запуске и далее каждое
// опубликованное изменение tagStore (мёртвая зона уже применена в tagStore).
// Качество → StatusCode по core/quality.js (toOpcUaStatus); время источника → SourceTimestamp.
// Значения ещё нет (null) — Variant Null с плохим StatusCode.
'use strict';

const { DataType, StatusCodes, Variant } = require('node-opcua');
const { toOpcUaStatus } = require('../core/quality');

function toDataValueParts(tag, state) {
  const variant = state.value === null
    ? new Variant({ dataType: DataType.Null })
    : new Variant({ dataType: DataType[tag.dataType], value: state.value });
  const status = StatusCodes[toOpcUaStatus(state.quality, state.code)];
  const sourceTs = state.sourceTs === null ? null : new Date(state.sourceTs);
  return { variant, status, sourceTs };
}

// Возвращает функцию отписки
function bindValues({ variables, tagStore, logger }) {
  const apply = (id, state) => {
    const variable = variables.get(id);
    if (!variable) return;
    const { variant, status, sourceTs } = toDataValueParts(tagStore.tag(id), state);
    try {
      variable.setValueFromSource(variant, status, sourceTs || undefined);
    } catch (err) {
      logger.logErrorMessage(`[OpcUa] - bindValues - ${id}:`, err);
    }
  };
  for (const s of tagStore.snapshot()) apply(s.id, s);
  return tagStore.subscribe((change) => apply(change.id, change));
}

module.exports = { bindValues, toDataValueParts };
