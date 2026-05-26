// Convert the EDA pharmacy CSV into a styled .xlsx workbook.
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const inPath = path.join('attached_assets', 'eda_pharmacy_catalog_2026.csv');
const outPath = path.join('attached_assets', 'eda_pharmacy_catalog_2026.xlsx');

let csv = fs.readFileSync(inPath, 'utf8');
if (csv.charCodeAt(0) === 0xfeff) csv = csv.slice(1);

const wb = XLSX.read(csv, { type: 'string', raw: false });
const ws = wb.Sheets[wb.SheetNames[0]];

ws['!cols'] = [
  { wch: 12 }, { wch: 42 }, { wch: 36 }, { wch: 16 }, { wch: 10 }, { wch: 8 },
  { wch: 32 }, { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 10 },
];
ws['!freeze'] = { xSplit: 0, ySplit: 1 };
if (!ws['!sheetViews']) ws['!sheetViews'] = [{}];
ws['!sheetViews'][0].rightToLeft = true;

const outWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(outWb, ws, 'الأدوية');
XLSX.writeFile(outWb, outPath, { bookType: 'xlsx' });

const stat = fs.statSync(outPath);
const rows = XLSX.utils.sheet_to_json(ws).length;
console.log(`✓ ${outPath}`);
console.log(`  rows: ${rows}  size: ${(stat.size / 1024).toFixed(1)} KB`);
