// csv-reader-speed: a faster drop-in for make.fun's csv-reader 1.0.0.
//
// Same answers as the reference on every case, read the same way — one pass,
// left to right, commas and double quotes, a U+FEFF dropped at the very
// start — but where the reference walks one character at a time and builds
// each field a character at a time, this reader jumps instead: one regex
// search finds the next separator, indexOf finds the next quote, and slice
// cuts each field out whole, so a plain field costs a search, not a walk.
// A record whose first line holds no quote and no stray CR is cut faster
// still: the whole line split on commas at once.
//
// The broken-row policy is the reference's own, kept exactly:
//   - a record ends at LF or CRLF; a line left with no characters is no
//     record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote, each CRLF or lone CR inside it one
//     LF; what follows its closing quote, up to the next comma or line
//     break, is appended as it stands (quote_junk, when the field ends);
//   - a quote that never closes is a literal character, and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded (short_row) or cut (long_row) to the
//     first record's width;
//   - each error is {code, line, row} in the order met, line the 1-based line
//     its record starts on, row its record's index in rows (null: the header).
//
// How a field ends: 0 at a comma (the record goes on), 1 at a line break
// (the record ends), 2 at the end of the text (the record ends).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error names these two, never the line or
  // row the reader has reached by the time the error is found.
  let recordLine = 1;
  let recordRow = null;

  // One scratch triple, reused by every field read: [value, ended, added].
  // A field's caller reads its slots before the next read, so no call ever
  // sees another's triple.
  const out = ['', 0, 0];

  // The next separator: a comma, a CR or an LF. One search, not three.
  const SEP = /[,\r\n]/g;
  // The next quote or line break, for the plain-line fast path.
  const QNL = /["\n]/g;

  // Reads unquoted characters onto `value` up to the next comma or line
  // break, from the reader's current position: a CR not followed by LF is
  // dropped (stray_cr). `added` counts the characters kept after `value`'s
  // own (0 for a fresh field); it is returned so a caller can tell whether
  // anything followed a closing quote. Returns the scratch triple.
  function readUnquoted(value, added) {
    let start = pos; // the next kept run starts here
    let parts = null; // kept runs, only when a stray CR splits the field
    for (;;) {
      SEP.lastIndex = pos;
      const m = SEP.exec(text);
      if (m === null) {
        if (parts === null) value += text.slice(start, n);
        else {
          parts.push(text.slice(start, n));
          value += parts.join('');
        }
        added += n - start;
        pos = n;
        out[0] = value;
        out[1] = END;
        out[2] = added;
        return out;
      }
      const at = m.index;
      const ch = m[0];
      if (ch === ',') {
        if (parts === null) value += text.slice(start, at);
        else {
          parts.push(text.slice(start, at));
          value += parts.join('');
        }
        added += at - start;
        pos = at + 1;
        out[0] = value;
        out[1] = COMMA;
        out[2] = added;
        return out;
      }
      if (ch === '\n') {
        const end = at > start && text.charCodeAt(at - 1) === 13 ? at - 1 : at;
        if (parts === null) value += text.slice(start, end);
        else {
          parts.push(text.slice(start, end));
          value += parts.join('');
        }
        added += end - start;
        pos = at + 1;
        line += 1;
        out[0] = value;
        out[1] = LINE_BREAK;
        out[2] = added;
        return out;
      }
      // A CR: CRLF ends the record, a lone one is dropped (stray_cr).
      if (text.charCodeAt(at + 1) === 10) {
        if (parts === null) value += text.slice(start, at);
        else {
          parts.push(text.slice(start, at));
          value += parts.join('');
        }
        added += at - start;
        pos = at + 2;
        line += 1;
        out[0] = value;
        out[1] = LINE_BREAK;
        out[2] = added;
        return out;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (parts === null) parts = [];
      parts.push(text.slice(start, at));
      added += at - start;
      pos = at + 1;
      start = pos;
    }
  }

  // Reads a quoted field whose opening quote is at the reader's position.
  // Returns the scratch triple; a quote that never closes is a literal
  // character and the text after it is read again as unquoted.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let start = pos + 1; // the next kept run of the content starts here
    let parts = null; // kept runs and the doubled quotes, only when split
    let q = text.indexOf('"', start);
    for (;;) {
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"', 1);
      }
      if (text.charCodeAt(q + 1) === 34) {
        if (parts === null) parts = [];
        parts.push(text.slice(start, q), '"');
        start = q + 2;
        q = text.indexOf('"', start);
        continue;
      }
      break;
    }
    // The closing quote is at q; the content is [open + 1, q) with each ""
    // one quote. Each CRLF or lone CR inside it is one LF, and each counts
    // one line.
    let raw;
    if (parts === null) raw = text.slice(open + 1, q);
    else {
      parts.push(text.slice(start, q));
      raw = parts.join('');
    }
    let value = raw;
    let breaks = 0;
    if (/[\n\r]/.test(raw)) {
      let i = raw.indexOf('\n');
      while (i !== -1) {
        breaks += 1;
        i = raw.indexOf('\n', i + 1);
      }
      if (raw.indexOf('\r') !== -1) {
        let j = raw.indexOf('\r');
        while (j !== -1) {
          if (raw.charCodeAt(j + 1) !== 10) breaks += 1;
          j = raw.indexOf('\r', j + 1);
        }
        value = raw.replace(/\r\n?/g, '\n');
      }
    }
    line += breaks;
    pos = q + 1;
    if (pos >= n) {
      out[0] = value;
      out[1] = END;
      out[2] = 0;
      return out;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      out[0] = value;
      out[1] = COMMA;
      out[2] = 0;
      return out;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      out[0] = value;
      out[1] = LINE_BREAK;
      out[2] = 0;
      return out;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      out[0] = value;
      out[1] = LINE_BREAK;
      out[2] = 0;
      return out;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value, 0);
    if (junk[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    let fields;
    // Fast path: a record with no quote and no stray CR on its first line
    // ends at that line's break, and its fields are the line split on
    // commas. A quoted field is what can run a record past its first line,
    // so a quoteless first line is a whole record.
    // Whichever comes first, a quote or a line break: a quote first means
    // this record needs the field loop; a line break first (or neither, to
    // the end of the text) means the record may be a plain line.
    QNL.lastIndex = pos;
    const qm = QNL.exec(text);
    const nl0 = qm === null || qm[0] === '"' ? -1 : qm.index;
    const lineEnd = qm === null ? n : qm.index;
    if (qm === null || qm[0] === '\n') {
      let segEnd = lineEnd;
      if (nl0 !== -1 && segEnd > pos && text.charCodeAt(segEnd - 1) === 13) segEnd -= 1;
      const cr0 = text.indexOf('\r', pos);
      if (cr0 === -1 || cr0 >= segEnd) {
        fields = text.slice(pos, segEnd).split(',');
        if (nl0 !== -1) line += 1;
        pos = nl0 === -1 ? n : nl0 + 1;
      }
    }
    if (fields === undefined) {
      fields = [];
      let field;
      let quoted;
      do {
        quoted = text.charCodeAt(pos) === 34;
        if (quoted) {
          field = readQuoted();
        } else {
          // Common case, inlined: the field ends at the next comma or line
          // break with no stray CR before it.
          SEP.lastIndex = pos;
          const m = SEP.exec(text);
          if (m !== null && m[0] === ',') {
            field = out;
            out[0] = text.slice(pos, m.index);
            out[1] = COMMA;
            out[2] = 0;
            pos = m.index + 1;
          } else if (m !== null && m[0] === '\n') {
            const at = m.index;
            const end = at > pos && text.charCodeAt(at - 1) === 13 ? at - 1 : at;
            field = out;
            out[0] = text.slice(pos, end);
            out[1] = LINE_BREAK;
            out[2] = 0;
            pos = at + 1;
            line += 1;
          } else if (m !== null && text.charCodeAt(m.index + 1) === 10) {
            // CRLF: the CR ends the field, the LF ends the record.
            field = out;
            out[0] = text.slice(pos, m.index);
            out[1] = LINE_BREAK;
            out[2] = 0;
            pos = m.index + 2;
            line += 1;
          } else {
            field = readUnquoted('', 0);
          }
        }
        fields.push(field[0]);
      } while (field[1] === COMMA);

      // A line that held only stray CRs is left with no characters: no record
      // (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
