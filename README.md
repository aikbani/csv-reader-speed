# csv-reader-speed

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/aikbani/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/aikbani/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's csv-reader 1.0.0, entered on
[make.fun](https://make.fun/?ref=kzp9rfbw&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121).

`run(input)` returns exactly what csv-reader 1.0.0 returns for the same
`{text, header}`: `{columns, rows, errors}` — the header (or `null`), every
other record as an array of strings at the first record's width, and a record
of every broken thing met. The text is read once, left to right, commas and
double quotes, a U+FEFF dropped at the very start.

## How it is faster

The reference walks one character at a time and builds each field a
character at a time. This reader jumps instead: one regex search finds the
next separator (comma, CR, or LF), `indexOf` finds the next quote, and
`slice` cuts the field out whole, so a plain field costs a search, not a
walk. A record whose first line holds no quote and no stray CR is cut faster
still: the whole line split on commas at once. The only character-at-a-time
work left is counting line breaks inside a quoted field — and only when that
field actually holds one.

## The broken-row policy, kept exactly

- A record ends at LF or CRLF; a line left with no characters is no record.
- Outside quotes a CR not followed by LF is dropped (`stray_cr`).
- A field that opens with a quote runs to the next quote that is not doubled;
  `""` inside it is one quote, each CRLF or lone CR inside it is read as LF.
  What follows its closing quote, up to the next comma or line break, is
  appended as it stands (`quote_junk`, when the field ends). A quote that
  never closes is a literal character, and the text after it is read again as
  unquoted (`unterminated_quote`). A quote inside an unquoted field is a
  literal character. Fields stay strings, never trimmed or converted.
- `columns` is the first record when `header` is true, else `null`; `rows`
  holds the records after it, each padded with empty strings (`short_row`,
  with `fields`: its field count) or cut (`long_row`, with `extra`: the cut
  fields) to the first record's width.
- Each error is `{code, line, row}`, in the order met: `line` the 1-based
  line its record starts on, counting every LF, CRLF and lone CR inside
  quotes, and `row` its record's index in `rows`, `null` for the header.

## Layout

- `solve.js` — the reader. `run(input)` is the whole entry.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`,
  answers each case with `run`, writes `/output/answers.json`.

No dependencies, no build step, no WebAssembly, no native addon, no
prebuilt binary. Node 22 runs `node main.ts` as it ships.

## License

MIT — see [LICENSE](LICENSE).
