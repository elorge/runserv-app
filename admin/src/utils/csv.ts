// Tiny CSV export for what is currently on screen (the API has no report endpoints yet).
export type CsvCell = string | number | null | undefined;

const esc = (v: CsvCell) => {
  let s = v == null ? '' : String(v);
  // Stop spreadsheet apps from running a cell that starts like a formula.
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (rows: CsvCell[][]) => rows.map((r) => r.map(esc).join(',')).join('\r\n');

export const downloadCsv = (filename: string, rows: CsvCell[][]) => {
  const blob = new Blob(['\uFEFF' + toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
