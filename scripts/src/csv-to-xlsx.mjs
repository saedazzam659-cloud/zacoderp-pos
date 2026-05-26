// Convert the grocery CSV into a styled .xlsx workbook.
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const inPath = path.join('attached_assets', 'grocery_items_egypt.csv');
const outPath = path.join('attached_assets', 'grocery_items_egypt.xlsx');

let csv = fs.readFileSync(inPath, 'utf8');
if (csv.charCodeAt(0) === 0xfeff) csv = csv.slice(1);

const wb = XLSX.read(csv, { type: 'string', raw: false });
const ws = wb.Sheets[wb.SheetNames[0]];

// Force RTL + column widths + freeze header
ws['!cols'] = [
  { wch: 12 }, // code
  { wch: 42 }, // nameAr
  { wch: 36 }, // nameEn
  { wch: 16 }, // barcode
  { wch: 12 }, // salePrice
  { wch: 10 }, // vatRate
];
ws['!freeze'] = { xSplit: 0, ySplit: 1 };
if (!ws['!sheetViews']) ws['!sheetViews'] = [{}];
ws['!sheetViews'][0].rightToLeft = true;

// Rename sheet to Arabic
const outWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(outWb, ws, 'الأصناف');

XLSX.writeFile(outWb, outPath, { bookType: 'xlsx' });

const stat = fs.statSync(outPath);
const rows = XLSX.utils.sheet_to_json(ws).length;
console.log(`✓ ${outPath}`);
console.log(`  rows: ${rows}  size: ${(stat.size / 1024).toFixed(1)} KB`);
