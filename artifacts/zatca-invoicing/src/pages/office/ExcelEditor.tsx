import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FileSpreadsheet, FolderOpen, Save, FileDown, FilePlus2, Plus, Trash2, Columns3, FileUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { openFile, saveFile, printHtml, withExtension, extractPdf, type OpenedFile } from "./fileIo";

const XLSX_ACCEPT = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.ms-excel": [".xls"],
};
const CSV_ACCEPT = { "text/csv": [".csv"] };
const PDF_ACCEPT = { "application/pdf": [".pdf"] };

interface SheetData {
  name: string;
  rows: string[][]; // array of arrays (header:1 layout)
}

const BLANK_COLS = 8;
const BLANK_ROWS = 20;

function blankSheet(name: string): SheetData {
  return {
    name,
    rows: Array.from({ length: BLANK_ROWS }, () => Array.from({ length: BLANK_COLS }, () => "")),
  };
}

// Normalise ragged AoA so every row has the same column count.
function rectify(rows: any[][]): string[][] {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 1);
  return rows.map((r) => {
    const out: string[] = [];
    for (let c = 0; c < width; c++) out.push(r[c] == null ? "" : String(r[c]));
    return out;
  });
}

function colLabel(i: number): string {
  let s = "";
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export default function ExcelEditor() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language?.startsWith("ar") ?? true;
  const { toast } = useToast();

  const [sheets, setSheets] = useState<SheetData[]>([blankSheet(ar ? "ورقة 1" : "Sheet1")]);
  const [active, setActive] = useState(0);
  const [fileName, setFileName] = useState(ar ? "جدول جديد.xlsx" : "Untitled.xlsx");
  const [handle, setHandle] = useState<OpenedFile["handle"]>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const handleRef = useRef(handle);
  handleRef.current = handle;
  // Refs keep functional state updaters from reading stale `active`/`sheets`
  // closures under rapid tab switching + edits.
  const activeRef = useRef(active);
  activeRef.current = active;
  const sheetsRef = useRef(sheets);
  sheetsRef.current = sheets;

  const sheet = sheets[active] ?? sheets[0];

  const updateCell = (r: number, c: number, v: string) => {
    setSheets((prev) => {
      const idx = activeRef.current;
      const next = prev.slice();
      const s = { ...next[idx], rows: next[idx].rows.map((row) => row.slice()) };
      s.rows[r][c] = v;
      next[idx] = s;
      return next;
    });
    setDirty(true);
  };

  const mutateActive = (fn: (s: SheetData) => SheetData) => {
    setSheets((prev) => {
      const idx = activeRef.current;
      const next = prev.slice();
      next[idx] = fn({ ...next[idx], rows: next[idx].rows.map((row) => row.slice()) });
      return next;
    });
    setDirty(true);
  };

  const addRow = () => mutateActive((s) => ({ ...s, rows: [...s.rows, Array.from({ length: s.rows[0]?.length ?? BLANK_COLS }, () => "")] }));
  const removeRow = () => mutateActive((s) => (s.rows.length > 1 ? { ...s, rows: s.rows.slice(0, -1) } : s));
  const addCol = () => mutateActive((s) => ({ ...s, rows: s.rows.map((r) => [...r, ""]) }));
  const removeCol = () => mutateActive((s) => (s.rows[0]?.length > 1 ? { ...s, rows: s.rows.map((r) => r.slice(0, -1)) } : s));

  const addSheet = () => {
    let newIdx = 0;
    setSheets((prev) => {
      newIdx = prev.length;
      return [...prev, blankSheet(`${ar ? "ورقة" : "Sheet"}${prev.length + 1}`)];
    });
    setActive(newIdx);
    setDirty(true);
  };
  const removeSheet = () => {
    if (sheetsRef.current.length <= 1) return;
    const idx = activeRef.current;
    setSheets((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
    setActive((a) => Math.max(0, a - 1));
    setDirty(true);
  };

  const handleNew = () => {
    if (dirty && !window.confirm(ar ? "تجاهل التغييرات غير المحفوظة؟" : "Discard unsaved changes?")) return;
    setSheets([blankSheet(ar ? "ورقة 1" : "Sheet1")]);
    setActive(0);
    setFileName(ar ? "جدول جديد.xlsx" : "Untitled.xlsx");
    setHandle(null);
    setDirty(false);
  };

  const handleOpen = async () => {
    try {
      const opened = await openFile({
        accept: { ...XLSX_ACCEPT, ...CSV_ACCEPT },
        description: ar ? "جداول Excel و CSV" : "Excel & CSV spreadsheets",
      });
      if (!opened) return;
      setBusy(true);
      const XLSX: any = await import("xlsx");
      const buf = await opened.file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const loaded: SheetData[] = wb.SheetNames.map((name: string) => {
        const ws = wb.Sheets[name];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
        const rows = rectify(aoa.length ? aoa : [[""]]);
        return { name, rows };
      });
      setSheets(loaded.length ? loaded : [blankSheet(ar ? "ورقة 1" : "Sheet1")]);
      setActive(0);
      setFileName(opened.file.name);
      setHandle(opened.handle);
      setDirty(false);
    } catch (e: any) {
      toast({ title: ar ? "تعذّر فتح الملف" : "Could not open file", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleImportPdf = async () => {
    try {
      const opened = await openFile({
        accept: PDF_ACCEPT,
        description: ar ? "ملفات PDF" : "PDF files",
      });
      if (!opened) return;
      setBusy(true);
      const pages = await extractPdf(opened.file);
      const loaded: SheetData[] = pages
        .map((p, i) => ({
          name: `${ar ? "صفحة" : "Page"} ${i + 1}`,
          lines: p.lines,
        }))
        .filter((p) => p.lines.length > 0)
        .map((p) => ({ name: p.name, rows: rectify(p.lines.map((l) => l.cells)) }));
      if (!loaded.length) {
        toast({
          title: ar ? "لا يوجد نص قابل للاستخراج" : "No extractable text",
          description: ar
            ? "هذا الملف يبدو ممسوحاً ضوئياً (صورة). يتطلب تحويله ميزة OCR غير المتوفرة حالياً."
            : "This PDF appears to be scanned (image-only). Converting it needs OCR, which is not available yet.",
          variant: "destructive",
        });
        return;
      }
      setSheets(loaded);
      setActive(0);
      // Imported content has no original XLSX file → save creates a new one.
      setFileName(withExtension(opened.file.name, "xlsx"));
      setHandle(null);
      setDirty(true);
      toast({
        title: ar ? "تم استيراد PDF" : "PDF imported",
        description: ar ? "راجع الجدول ثم احفظه بصيغة Excel." : "Review the table, then save as Excel.",
      });
    } catch (e: any) {
      toast({ title: ar ? "تعذّر استيراد PDF" : "Could not import PDF", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const doSave = async (kind: "xlsx" | "csv", saveAs: boolean) => {
    try {
      setBusy(true);
      const XLSX: any = await import("xlsx");
      let blob: Blob;
      let suggested: string;
      let accept: Record<string, string[]>;
      if (kind === "csv") {
        const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
        const csv = XLSX.utils.sheet_to_csv(ws);
        blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
        suggested = withExtension(fileName, "csv");
        accept = CSV_ACCEPT;
      } else {
        const wb = XLSX.utils.book_new();
        sheets.forEach((s) => {
          const ws = XLSX.utils.aoa_to_sheet(s.rows);
          XLSX.utils.book_append_sheet(wb, ws, (s.name || "Sheet").slice(0, 31));
        });
        const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
        blob = new Blob([out], { type: XLSX_ACCEPT["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"][0] });
        suggested = withExtension(fileName, "xlsx");
        accept = { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] };
      }
      const sameKind = kind === "xlsx" ? fileName.toLowerCase().endsWith(".xlsx") : fileName.toLowerCase().endsWith(".csv");
      const res = await saveFile(blob, {
        suggestedName: suggested,
        accept,
        description: kind === "xlsx" ? "Excel" : "CSV",
        handle: saveAs || !sameKind ? null : handleRef.current,
      });
      if (res.saved) {
        if (res.handle) setHandle(res.handle);
        setFileName(suggested);
        setDirty(false);
        toast({ title: ar ? "تم الحفظ" : "Saved", description: suggested });
      }
    } catch (e: any) {
      toast({ title: ar ? "تعذّر الحفظ" : "Could not save", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handlePdf = () => {
    const head = sheet.rows[0] ?? [];
    const body = sheet.rows.slice(1);
    const html = `<h2>${escapeHtml(sheet.name)}</h2><table><thead><tr>${
      head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")
    }</tr></thead><tbody>${
      body.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")
    }</tbody></table>`;
    printHtml(html, { title: fileName, rtl: ar });
  };

  const colCount = sheet.rows[0]?.length ?? 0;

  return (
    <div className="p-4 sm:p-6 space-y-3" data-testid="page-office-excel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5 text-green-600" />
          {t("nav.officeExcel", { defaultValue: ar ? "محرر الجداول (Excel)" : "Spreadsheet Editor (Excel)" })}
          <span className="text-sm font-normal text-muted-foreground truncate max-w-[40vw]">
            — {fileName}{dirty ? " *" : ""}
          </span>
        </h1>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={handleNew} disabled={busy} data-testid="button-excel-new">
            <FilePlus2 className="h-4 w-4 ms-1" /> {ar ? "جديد" : "New"}
          </Button>
          <Button size="sm" variant="outline" onClick={handleOpen} disabled={busy} data-testid="button-excel-open">
            <FolderOpen className="h-4 w-4 ms-1" /> {ar ? "فتح" : "Open"}
          </Button>
          <Button size="sm" variant="outline" onClick={handleImportPdf} disabled={busy} data-testid="button-excel-importpdf">
            <FileUp className="h-4 w-4 ms-1" /> {ar ? "استيراد PDF" : "Import PDF"}
          </Button>
          <Button size="sm" onClick={() => doSave("xlsx", false)} disabled={busy} data-testid="button-excel-save">
            <Save className="h-4 w-4 ms-1" /> {ar ? "حفظ XLSX" : "Save XLSX"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => doSave("xlsx", true)} disabled={busy} data-testid="button-excel-saveas">
            {ar ? "حفظ باسم" : "Save As"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => doSave("csv", true)} disabled={busy} data-testid="button-excel-savecsv">
            {ar ? "حفظ CSV" : "Save CSV"}
          </Button>
          <Button size="sm" variant="outline" onClick={handlePdf} disabled={busy} data-testid="button-excel-pdf">
            <FileDown className="h-4 w-4 ms-1" /> PDF
          </Button>
        </div>
      </div>

      <Card className="p-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={addRow} data-testid="button-excel-addrow"><Plus className="h-4 w-4 ms-1" /> {ar ? "صف" : "Row"}</Button>
        <Button size="sm" variant="outline" onClick={removeRow} data-testid="button-excel-delrow"><Trash2 className="h-4 w-4 ms-1" /> {ar ? "صف" : "Row"}</Button>
        <Button size="sm" variant="outline" onClick={addCol} data-testid="button-excel-addcol"><Columns3 className="h-4 w-4 ms-1" /> {ar ? "عمود" : "Col"}</Button>
        <Button size="sm" variant="outline" onClick={removeCol} data-testid="button-excel-delcol"><Trash2 className="h-4 w-4 ms-1" /> {ar ? "عمود" : "Col"}</Button>
        <span className="text-xs text-muted-foreground ms-2">{sheet.rows.length} × {colCount}</span>
      </Card>

      <Card className="p-0 overflow-auto max-h-[60vh]">
        <table className="border-collapse text-sm" dir="ltr" data-testid="grid-excel">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="bg-muted border border-border w-10 text-xs text-muted-foreground sticky start-0 z-20" />
              {Array.from({ length: colCount }, (_, c) => (
                <th key={c} className="bg-muted border border-border px-2 py-1 text-xs font-semibold text-muted-foreground min-w-[6rem]">
                  {colLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, r) => (
              <tr key={r}>
                <td className="bg-muted border border-border text-center text-xs text-muted-foreground sticky start-0 z-10">{r + 1}</td>
                {Array.from({ length: colCount }, (_, c) => (
                  <td key={c} className="border border-border p-0">
                    <input
                      value={row[c] ?? ""}
                      onChange={(e) => updateCell(r, c, e.target.value)}
                      dir="auto"
                      className="w-full min-w-[6rem] px-2 py-1 bg-transparent outline-none focus:bg-blue-50 focus:ring-1 focus:ring-blue-400"
                      data-testid={`cell-${r}-${c}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="flex flex-wrap items-center gap-1">
        {sheets.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setActive(i)}
            className={`px-3 py-1 text-sm rounded-t border-b-2 ${
              i === active ? "border-green-600 font-semibold bg-card" : "border-transparent text-muted-foreground hover:bg-muted"
            }`}
            data-testid={`tab-sheet-${i}`}
          >
            {s.name}
          </button>
        ))}
        <button type="button" onClick={addSheet} title={ar ? "إضافة ورقة" : "Add sheet"} className="px-2 py-1 rounded hover:bg-muted" data-testid="button-add-sheet">
          <Plus className="h-4 w-4" />
        </button>
        {sheets.length > 1 && (
          <button type="button" onClick={removeSheet} title={ar ? "حذف الورقة" : "Delete sheet"} className="px-2 py-1 rounded hover:bg-muted text-red-600" data-testid="button-del-sheet">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
