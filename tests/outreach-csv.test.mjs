import test from 'node:test';
import assert from 'node:assert/strict';

import { CSV_COLUMNS, formatOutreachCsv } from '../src/outreach-csv.mjs';
const header = '"email","first_name","last_name","company_name","website","phone","pilot_subject_1","pilot_body_1","pilot_subject_2","pilot_body_2","pilot_subject_3","pilot_body_3"\r\n';
const columns = ['email', 'first_name', 'last_name', 'company_name', 'website', 'phone', 'pilot_subject_1', 'pilot_body_1', 'pilot_subject_2', 'pilot_body_2', 'pilot_subject_3', 'pilot_body_3'];

test('empty records produce the ordered header and formatting-only metadata', () => {
  assert.deepEqual(formatOutreachCsv([]), {
    csv: header,
    encoding: 'utf-8',
    columns,
    formattingOnly: true,
    spreadsheetConflicts: [],
  });
});

const record = Object.freeze({
  email: 'reader@example.invalid',
  pilot_subject_1: 'First subject', pilot_body_1: 'First body',
  pilot_subject_2: 'Second subject', pilot_body_2: 'Second body',
  pilot_subject_3: 'Third subject', pilot_body_3: 'Third body',
});

// Independent CSV reader for round-trip assertions, including quoted newlines.
function parseCsv(csv) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const character = csv[i];
    if (character === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && character === ',') {
      row.push(cell); cell = '';
    } else if (!quoted && character === '\r' && csv[i + 1] === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; i++;
    } else cell += character;
  }
  assert.equal(quoted, false, 'CSV must close every quoted field');
  assert.equal(cell, '', 'CSV must end with a CRLF record delimiter');
  return rows;
}

test('missing optional fields become empty cells without inventing contact data', () => {
  assert.equal(formatOutreachCsv([record]).csv, header + '"reader@example.invalid","","","","","","First subject","First body","Second subject","Second body","Third subject","Third body"\r\n');
});

test('quotes, commas, line endings, Unicode, whitespace and leading zeros remain literal', () => {
  const input = Object.freeze([Object.freeze({
    ...record, first_name: '  Zoë  ', last_name: '李', company_name: 'A, "B"',
    website: 'https://example.invalid/a?x=1&y=2', phone: '00102030',
    pilot_body_1: 'One\r\nTwo\nThree\rFour', pilot_body_2: '<p title="Hi">Hello, 世界 🌍</p>',
  })]);
  assert.equal(formatOutreachCsv(input).csv, header + '"reader@example.invalid","  Zoë  ","李","A, ""B""","https://example.invalid/a?x=1&y=2","00102030","First subject","One\r\nTwo\nThree\rFour","Second subject","<p title=""Hi"">Hello, 世界 🌍</p>","Third subject","Third body"\r\n');
});

test('independent parsing recovers exact cells in input order', () => {
  const input = Object.freeze([
    Object.freeze({ ...record, pilot_body_1: 'a,"b"\n\r\nc\rd' }),
    Object.freeze({ ...record, email: 'second@example.invalid', phone: '0007' }),
  ]);
  assert.deepEqual(parseCsv(formatOutreachCsv(input).csv), [
    columns,
    ['reader@example.invalid', '', '', '', '', '', 'First subject', 'a,"b"\n\r\nc\rd', 'Second subject', 'Second body', 'Third subject', 'Third body'],
    ['second@example.invalid', '', '', '', '', '0007', 'First subject', 'First body', 'Second subject', 'Second body', 'Third subject', 'Third body'],
  ]);
});

test('formatting is deterministic without mutating frozen inputs or shared columns', () => {
  const input = Object.freeze([record]);
  const first = formatOutreachCsv(input);
  assert.deepEqual(formatOutreachCsv(input), first);
  assert.equal(Object.isFrozen(CSV_COLUMNS), true);
  assert.throws(() => { CSV_COLUMNS[0] = 'changed'; }, TypeError);
  first.columns[0] = 'changed';
  assert.deepEqual(formatOutreachCsv(input).columns, columns);
  assert.equal(record.email, 'reader@example.invalid');
});

test('rejects non-array input and non-plain or sparse records', () => {
  for (const input of [undefined, null, {}, 'records']) assert.throws(() => formatOutreachCsv(input), /array/i);
  for (const item of [null, [], 'record', new Date(0), Object.create(record), Object.create(null)]) {
    assert.throws(() => formatOutreachCsv([item]), /row 1.*plain.*JSON/i);
  }
  assert.throws(() => formatOutreachCsv(new Array(1)), /row 1.*plain.*JSON/i);
});

test('requires email and every three-step subject/body without coercion', () => {
  for (const column of ['email', 'pilot_subject_1', 'pilot_body_1', 'pilot_subject_2', 'pilot_body_2', 'pilot_subject_3', 'pilot_body_3']) {
    const missing = { ...record }; delete missing[column];
    assert.throws(() => formatOutreachCsv([missing]), new RegExp(`row 1.*${column}.*nonempty string`, 'i'));
    for (const value of ['', null, false, 12, {}, []]) {
      assert.throws(() => formatOutreachCsv([{ ...record, [column]: value }]), new RegExp(`row 1.*${column}.*nonempty string`, 'i'));
    }
  }
});

test('optional fields must be strings when present', () => {
  for (const column of ['first_name', 'last_name', 'company_name', 'website', 'phone']) {
    for (const value of [undefined, null, 123, false, [], {}]) {
      assert.throws(() => formatOutreachCsv([{ ...record, [column]: value }]), new RegExp(`row 1.*${column}.*string`, 'i'));
    }
  }
});

test('rejects unknown fields without echoing their potentially private names or values', () => {
  assert.throws(() => formatOutreachCsv([{ ...record, 'private-key@example.invalid': 'private-value@example.invalid' }]), error => {
    assert.match(error.message, /row 1.*unknown field/i);
    assert.doesNotMatch(error.message, /private-|example\.invalid/);
    return true;
  });
  assert.throws(() => formatOutreachCsv([{ ...record, [Symbol('private')]: 'value' }]), /row 1.*unknown field/i);
});

test('rejects accessors and hidden fields without invoking input code', () => {
  let called = false;
  const accessor = { ...record };
  Object.defineProperty(accessor, 'phone', { enumerable: true, get() { called = true; return '0001'; } });
  assert.throws(() => formatOutreachCsv([accessor]), /row 1.*phone.*plain.*JSON/i);
  assert.equal(called, false);
  const hidden = { ...record };
  Object.defineProperty(hidden, 'phone', { value: '0001' });
  assert.throws(() => formatOutreachCsv([hidden]), /row 1.*phone.*plain.*JSON/i);
});

test('rejects invalid controls and unpaired surrogates without leaking cell values', () => {
  for (const invalid of ['\0', '\u0001', '\u0008', '\u000b', '\u000c', '\u000e', '\u001f', '\u007f', '\u0085', '\u009f', '\ud800', '\udfff']) {
    assert.throws(() => formatOutreachCsv([{ ...record, company_name: `private${invalid}value` }]), error => {
      assert.match(error.message, /row 1.*company_name.*invalid.*character/i);
      assert.doesNotMatch(error.message, /private|value/);
      return true;
    });
  }
});

test('flags formula prefixes including leading whitespace and invisible-character tricks without changing cells', () => {
  for (const value of ['=1+1', '+123', '-123', '@SUM(A1)', '  =1', '\t+1', '\r\n-1', '\u00a0@SUM(A1)', '\ufeff=1', '\u200b=1', '\u2060=1']) {
    const result = formatOutreachCsv([{ ...record, company_name: value }]);
    assert.deepEqual(result.spreadsheetConflicts, [{ row: 1, column: 'company_name', reason: 'formula_prefix' }]);
    assert.equal(parseCsv(result.csv)[1][3], value);
    assert.equal(result.formattingOnly, true);
  }
});

test('conflicts use stable one-based data rows and column order', () => {
  const result = formatOutreachCsv([record, { ...record, pilot_body_2: '=1', phone: '+1000' }]);
  assert.deepEqual(result.spreadsheetConflicts, [
    { row: 2, column: 'phone', reason: 'formula_prefix' },
    { row: 2, column: 'pilot_body_2', reason: 'formula_prefix' },
  ]);
});

test('ordinary HTML and formula symbols inside prose do not trigger conflicts', () => {
  for (const value of ['<p>Hello</p>', ' \r\n<p>Hi + hello = yes @ 2 - 1</p>', '<a href="mailto:reader@example.invalid">Hi</a>', 'Words =1+1', 'A\tB', '00100']) {
    const result = formatOutreachCsv([{ ...record, pilot_body_1: value }]);
    assert.deepEqual(result.spreadsheetConflicts, []);
    assert.equal(parseCsv(result.csv)[1][7], value);
  }
});
