// tools/lib/csv.js
// Разбор CSV (RFC 4180): кавычки, удвоенные кавычки, переводы строк внутри кавычек.
// Разделитель определяется по первой строке: «;» (Excel с русской локалью) или «,».
// BOM в начале файла (Excel) отбрасывается. Возвращает строки как массивы полей
// с номером строки файла: [{ line, fields }]. Пустые строки пропускаются.
'use strict';

function detectDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length - 1;
  return count(';') >= count(',') ? ';' : ',';
}

function parseCsv(input, { delimiter } = {}) {
  const text = String(input).replace(/^﻿/, '');
  const sep = delimiter || detectDelimiter(text);
  const rows = [];
  let fields = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;

  const endField = () => { fields.push(field); field = ''; };
  const endRow = () => {
    endField();
    if (fields.some((f) => f.trim() !== '')) rows.push({ line: rowLine, fields });
    fields = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) endField();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
      rowLine = line;
    } else field += ch;
  }
  if (quoted) throw new Error(`строка ${rowLine}: незакрытая кавычка`);
  if (field !== '' || fields.length) endRow();
  return rows;
}

module.exports = { parseCsv, detectDelimiter };
