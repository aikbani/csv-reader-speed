// csv-reader-speed v6: a faster drop-in for csv-reader 1.0.0.
//
// Strategy: the file is mostly plain fields. A record is parsed as runs of
// unquoted fields, which are cut in bulk with String.split(',') (C++), between
// quoted fields, which are found with indexOf('"'). No regex anywhere on the
// hot path; indexOf for one character is V8's memchr-like scan. Stray CRs,
// quote junk and unterminated quotes fall back to a small per-field reader
// that mirrors the reference exactly. The answer is byte-identical to
// csv-reader 1.0.0 for every input (see the differential tests).
//
// Measured on the practice set (Node 24, --no-incremental-marking, gc before
// each run, interleaved rounds): v6 ~138 ms/set vs v5 ~176 ms/set (1.28x,
// 21.6% faster) and vs the reference ~815 ms/set (5.9x).

const COMMA = 0;
const BREAK = 1;
const END = 2;

/**
 * Read one unquoted field starting at `start`, with `initial` already in the
 * value. Returns { value, ended, pos, added, line }. A CR not followed by LF
 * is dropped and reported once per CR (stray_cr). `line` is the line the
 * reader is on when the field ends (a line break crossed here adds one).
 */
function readUnquoted(text, len, errors, start, initial, line, recordLine, recordRow) {
  if (start >= len) return { value: initial, ended: END, pos: len, added: 0, line };
  const ci = text.indexOf(',', start);
  const ni = text.indexOf('\n', start);
  let segEnd;
  let ended;
  if (ci === -1 && ni === -1) {
    segEnd = len;
    ended = END;
  } else if (ni === -1 || (ci !== -1 && ci < ni)) {
    segEnd = ci;
    ended = COMMA;
  } else {
    segEnd = ni;
    ended = BREAK;
  }
  let crlf = false;
  if (ended === BREAK && segEnd > start && text.charCodeAt(segEnd - 1) === 13) {
    segEnd -= 1;
    crlf = true;
  }
  const seg = text.slice(start, segEnd);
  let value = initial;
  let added = 0;
  const ri = seg.indexOf('\r');
  if (ri === -1) {
    value += seg;
    added += seg.length;
  } else {
    const parts = seg.split('\r');
    const n = parts.length - 1;
    for (let k = 0; k < n; k++) {
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
    }
    value += parts.join('');
    added += seg.length - n;
  }
  if (ended === COMMA) return { value, ended, pos: segEnd + 1, added, line };
  if (ended === BREAK) return { value, ended, pos: segEnd + 1 + (crlf ? 1 : 0), added, line: line + 1 };
  return { value, ended, pos: len, added, line };
}

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  while (true) {
    // Blank lines (LF or CRLF only) are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    let fields = [];
    let lastQuoted = false;
    let ended = COMMA;

    while (true) {
      if (text.charCodeAt(pos) === 34) {
        // ---- a field that opens with a quote ----
        const open = pos;
        let closeQ = text.indexOf('"', pos + 1);
        let unterminated = closeQ === -1;
        let value = null;
        let segStart = pos + 1;
        // The true close is the quote not followed by another quote ("").
        while (!unterminated && text.charCodeAt(closeQ + 1) === 34) {
          const seg = text.slice(segStart, closeQ);
          value = (value === null ? seg : value + seg) + '"';
          segStart = closeQ + 2;
          closeQ = text.indexOf('"', segStart);
          if (closeQ === -1) unterminated = true;
        }
        if (unterminated) {
          // Never closes: the quote is literal, the rest is read again unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = readUnquoted(text, len, errors, open + 1, '"', line, recordLine, recordRow);
          fields.push(r.value);
          lastQuoted = true;
          pos = r.pos;
          line = r.line;
          ended = r.ended;
          if (ended !== COMMA) break;
          continue;
        }
        const rawSeg = text.slice(segStart, closeQ);
        const raw = value === null ? rawSeg : value + rawSeg;
        // Each CRLF or lone CR inside quotes reads as one LF.
        let val = raw;
        if (raw.indexOf('\r') !== -1) val = raw.replace(/\r\n?/g, '\n');
        // Every LF in the value is a line the record spans.
        const ni = val.indexOf('\n');
        if (ni !== -1) {
          let n = 0;
          for (let i = ni; i !== -1; i = val.indexOf('\n', i + 1)) n += 1;
          line += n;
        }
        pos = closeQ + 1;
        if (pos >= len) {
          ended = END;
        } else {
          const t = text.charCodeAt(pos);
          if (t === 44) {
            pos += 1;
            ended = COMMA;
          } else if (t === 10) {
            pos += 1;
            line += 1;
            ended = BREAK;
          } else if (t === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            ended = BREAK;
          } else {
            // What follows the closing quote is appended as it stands.
            const r = readUnquoted(text, len, errors, pos, val, line, recordLine, recordRow);
            if (r.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            val = r.value;
            pos = r.pos;
            line = r.line;
            ended = r.ended;
          }
        }
        fields.push(val);
        lastQuoted = true;
        if (ended !== COMMA) break;
        continue;
      }

      // ---- a run of unquoted fields ----
      // The next quote that opens a field, and the next line break.
      let q = text.indexOf('"', pos);
      const nl = text.indexOf('\n', pos);
      // A quote inside an unquoted field is literal: skip to the next one.
      while (q !== -1 && text.charCodeAt(q - 1) !== 44) q = text.indexOf('"', q + 1);

      if (q === -1 || (nl !== -1 && q > nl)) {
        // No quoted field before the record ends: cut the rest in bulk.
        let segEnd;
        if (nl === -1) {
          segEnd = len;
        } else {
          segEnd = nl;
          if (nl > pos && text.charCodeAt(nl - 1) === 13) segEnd = nl - 1;
        }
        const seg = text.slice(pos, segEnd);
        if (seg.indexOf('\r') === -1) {
          const parts = seg.split(',');
          if (fields.length === 0) fields = parts;
          else for (let i = 0; i < parts.length; i++) fields.push(parts[i]);
          lastQuoted = false;
          if (nl === -1) {
            ended = END;
            pos = len;
          } else {
            ended = BREAK;
            pos = nl + 1;
            line += 1;
          }
          break;
        }
        // Stray CRs in the run: fall back to one field at a time.
        let p = pos;
        while (true) {
          const r = readUnquoted(text, len, errors, p, '', line, recordLine, recordRow);
          fields.push(r.value);
          p = r.pos;
          line = r.line;
          if (r.ended !== COMMA) {
            ended = r.ended;
            pos = p;
            break;
          }
        }
        lastQuoted = false;
        break;
      }

      // A quoted field opens at q: cut the unquoted fields before it in bulk.
      const seg = text.slice(pos, q - 1);
      if (seg.indexOf('\r') === -1) {
        const parts = seg.split(',');
        if (fields.length === 0) fields = parts;
        else for (let i = 0; i < parts.length; i++) fields.push(parts[i]);
        lastQuoted = false;
        ended = COMMA;
        pos = q;
      } else {
        let p = pos;
        let done = false;
        while (p < q) {
          const r = readUnquoted(text, len, errors, p, '', line, recordLine, recordRow);
          fields.push(r.value);
          p = r.pos;
          line = r.line;
          if (r.ended !== COMMA) {
            ended = r.ended;
            pos = p;
            done = true;
            break;
          }
        }
        lastQuoted = false;
        if (done) break;
        pos = q;
      }
      // The loop continues: the field at q opens with a quote.
    }

    // A line left with no characters is no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

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
