import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Upload, FileSpreadsheet, Download, AlertTriangle, CheckCircle2 } from "lucide-react";
import * as XLSX from "xlsx";
import { saveWorkbook } from "@/lib/saveFile";
import { trialBalancesApi, type ImportLine } from "@/lib/trialBalancesApi";

// Header aliases — case-insensitive, whitespace/RTL-mark/NBSP-normalized
// at lookup time. Any new variant we encounter from a real exported
// file should be added here. Many Saudi/Egyptian ERP exports use
// "رصيد مدين"/"رصيد دائن" or "إجمالي مدين"/"إجمالي دائن", and English
// templates often use "Debit/Credit Amount" variants.
const HEADER_MAP: Record<string, keyof ImportLine> = {
  // Arabic — code
  "كود الحساب":     "accountCode",
  "كود":            "accountCode",
  "الكود":          "accountCode",
  "رقم الحساب":     "accountCode",
  "رمز الحساب":     "accountCode",
  // Arabic — name
  "اسم الحساب":     "accountName",
  "الحساب":         "accountName",
  "البيان":         "accountName",
  "وصف الحساب":     "accountName",
  "الوصف":          "accountName",
  // Arabic — debit (incl. our own export's "أصلي" / "معدل" variants)
  "مدين":           "debit",
  "رصيد مدين":      "debit",
  "إجمالي مدين":    "debit",
  "اجمالي مدين":    "debit",
  "المدين":         "debit",
  "مدين رصيد":      "debit",
  "مدين اصلي":      "debit",
  "مدين أصلي":      "debit",
  "اصلي مدين":      "debit",
  "أصلي مدين":      "debit",
  "مدين معدل":      "debit",
  "مدين معدّل":     "debit",
  "معدل مدين":      "debit",
  "مدين بعد التعديل": "debit",
  // Arabic — credit
  "دائن":           "credit",
  "رصيد دائن":      "credit",
  "إجمالي دائن":    "credit",
  "اجمالي دائن":    "credit",
  "الدائن":         "credit",
  "دائن رصيد":      "credit",
  "دائن اصلي":      "credit",
  "دائن أصلي":      "credit",
  "اصلي دائن":      "credit",
  "أصلي دائن":      "credit",
  "دائن معدل":      "credit",
  "دائن معدّل":     "credit",
  "معدل دائن":      "credit",
  "دائن بعد التعديل": "credit",
  // English — code
  "code":           "accountCode",
  "accountcode":    "accountCode",
  "account code":   "accountCode",
  "account_code":   "accountCode",
  "account no":     "accountCode",
  "account number": "accountCode",
  // English — name
  "name":           "accountName",
  "accountname":    "accountName",
  "account name":   "accountName",
  "account_name":   "accountName",
  "description":    "accountName",
  // English — debit
  "debit":          "debit",
  "debit amount":   "debit",
  "debit balance":  "debit",
  "dr":             "debit",
  // English — credit
  "credit":         "credit",
  "credit amount":  "credit",
  "credit balance": "credit",
  "cr":             "credit",
};

// Normalize a header cell so the same map entry matches across
// whitespace/diacritic variations: strip BOM/RTL/LTR marks + NBSP +
// Arabic tashkeel (fatha/kasra/damma/sukun/shadda/tanween, U+064B–
// U+065F and U+0670) + tatweel (ـ U+0640), collapse whitespace,
// lowercase. So "رصيد مدين", "رصيد  مدين ", "مدين معدّل",
// "مدين معدل", "Debit Amount", "DEBIT AMOUNT" all collapse to the
// same canonical key.
function normalizeHeader(s: string): string {
  return s
    .replace(/[\uFEFF\u200B-\u200F\u202A-\u202E\u00A0]/g, " ")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const NORMALIZED_HEADER_MAP: Record<string, keyof ImportLine> =
  Object.fromEntries(Object.entries(HEADER_MAP).map(([k, v]) => [normalizeHeader(k), v]));

// Robust amount parser tuned for Saudi/Arabic XLSX trial-balance
// exports while still tolerating other locales. Handles:
//   • Native JS numbers (preferred path when xlsx returns numerics).
//   • Arabic-Indic digits (٠-٩, U+0660–U+0669) and Eastern variants
//     (۰-۹, U+06F0–U+06F9).
//   • Arabic decimal separator ٫ (U+066B) and Arabic thousands ٬ (U+066C).
//   • Western thousands/decimal "1,234.56" AND European "1.234,56" /
//     "1234,56" via a "last-separator wins" decimal heuristic.
//   • Whitespace-as-thousands ("1 234,56") and Swiss apostrophes ("1'234").
//   • Currency labels in Arabic (ر.س, ج.م, د.إ, د.ك) and Latin (SAR, SR,
//     EGP, AED, USD, $, €, £, ¥, ₹) anywhere in the cell, even when
//     surrounding parenthesized accounting negatives like "(1,000) SAR".
//   • Accounting-style negatives: "(1,000.00)" or trailing "-".
//   • Scientific notation ("1E3" → 1000) and signed forms ("+12.34").
//   • Bidi/format marks (LRM/RLM/PDF/NBSP/ZWNBSP) sprinkled by exports.
function parseAmount(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  let s = String(v);
  // 1. Strip bidi/format/zero-width marks and NBSP variants.
  s = s.replace(/[\uFEFF\u200B-\u200F\u202A-\u202E\u00A0]/g, "");
  s = s.trim();
  if (!s) return 0;
  // 2. Normalize Arabic numerals & separators to ASCII equivalents
  //    BEFORE we strip Arabic letters — otherwise digits would be lost.
  s = s.replace(/[\u0660-\u0669]/g, ch => String(ch.charCodeAt(0) - 0x0660));
  s = s.replace(/[\u06F0-\u06F9]/g, ch => String(ch.charCodeAt(0) - 0x06F0));
  s = s.replace(/\u066B/g, ".").replace(/\u066C/g, ",");
  // 3. Strip Arabic/Hebrew letter sequences AND any dots that sit
  //    between them (so "ر.س", "ر.س.", "ج.م", "د.إ" disappear as a
  //    whole unit — leaving the leading dot behind would be parsed as
  //    a stray decimal point and would corrupt the real value).
  //    Matches one-or-more "(letter)(optional .)" chunks; safe because
  //    we already mapped Arabic-Indic digits to ASCII in step 2.
  s = s.replace(/(?:[\u0600-\u06FF\u0750-\u077F\u0590-\u05FF]\.?)+/g, "");
  s = s.replace(/\b(?:SAR|SR|EGP|USD|AED|KWD|EUR|GBP|JPY|QAR|BHD|OMR)\b/gi, "");
  s = s.replace(/[$€£¥₹]/g, "");
  // 4. Drop any residual non-numeric characters EXCEPT separators,
  //    parens, signs, e-notation, whitespace, apostrophe.
  s = s.replace(/[^\d.,\s'()+\-eE]/g, "").trim();
  if (!s) return 0;
  // 5. Parenthesized accounting negatives.
  let sign = 1;
  const paren = s.match(/^\(\s*(.+?)\s*\)$/);
  if (paren) { sign = -1; s = paren[1].trim(); }
  if (s.startsWith("-"))      { sign *= -1; s = s.slice(1).trim(); }
  else if (s.endsWith("-"))   { sign *= -1; s = s.slice(0, -1).trim(); }
  if (s.startsWith("+"))      { s = s.slice(1).trim(); }
  // 6. Strip whitespace (French thousands) and apostrophe (Swiss thousands).
  s = s.replace(/[\s']/g, "");
  if (!s) return 0;
  // 7. Pass scientific notation straight to Number().
  if (/^\d+(?:\.\d+)?[eE][+-]?\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? sign * n : 0;
  }
  // 8. Decide which separator is the decimal point.
  //    • Both present → the LAST one is decimal ("1,234.56" vs "1.234,56").
  //    • Single dot → decimal (Excel default; "1.234.567" with multiple
  //      dots reverts to "all thousands").
  //    • Single comma w/ exactly 3 digits after → English thousands
  //      ("1,234"); otherwise European decimal ("1234,56").
  const lastDot   = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimalSep: "." | "," | null = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalSep = lastDot > lastComma ? "." : ",";
  } else if (lastDot >= 0) {
    decimalSep = (s.match(/\./g) || []).length === 1 ? "." : null;
  } else if (lastComma >= 0) {
    const commas = (s.match(/,/g) || []).length;
    if (commas === 1) {
      const afterComma = s.length - lastComma - 1;
      decimalSep = afterComma === 3 ? null : ",";
    } else {
      decimalSep = null;
    }
  }
  if      (decimalSep === ".") s = s.replace(/,/g, "");
  else if (decimalSep === ",") s = s.replace(/\./g, "").replace(/,/g, ".");
  else                          s = s.replace(/[,.]/g, "");
  if (!s || s === "." || s === "-" || s === "+") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : 0;
}

function parseFile(file: File): Promise<ImportLine[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        // raw:true → keep native numbers as numbers (the parser handles
        // both numeric and string forms). defval:"" → no missing keys.
        const json: any[] = XLSX.utils.sheet_to_json(ws, { defval: "", raw: true });
        const rows: ImportLine[] = json.map(row => {
          const out: any = {};
          // For amount columns we may see two synonyms in the same row
          // (e.g. "مدين أصلي" + "مدين معدّل" — original AND adjusted).
          // Don't let an empty/zero column overwrite a real non-zero
          // value that an earlier column already supplied. For non-
          // amount fields (code/name) plain last-wins is fine.
          for (const [k, v] of Object.entries(row)) {
            const key = NORMALIZED_HEADER_MAP[normalizeHeader(String(k))];
            if (!key) continue;
            if (key === "debit" || key === "credit") {
              const incoming = parseAmount(v);
              const existing = parseAmount(out[key]);
              if (out[key] === undefined || incoming !== 0 || existing === 0) {
                out[key] = v;
              }
            } else {
              out[key] = v;
            }
          }
          out.accountCode = String(out.accountCode ?? "")
            .replace(/[\uFEFF\u200B-\u200F\u202A-\u202E\u00A0]/g, "")
            .trim();
          out.accountName = String(out.accountName ?? "")
            .replace(/[\uFEFF\u200B-\u200F\u202A-\u202E\u00A0]/g, "")
            .trim() || undefined;
          out.debit  = parseAmount(out.debit);
          out.credit = parseAmount(out.credit);
          return out as ImportLine;
        }).filter(r => r.accountCode);
        resolve(rows);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function downloadTemplate(t: (k: string) => string) {
  const aoa = [
    ["كود الحساب", "اسم الحساب", "مدين", "دائن"],
    ["1110001",   "الصندوق",      10000, 0],
    ["2110001",   "الموردون",     0,     5000],
    ["4110001",   "إيرادات بيع",  0,     8000],
    ["5110001",   "مصروفات إدارية", 3000, 0],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Trial Balance");
  void saveWorkbook(wb, `قالب-ميزان-المراجعة-${new Date().toISOString().slice(0,10)}.xlsx`);
}

interface Props {
  trialBalanceId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
}

export default function TrialBalanceImportDialog({ trialBalanceId, open, onOpenChange, onImported }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ImportLine[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [replace, setReplace] = useState(true);

  const importMut = useMutation({
    mutationFn: () => trialBalancesApi.importLines(trialBalanceId, parsed, replace),
    onSuccess: (r) => {
      toast({
        title: t("trialBalanceMaintenance.importSuccess"),
        description: t("trialBalanceMaintenance.importSuccessDesc", { count: r.count }),
      });
      qc.invalidateQueries({ queryKey: ["trial-balance", trialBalanceId] });
      onImported?.();
      onOpenChange(false);
      setParsed([]); setFileName("");
    },
    onError: (e: any) => toast({ title: t("common.error"), description: String(e?.message || e), variant: "destructive" }),
  });

  async function handleFile(file: File) {
    try {
      const rows = await parseFile(file);
      setParsed(rows);
      setFileName(file.name);
      if (rows.length === 0) {
        toast({ title: t("trialBalanceMaintenance.noRowsFound"), variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: t("common.error"), description: String(e?.message || e), variant: "destructive" });
    }
  }

  const totalD = parsed.reduce((s, r) => s + Number(r.debit  ?? 0), 0);
  const totalC = parsed.reduce((s, r) => s + Number(r.credit ?? 0), 0);
  const balanced = Math.abs(totalD - totalC) < 0.01;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            {t("trialBalanceMaintenance.importDialogTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <Alert>
            <FileSpreadsheet className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between gap-2">
              <span>{t("trialBalanceMaintenance.importHint")}</span>
              <Button size="sm" variant="outline" onClick={() => downloadTemplate(t)} data-testid="btn-download-template">
                <Download className="h-4 w-4 me-1" />
                {t("trialBalanceMaintenance.downloadTemplate")}
              </Button>
            </AlertDescription>
          </Alert>

          <div className="border-2 border-dashed rounded-md p-6 text-center">
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              data-testid="input-import-file"
              onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
            <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground mb-2">{t("trialBalanceMaintenance.dropFileHint")}</p>
            <Button variant="outline" onClick={() => fileRef.current?.click()} data-testid="btn-pick-file">
              {t("trialBalanceMaintenance.pickFile")}
            </Button>
            {fileName && <p className="text-xs mt-2 text-muted-foreground">{fileName} — {parsed.length} {t("trialBalanceMaintenance.rows")}</p>}
          </div>

          {parsed.length > 0 && (
            <>
              <div className="flex items-center justify-between text-sm bg-muted/30 p-2 rounded">
                <div className="flex items-center gap-3">
                  <span><strong>{t("trialBalanceMaintenance.totalDebit")}:</strong> {totalD.toFixed(2)}</span>
                  <span><strong>{t("trialBalanceMaintenance.totalCredit")}:</strong> {totalC.toFixed(2)}</span>
                  {balanced
                    ? <span className="text-green-600 flex items-center gap-1"><CheckCircle2 className="h-4 w-4" /> {t("trialBalanceMaintenance.balanced")}</span>
                    : <span className="text-red-600 flex items-center gap-1"><AlertTriangle className="h-4 w-4" /> {t("trialBalanceMaintenance.unbalanced", { diff: (totalD-totalC).toFixed(2) })}</span>
                  }
                </div>
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} data-testid="check-replace" />
                  {t("trialBalanceMaintenance.replaceExisting")}
                </label>
              </div>

              <div className="border rounded-md max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="text-start p-2">{t("trialBalanceMaintenance.code")}</th>
                      <th className="text-start p-2">{t("trialBalanceMaintenance.accountName")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.debit")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.credit")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.slice(0, 200).map((r, i) => (
                      <tr key={i} className="border-t">
                        <td className="p-1 font-mono">{r.accountCode}</td>
                        <td className="p-1">{r.accountName ?? "—"}</td>
                        <td className="p-1 text-end font-mono">{Number(r.debit ?? 0).toFixed(2)}</td>
                        <td className="p-1 text-end font-mono">{Number(r.credit ?? 0).toFixed(2)}</td>
                      </tr>
                    ))}
                    {parsed.length > 200 && (
                      <tr><td colSpan={4} className="p-2 text-center text-muted-foreground">… +{parsed.length - 200} {t("trialBalanceMaintenance.moreRows")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            data-testid="btn-import-confirm"
            disabled={parsed.length === 0 || importMut.isPending}
            onClick={() => importMut.mutate()}
          >
            {importMut.isPending ? t("common.saving") : t("trialBalanceMaintenance.importNow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
