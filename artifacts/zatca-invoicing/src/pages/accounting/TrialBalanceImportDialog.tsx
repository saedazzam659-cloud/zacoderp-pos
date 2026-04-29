import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Upload, FileSpreadsheet, Download, AlertTriangle, CheckCircle2 } from "lucide-react";
import * as XLSX from "xlsx";
import { trialBalancesApi, type ImportLine } from "@/lib/trialBalancesApi";

const HEADER_MAP: Record<string, keyof ImportLine> = {
  // Arabic
  "كود الحساب":   "accountCode",
  "كود":          "accountCode",
  "الكود":        "accountCode",
  "اسم الحساب":   "accountName",
  "الحساب":       "accountName",
  "البيان":       "accountName",
  "مدين":         "debit",
  "دائن":         "credit",
  // English
  "code":         "accountCode",
  "accountCode":  "accountCode",
  "account_code": "accountCode",
  "name":         "accountName",
  "accountName":  "accountName",
  "account_name": "accountName",
  "debit":        "debit",
  "credit":       "credit",
};

function parseFile(file: File): Promise<ImportLine[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json: any[] = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
        const rows: ImportLine[] = json.map(row => {
          const out: any = {};
          for (const [k, v] of Object.entries(row)) {
            const key = HEADER_MAP[String(k).trim()];
            if (key) out[key] = v;
          }
          out.accountCode = String(out.accountCode ?? "").trim();
          out.accountName = String(out.accountName ?? "").trim() || undefined;
          out.debit  = Number(String(out.debit  ?? "0").replace(/,/g, "")) || 0;
          out.credit = Number(String(out.credit ?? "0").replace(/,/g, "")) || 0;
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
  XLSX.writeFile(wb, `قالب-ميزان-المراجعة-${new Date().toISOString().slice(0,10)}.xlsx`);
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
