import {writingMode,FIRST_TOUCH_CONTRACT} from './writing-mode.mjs';

export const CSV_COLUMNS = Object.freeze([
  'email', 'first_name', 'last_name', 'company_name', 'website', 'phone',
  'pilot_subject_1', 'pilot_body_1', 'pilot_subject_2', 'pilot_body_2', 'pilot_subject_3', 'pilot_body_3',
]);

export const FIRST_TOUCH_CSV_COLUMNS = Object.freeze(CSV_COLUMNS.slice(0,8));

export function formatOutreachCsv(records, options={}) {
  if (!options || Object.getPrototypeOf(options)!==Object.prototype || Object.keys(options).some(k=>k!=='contractVersion')) throw new TypeError('CSV_UNKNOWN_OPTION');
  const columns=writingMode(options)===FIRST_TOUCH_CONTRACT?FIRST_TOUCH_CSV_COLUMNS:CSV_COLUMNS;
  if (!Array.isArray(records)) throw new TypeError('Records must be an array of plain JSON objects');
  const rows = [columns]; const spreadsheetConflicts = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]; const row = index + 1;
    if (!record || Object.getPrototypeOf(record) !== Object.prototype) {
      throw new TypeError(`Row ${row} must be a plain JSON object`);
    }
    const fields = Object.getOwnPropertyDescriptors(record);
    for (const column of Reflect.ownKeys(fields)) {
      if (!columns.includes(column)) throw new TypeError(`Row ${row} contains an unknown field; use only the documented CSV columns`);
      if (!fields[column].enumerable || !Object.hasOwn(fields[column], 'value')) {
        throw new TypeError(`Row ${row}, ${column} must be a plain JSON field`);
      }
    }
    rows.push(columns.map(column => {
      const required = column === 'email' || column.startsWith('pilot_');
      const value = Object.hasOwn(fields, column) ? fields[column].value : required ? undefined : '';
      if (typeof value !== 'string' || (required && value.length === 0)) {
        throw new TypeError(`Row ${row}, ${column} must be ${required ? 'a nonempty string' : 'a string when present'}`);
      }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) {
        throw new TypeError(`Row ${row}, ${column} contains an invalid character; use valid Unicode without unsupported control characters`);
      }
      if (/^[\s\p{Cf}]*[=+@-]/u.test(value)) spreadsheetConflicts.push({ row, column, reason: 'formula_prefix' });
      return value;
    }));
  }
  return {
    csv: rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n',
    encoding: 'utf-8',
    columns: [...columns],
    formattingOnly: true,
    spreadsheetConflicts,
  };
}
