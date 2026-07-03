import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as XLSX from "xlsx";
import { saveWorkbook } from "@/lib/saveFile";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HistoricalMigration } from "./HistoricalMigration";
import {
  Database, Upload, Download, FileSpreadsheet, FileJson, Sparkles, AlertTriangle,
  CheckCircle2, X, Eye, ArrowLeft, ArrowRight, Loader2, FileDown, Copy, Printer,
} from "lucide-react";
import { DateField } from "@/components/ui/date-field";
import { safeLogoSrc } from "@/lib/export";
import {
  fetchEntities, exportData, analyzeImport, processImport, commitImport, downloadBlob,
  type EntityCatalogItem, type AnalyzeResult, type ProcessResult, type CommitResult, type RowIssue,
} from "@/lib/dataIoApi";

type Step = "upload" | "analyze" | "review" | "result";

function entityLabel(e: EntityCatalogItem | undefined, isAr: boolean): string {
  if (!e) return "";
  return isAr ? (e.labelAr ?? e.labelEn ?? e.key) : (e.labelEn ?? e.labelAr ?? e.key);
}
function fieldLabel(f: { labelAr?: string; labelEn?: string; name: string }, isAr: boolean): string {
  return isAr ? (f.labelAr ?? f.labelEn ?? f.name) : (f.labelEn ?? f.labelAr ?? f.name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Nested-bundle adapters
// ─────────────────────────────────────────────────────────────────────────────
// Real-world Saudi/Arabic ERPs (e.g. exports labelled "exported_data") often
// ship a single multi-table JSON bundle keyed by their internal table names
// (AccountingEntry, AccountingEntryDetailes, Account, Currency, Branch, …)
// instead of the flat `journalEntries: [...]` shape our importer expects.
//
// `adaptNestedBundle` recognises those bundles and flattens them into the
// canonical row shape for the chosen entity. One branch per importable tile
// in the /settings/data-io UI: accounts, customers, suppliers, items,
// warehouses, branches, cashBoxes, bankAccounts, journalEntries.
//
// Returns `null` when the bundle is not recognised → caller falls back to the
// existing direct/loose shape detection.
function adaptNestedBundle(json: any, entityKey: string): any[] | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;

  // ── Defensive: support tables may be present as non-array shapes (e.g.
  //    a single object or null sentinel). Coerce to [] before iterating so
  //    the adapter never throws "X is not iterable" on adversarial input.
  const liveOf = (v: any): any[] => Array.isArray(v) ? v : [];
  const isLive = (r: any): boolean => !r?.IsDeleted;
  const trim = (v: any): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };

  // Currency lookup is shared by suppliers / bankAccounts / journalEntries.
  // The source's basic_currency row represents SAR in 99% of Saudi dumps
  // regardless of its `code` field (often "1").
  const currencyById = new Map<number, { code: string; basic: boolean }>();
  for (const c of liveOf(json.Currency)) {
    if (!isLive(c)) continue;
    if (c?.currence_id != null) {
      currencyById.set(Number(c.currence_id), {
        code: String(c.code ?? ""),
        basic: !!c.basic_currency,
      });
    }
  }
  const currencyCodeFor = (id: any): string => {
    if (id == null) return "SAR";
    const c = currencyById.get(Number(id));
    if (!c) return "SAR";
    return c.basic ? "SAR" : (c.code || "SAR");
  };

  switch (entityKey) {
    // ──────────────────────────────────────────────────────────────────────
    case "accounts": {
      if (!Array.isArray(json.Account)) return null;

      const groupById = new Map<number, any>();
      for (const g of liveOf(json.AccountGroup)) {
        if (!isLive(g)) continue;
        if (g?.ID != null) groupById.set(Number(g.ID), g);
      }
      // accountId → code, used to resolve ParentID into parentCode.
      const accountIdToCode = new Map<number, string>();
      for (const a of json.Account) {
        if (!isLive(a)) continue;
        const code = trim(a?.code);
        if (a?.AccountID != null && code) accountIdToCode.set(Number(a.AccountID), code);
      }
      // Infer the importer's enum {asset|liability|equity|revenue|expense}.
      // Source uses both تاء مربوطة and هاء (ميزانية/ميزانيه, قائمة/قائمه)
      // and may include the definite article ال (قائمة الدخل).
      //
      // IMPORTANT: for income-statement accounts (قائمة دخل) the AccountGroup
      // name alone is unreliable — Saudi charts often nest BOTH revenue (CR)
      // and expense (DR) accounts under one parent group called "حساب الدخل"
      // ("income account"). For those rows we trust the State column directly
      // (CR → revenue, DR → expense). All other rows fall through to the
      // group-name regexes (asset/liability/equity/expense/revenue) and then
      // to a State + isBS final default.
      const inferType = (a: any): string => {
        const at = String(a?.AccountType ?? "");
        const isIS = /قائم[ةه]\s*(?:ال)?دخل/.test(at) || /\bincome\s+statement\b/i.test(at);
        const isBS = /ميزاني[ةه]/.test(at) || /\bbalance\s+sheet\b/i.test(at);
        if (isIS) {
          if (a?.State === "CR") return "revenue";
          if (a?.State === "DR") return "expense";
        }
        const g = a?.AccountGroupID != null ? groupById.get(Number(a.AccountGroupID)) : null;
        const text = `${g?.arabic_name ?? ""} ${g?.english_name ?? ""}`.toLowerCase();
        if (/أصول|asset/.test(text)) return "asset";
        if (/خصوم|التزامات|مطلوبات|liabilit/.test(text)) return "liability";
        if (/حقوق|ملكية|رأس\s*المال|equity|capital/.test(text)) return "equity";
        if (/مصروف|تكاليف|تكلفة|expense|cost/.test(text)) return "expense";
        if (/إيراد|ايراد|مبيعات|revenue|income|sales/.test(text)) return "revenue";
        if (a?.State === "DR") return isBS ? "asset" : "expense";
        if (a?.State === "CR") return isBS ? "liability" : "revenue";
        return "asset";
      };

      const rows: any[] = [];
      for (const a of json.Account) {
        if (!isLive(a)) continue;
        const code = trim(a?.code);
        if (!code) continue;
        rows.push({
          code,
          nameAr: trim(a?.arabic_name) ?? trim(a?.english_name),
          nameEn: trim(a?.english_name),
          accountType: inferType(a),
          parentCode: a?.ParentID != null ? (accountIdToCode.get(Number(a.ParentID)) ?? null) : null,
          reportDirection: /ميزاني[ةه]/.test(String(a?.AccountType ?? "")) ? "balance_sheet" : "income_statement",
          level: typeof a?.Level === "number" ? a.Level : 1,
          isPosting: !a?.AccountShutdown,
          isActive: !a?.NotActive,
          notes: null,
        });
      }
      // Importer resolves parentCode FK per-row inside one transaction, so
      // parents must be inserted before children: sort by level ASC, code ASC.
      rows.sort((x, y) => (x.level - y.level) || x.code.localeCompare(y.code));
      return rows;
    }

    // ──────────────────────────────────────────────────────────────────────
    case "customers": {
      if (!Array.isArray(json.Clients)) return null;
      const rows: any[] = [];
      for (const c of json.Clients) {
        if (!isLive(c)) continue;
        const nameAr = trim(c?.name) ?? trim(c?.nick_name);
        if (!nameAr) continue;
        rows.push({
          nameAr,
          nameEn: null,
          vatNumber: trim(c?.tax_number),
          // NB: the source schema has the typo `record_numbe` (no trailing r).
          crNumber: trim(c?.record_numbe) ?? trim(c?.record_number),
          email: trim(c?.email1) ?? trim(c?.email2),
          phone: trim(c?.mobile1) ?? trim(c?.phone1) ?? trim(c?.mobile2) ?? trim(c?.phone2),
          city: null,
          district: null,
          street: trim(c?.address),
          buildingNumber: null,
          postalCode: null,
          country: "SA",
        });
      }
      return rows;
    }

    // ──────────────────────────────────────────────────────────────────────
    case "suppliers": {
      if (!Array.isArray(json.Vendors)) return null;
      const rows: any[] = [];
      for (const v of json.Vendors) {
        if (!isLive(v)) continue;
        const nameAr = trim(v?.vendor_name) ?? trim(v?.nick_name);
        if (!nameAr) continue;
        const nick = trim(v?.nick_name);
        rows.push({
          code: trim(v?.code),
          nameAr,
          nameEn: nick && nick !== nameAr ? nick : null,
          vatNumber: trim(v?.tax_file_number),
          crNumber: trim(v?.record_number),
          email: trim(v?.e_mail),
          phone: trim(v?.mobile) ?? trim(v?.phone1) ?? trim(v?.phone2),
          city: null,
          country: "SA",
          currencyCode: currencyCodeFor(v?.CurrencyID),
          openingBalance: null,
          creditLimit: null,
        });
      }
      return rows;
    }

    // ──────────────────────────────────────────────────────────────────────
    case "items": {
      if (!Array.isArray(json.Item)) return null;
      const rows: any[] = [];
      for (const i of json.Item) {
        if (!isLive(i)) continue;
        const code = trim(i?.item_code);
        const nameAr = trim(i?.arabic_name) ?? trim(i?.english_name);
        if (!code || !nameAr) continue;
        const typeStr = String(i?.item_type ?? "").toLowerCase();
        const isService = typeStr.includes("service") || typeStr.includes("خدم");
        rows.push({
          code,
          nameAr,
          nameEn: trim(i?.english_name),
          barcode: trim(i?.bar_code),
          itemType: isService ? "service" : "stock",
          costPrice: Number(i?.main_cost ?? i?.current_cost ?? i?.last_cost ?? 0) || 0,
          salePrice: Number(i?.defult_price ?? 0) || 0,
          vatRate: typeof i?.TaxDefaultRatio === "number" ? i.TaxDefaultRatio : 15,
          reorderLevel: null,
          description: trim(i?.Description),
        });
      }
      return rows;
    }

    // ──────────────────────────────────────────────────────────────────────
    case "warehouses": {
      if (!Array.isArray(json.Stores)) return null;
      const rows: any[] = [];
      for (const s of json.Stores) {
        if (!isLive(s)) continue;
        const code = trim(s?.code);
        if (!code) continue;
        // The source's `negativeAllowance` is a free-text setting; "لاشـئ"
        // ("nothing", with extra tatweel chars) means no negative stock.
        const negText = String(s?.negativeAllowance ?? "");
        const allowNegative = negText.trim() !== "" && !negText.includes("لاش");
        rows.push({
          code,
          nameAr: trim(s?.arabic_name) ?? trim(s?.english_name),
          nameEn: trim(s?.english_name),
          city: null,
          region: null,
          isActive: !s?.inactive,
          allowNegative,
        });
      }
      return rows;
    }

    // ──────────────────────────────────────────────────────────────────────
    case "branches": {
      if (!Array.isArray(json.Branch)) return null;
      const rows: any[] = [];
      for (const b of json.Branch) {
        if (!isLive(b)) continue;
        const code = trim(b?.code);
        if (!code) continue;
        rows.push({
          code,
          nameAr: trim(b?.arabic_name) ?? trim(b?.english_name),
          nameEn: trim(b?.english_name),
          city: trim(b?.city),
          address: trim(b?.address),
          phone: trim(b?.phone),
          email: trim(b?.email),
          isMain: !!b?.IsDefault,
        });
      }
      return rows;
    }

    // ──────────────────────────────────────────────────────────────────────
    case "cashBoxes": {
      if (!Array.isArray(json.Treasury)) return null;
      const rows: any[] = [];
      for (const t of json.Treasury) {
        if (!isLive(t)) continue;
        const code = trim(t?.code);
        if (!code) continue;
        rows.push({
          code,
          nameAr: trim(t?.arabic_name) ?? trim(t?.english_name),
          nameEn: trim(t?.english_name),
          // Treasury rows in this source carry no currencyID; default to SAR
          // and let the user override during the column-mapping step if needed.
          currencyCode: "SAR",
        });
      }
      return rows;
    }

    // ──────────────────────────────────────────────────────────────────────
    case "bankAccounts": {
      if (!Array.isArray(json.Bank_Account)) return null;
      const rows: any[] = [];
      for (const b of json.Bank_Account) {
        if (!isLive(b)) continue;
        // Bank_Account has no separate `code` column → synthesise one from
        // the surrogate id so every row meets the importer's required field.
        const code = b?.id != null ? `BA-${b.id}` : null;
        const nameAr = trim(b?.arabic_name) ?? trim(b?.english_name);
        if (!code || !nameAr) continue;
        rows.push({
          code,
          nameAr,
          nameEn: trim(b?.english_name),
          accountNumber: trim(b?.accountNum),
          currencyCode: currencyCodeFor(b?.currencyID),
        });
      }
      return rows;
    }

    // ──────────────────────────────────────────────────────────────────────
    case "journalEntries": {
      if (!Array.isArray(json.AccountingEntry) || !Array.isArray(json.AccountingEntryDetailes)) return null;

      // Build lookup maps from the supporting tables.
      const accountById = new Map<number, string>();
      for (const a of liveOf(json.Account)) {
        if (!isLive(a)) continue;
        if (a?.AccountID != null && a?.code != null) {
          accountById.set(Number(a.AccountID), String(a.code));
        }
      }
      const branchById = new Map<number, string>();
      for (const b of liveOf(json.Branch)) {
        if (!isLive(b)) continue;
        if (b?.branch_id != null && b?.code != null) {
          branchById.set(Number(b.branch_id), String(b.code));
        }
      }
      const headerById = new Map<number, any>();
      for (const h of json.AccountingEntry) {
        if (!isLive(h)) continue;
        if (h?.AccountingEntryID != null) {
          headerById.set(Number(h.AccountingEntryID), h);
        }
      }

      // ── Disambiguate docNumber: the backend importer groups lines by
      //    docNumber alone, so two different AccountingEntryIDs that happen to
      //    share the same SerialNumberValue would otherwise be merged into one
      //    journal entry (silent corruption). Pre-scan serials and force the
      //    AE-<id> form for any serial that isn't unique across live headers.
      const serialCounts = new Map<string, number>();
      for (const h of headerById.values()) {
        const raw = h?.SerialNumberValue;
        if (raw != null && String(raw).trim() !== "") {
          const s = String(raw).trim();
          serialCounts.set(s, (serialCounts.get(s) ?? 0) + 1);
        }
      }
      const docNumberFor = (h: any): string => {
        const raw = h?.SerialNumberValue;
        const s = raw != null ? String(raw).trim() : "";
        if (!s || (serialCounts.get(s) ?? 0) > 1) return `AE-${h.AccountingEntryID}`;
        return s;
      };

      const rows: any[] = [];
      for (const ln of json.AccountingEntryDetailes) {
        if (!isLive(ln)) continue;
        if (ln?.AccountingEntryID == null) continue;
        const h = headerById.get(Number(ln.AccountingEntryID));
        if (!h) continue; // orphan or soft-deleted header
        const accCode = ln.AccountID != null ? accountById.get(Number(ln.AccountID)) : undefined;
        if (!accCode) continue; // can't post a line without a known account code

        const currency = currencyCodeFor(h.CurrencyID);
        const branchCode = h.branch_id != null ? (branchById.get(Number(h.branch_id)) ?? null) : null;
        const dateStr = h.Date ? String(h.Date).slice(0, 10) : null;

        rows.push({
          docNumber: docNumberFor(h),
          entryDate: dateStr,
          description: h.Description ?? null,
          currency,
          exchangeRate: h.ExchangeRate ?? 1,
          entryType: "general",
          branchCode,
          status: "draft",
          accountCode: accCode,
          debit: ln.DR ?? 0,
          credit: ln.CR ?? 0,
          lineDescription: ln.Description ?? null,
          costCenter: null,
        });
      }
      return rows;
    }
  }

  return null;
}

export default function DataImportExport() {
  const { token, user } = useAuth() as any;
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isAr = i18n.language?.startsWith("ar");
  const cid: number | undefined = user?.company?.id ?? user?.companyId ?? undefined;

  // Open on the tab named in ?tab= (the Excel editor sends ?tab=import when
  // handing off a sheet to the journal-entries importer).
  const [tab, setTab] = useState<string>(() => {
    try { return new URLSearchParams(window.location.search).get("tab") || "export"; } catch { return "export"; }
  });

  const { data: entities = [], isLoading: entitiesLoading } = useQuery({
    queryKey: ["data-io-entities"],
    queryFn: () => fetchEntities(token),
    enabled: !!token,
  });

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6" dir={isAr ? "rtl" : "ltr"}>
      <header className="flex items-center gap-3">
        <Database className="w-7 h-7 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">{t("dataIO.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("dataIO.subtitle")}</p>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} dir={isAr ? "rtl" : "ltr"}>
        <TabsList className="grid grid-cols-3 max-w-2xl">
          <TabsTrigger value="export"><Download className="w-4 h-4 ml-2" /> {t("dataIO.tabExport")}</TabsTrigger>
          <TabsTrigger value="import"><Upload className="w-4 h-4 ml-2" /> {t("dataIO.tabImport")}</TabsTrigger>
          <TabsTrigger value="historical"><Database className="w-4 h-4 ml-2" /> الترحيل التاريخي</TabsTrigger>
        </TabsList>

        <TabsContent value="export" className="mt-4">
          <ExportPanel entities={entities} loading={entitiesLoading} cid={cid} token={token} toast={toast} />
        </TabsContent>

        <TabsContent value="import" className="mt-4">
          <ImportWizard entities={entities} loading={entitiesLoading} cid={cid} token={token} toast={toast} isAr={isAr} />
        </TabsContent>

        <TabsContent value="historical" className="mt-4">
          <HistoricalMigration entities={entities} cid={cid} token={token} toast={toast} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// EXPORT PANEL
// ════════════════════════════════════════════════════════════════════════════

function ExportPanel({ entities, loading, cid, token, toast }: {
  entities: EntityCatalogItem[]; loading: boolean; cid?: number; token: string | null; toast: any;
}) {
  const { t, i18n } = useTranslation();
  const isAr = i18n.language?.startsWith("ar");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<"json" | "xlsx">("xlsx");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (entities.length && selected.size === 0) {
      setSelected(new Set(entities.map((e) => e.key)));
    }
  }, [entities]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (k: string) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  };
  const selectAll = () => setSelected(new Set(entities.map((e) => e.key)));
  const selectNone = () => setSelected(new Set());

  const onExport = async () => {
    if (!cid) { toast({ title: t("dataIO.noCompany"), variant: "destructive" }); return; }
    if (selected.size === 0) { toast({ title: t("dataIO.selectAtLeastOne"), variant: "destructive" }); return; }
    setBusy(true);
    try {
      const blob = await exportData(token, { companyId: cid, types: Array.from(selected), format });
      const ext = format === "json" ? "json" : "xlsx";
      downloadBlob(blob, `data-export-${new Date().toISOString().slice(0, 10)}.${ext}`);
      toast({ title: t("dataIO.downloadSuccess") });
    } catch (e: any) {
      toast({ title: e.message ?? t("dataIO.exportFailed"), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("dataIO.exportChooseTitle")}</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={selectAll} disabled={loading}>{t("dataIO.selectAll")}</Button>
          <Button variant="outline" size="sm" onClick={selectNone} disabled={loading}>{t("dataIO.selectNone")}</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {loading && <div className="col-span-full text-center text-muted-foreground py-6">{t("dataIO.loading")}</div>}
        {entities.map((e) => (
          <label
            key={e.key}
            className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
              selected.has(e.key) ? "bg-primary/5 border-primary" : "hover:bg-muted/40"
            }`}
          >
            <input
              type="checkbox"
              className="w-4 h-4"
              checked={selected.has(e.key)}
              onChange={() => toggle(e.key)}
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{entityLabel(e, isAr)}</div>
              <div className="text-xs text-muted-foreground truncate">{isAr ? (e.labelEn ?? "") : (e.labelAr ?? "")}</div>
            </div>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 pt-4 border-t">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">{t("dataIO.formatLabel")}</span>
          <button
            onClick={() => setFormat("xlsx")}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${format === "xlsx" ? "bg-primary text-primary-foreground border-primary" : ""}`}
          >
            <FileSpreadsheet className="w-4 h-4" /> Excel
          </button>
          <button
            onClick={() => setFormat("json")}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${format === "json" ? "bg-primary text-primary-foreground border-primary" : ""}`}
          >
            <FileJson className="w-4 h-4" /> JSON
          </button>
        </div>
        <Button onClick={onExport} disabled={busy || selected.size === 0}>
          {busy ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <Download className="w-4 h-4 ml-2" />}
          {t("dataIO.downloadCount", { count: selected.size })}
        </Button>
      </div>
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// IMPORT WIZARD
// ════════════════════════════════════════════════════════════════════════════

function ImportWizard({ entities, loading, cid, token, toast, isAr }: {
  entities: EntityCatalogItem[]; loading: boolean; cid?: number; token: string | null; toast: any; isAr: boolean;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("upload");
  const [entityKey, setEntityKey] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [processed, setProcessed] = useState<ProcessResult | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const entity = entities.find((e) => e.key === entityKey);

  // Handoff from the Office Excel editor: a staged sheet in sessionStorage is
  // auto-loaded as a journalEntries import and analyzed, dropping the user
  // straight onto the mapping/review step (analyze → review → commit gate still
  // applies — nothing is written without explicit confirmation).
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !token) return;
    let raw: string | null = null;
    try { raw = sessionStorage.getItem("office_je_import"); } catch { raw = null; }
    if (!raw) return;
    seededRef.current = true;
    try { sessionStorage.removeItem("office_je_import"); } catch { /* ignore */ }
    let payload: { headers?: unknown; rows?: unknown } | null = null;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!payload || !Array.isArray(payload.headers) || !Array.isArray(payload.rows)) return;
    const ph = payload.headers.map((h) => String(h ?? ""));
    const pr = payload.rows.filter((r) => r != null && typeof r === "object");
    if (!ph.length || !pr.length) return;
    setEntityKey("journalEntries");
    setFileName(isAr ? "من محرر الإكسل" : "From Excel editor");
    setHeaders(ph);
    setRows(pr);
    setBusy(true);
    analyzeImport(token, { entity: "journalEntries", headers: ph, sampleRows: pr.slice(0, 8) })
      .then((result) => {
        setAnalysis(result);
        const initialMap: Record<string, string | null> = {};
        for (const [src, m] of Object.entries(result.mapping)) initialMap[src] = m.field;
        setMapping(initialMap);
        setStep("analyze");
      })
      .catch((e: any) => toast({ title: e?.message ?? t("dataIO.readFailed"), variant: "destructive" }))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function reset() {
    setStep("upload"); setFileName(""); setHeaders([]); setRows([]);
    setAnalysis(null); setMapping({}); setProcessed(null); setCommitResult(null);
    setAllowDuplicates(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onFile(file: File) {
    if (!entityKey) { toast({ title: t("dataIO.chooseTypeFirst"), variant: "destructive" }); return; }
    setFileName(file.name);
    setBusy(true);
    try {
      const isJson = file.name.toLowerCase().endsWith(".json");
      let parsedHeaders: string[] = [];
      let parsedRows: any[] = [];
      let bundleAdaptedCount = 0;
      if (isJson) {
        const text = await file.text();
        const json = JSON.parse(text);
        let arr: any[] = [];
        if (Array.isArray(json)) arr = json;
        else if (json && Array.isArray(json[entityKey])) arr = json[entityKey];
        else if (json?.data && Array.isArray(json.data[entityKey])) arr = json.data[entityKey];
        // If the direct branch matched but yielded zero rows, the file may
        // still be a multi-table bundle that *also* happens to ship an empty
        // entityKey array. Fall through to the adapter rather than failing.
        if (arr.length === 0) {
          const adapted = adaptNestedBundle(json, entityKey);
          if (adapted && adapted.length > 0) {
            arr = adapted;
            bundleAdaptedCount = adapted.length;
          } else if (json?.data && typeof json.data === "object") {
            const first = Object.values(json.data).find((v) => Array.isArray(v)) as any[] | undefined;
            arr = first ?? [];
          }
        }
        if (arr.length === 0) throw new Error(t("dataIO.fileNoData"));
        parsedHeaders = Array.from(arr.reduce<Set<string>>((acc, r) => { if (r && typeof r === "object") Object.keys(r).forEach((k) => acc.add(k)); return acc; }, new Set()));
        parsedRows = arr;
      } else {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const aoa: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
        if (aoa.length < 2) throw new Error(t("dataIO.fileNotEnough"));
        parsedHeaders = (aoa[0] ?? []).map((h: any, i: number) => (h == null || String(h).trim() === "") ? t("dataIO.defaultColumn", { n: i + 1 }) : String(h).trim());
        parsedRows = aoa.slice(1).filter((r) => r && r.some((c: any) => c != null && String(c).trim() !== "")).map((r) => {
          const o: any = {};
          parsedHeaders.forEach((h, i) => { o[h] = r[i] ?? null; });
          return o;
        });
      }
      setHeaders(parsedHeaders);
      setRows(parsedRows);

      const result = await analyzeImport(token, { entity: entityKey, headers: parsedHeaders, sampleRows: parsedRows.slice(0, 8) });
      setAnalysis(result);
      const initialMap: Record<string, string | null> = {};
      for (const [src, m] of Object.entries(result.mapping)) initialMap[src] = m.field;
      setMapping(initialMap);
      setStep("analyze");
      const baseDesc = result.source === "ai" ? t("dataIO.analyzeAiDesc") : t("dataIO.analyzeFallbackDesc");
      toast({
        title: t("dataIO.analyzeSuccess", { count: parsedRows.length }),
        description: bundleAdaptedCount > 0
          ? `${t("dataIO.bundleAdapted", { count: bundleAdaptedCount })} — ${baseDesc}`
          : baseDesc,
      });
    } catch (e: any) {
      toast({ title: e?.message ?? t("dataIO.readFailed"), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function onProcess() {
    setBusy(true);
    try {
      const result = await processImport(token, { companyId: cid, entity: entityKey, mapping, rows });
      setProcessed(result);
      setStep("review");
    } catch (e: any) {
      toast({ title: e?.message ?? t("dataIO.processFailed"), variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function onCommit() {
    if (!processed) return;
    setBusy(true);
    try {
      const result = await commitImport(token, { companyId: cid, entity: entityKey, rows: processed.processed, options: { skipErrors: true, allowDuplicates: entityKey === "customers" ? allowDuplicates : false } });
      setCommitResult(result);
      setStep("result");
      toast({ title: t("dataIO.commitSuccess", { inserted: result.summary.inserted, updated: result.summary.updated, skipped: result.summary.skipped }) });
    } catch (e: any) {
      toast({ title: e?.message ?? t("dataIO.commitFailed"), variant: "destructive" });
    } finally { setBusy(false); }
  }

  function downloadReport() {
    if (!commitResult || !processed) return;
    const wb = XLSX.utils.book_new();
    const sum = commitResult.summary;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      [t("dataIO.sheetDataType"), entityLabel(entity, isAr) || entityKey],
      [t("dataIO.sheetExecutedAt"), commitResult.committedAt],
      [],
      [t("dataIO.sheetTotal"), sum.total],
      [t("dataIO.sheetInserted"), sum.inserted],
      [t("dataIO.sheetUpdated"), sum.updated],
      [t("dataIO.sheetSkipped"), sum.skipped],
      [t("dataIO.sheetErrors"), sum.errors],
    ]), t("dataIO.summarySheetName"));
    const logRows = commitResult.log.map((l) => ({
      [t("dataIO.excelFileRow")]: l.rowIndex + 1,
      [t("dataIO.excelStatus")]: l.status === "inserted" ? t("dataIO.statusInserted")
        : l.status === "updated" ? t("dataIO.statusUpdated")
        : l.status === "skipped" ? t("dataIO.statusSkipped") : t("dataIO.statusError"),
      [t("dataIO.excelId")]: l.id ?? "",
      [t("dataIO.excelReason")]: l.reason ?? "",
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(logRows), t("dataIO.executionLogSheet"));
    const issueRows = processed.issues.map((i) => ({
      [t("dataIO.excelFileRow")]: i.rowIndex + 1, [t("dataIO.excelField")]: i.field ?? "",
      [t("dataIO.excelType")]: i.type, [t("dataIO.excelSeverity")]: i.severity,
      [t("dataIO.excelBefore")]: String(i.before ?? ""), [t("dataIO.excelAfter")]: String(i.after ?? ""),
      [t("dataIO.excelAction")]: i.action,
      [t("dataIO.excelConfidence")]: Math.round(i.confidence * 100) + "%",
      [t("dataIO.excelMessage")]: i.message,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(issueRows), t("dataIO.issuesSheet"));
    void saveWorkbook(wb, `import-report-${entityKey}-${Date.now()}.xlsx`);
  }

  const StepBadge = ({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) => (
    <div className={`flex items-center gap-2 ${active ? "text-primary font-semibold" : done ? "text-green-600" : "text-muted-foreground"}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs ${
        done ? "bg-green-600 text-white" : active ? "bg-primary text-primary-foreground" : "bg-muted"
      }`}>{done ? "✓" : n}</div>
      <span className="text-sm">{label}</span>
    </div>
  );

  const ArrowIcon = isAr ? ArrowLeft : ArrowRight;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-4 justify-between">
          <div className="flex items-center gap-4">
            <StepBadge n={1} label={t("dataIO.stepUpload")} active={step === "upload"} done={step !== "upload"} />
            <ArrowIcon className="w-4 h-4 text-muted-foreground" />
            <StepBadge n={2} label={t("dataIO.stepMap")} active={step === "analyze"} done={["review", "result"].includes(step)} />
            <ArrowIcon className="w-4 h-4 text-muted-foreground" />
            <StepBadge n={3} label={t("dataIO.stepReview")} active={step === "review"} done={step === "result"} />
            <ArrowIcon className="w-4 h-4 text-muted-foreground" />
            <StepBadge n={4} label={t("dataIO.stepResult")} active={step === "result"} done={false} />
          </div>
          {step !== "upload" && (
            <Button variant="ghost" size="sm" onClick={reset}>
              <X className="w-4 h-4 ml-1" /> {t("dataIO.restart")}
            </Button>
          )}
        </div>
      </Card>

      {step === "upload" && (
        <Card className="p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium mb-2">{t("dataIO.chooseDataType")}</label>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {entities.map((e) => (
                <button
                  key={e.key}
                  onClick={() => { setEntityKey(e.key); setAllowDuplicates(false); }}
                  className={`p-3 border rounded-lg ${isAr ? "text-right" : "text-left"} transition-colors ${
                    entityKey === e.key ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted/40"
                  }`}
                >
                  <div className="font-medium">{entityLabel(e, isAr)}</div>
                  <div className="text-xs opacity-75">{isAr ? (e.labelEn ?? "") : (e.labelAr ?? "")}</div>
                </button>
              ))}
            </div>
          </div>

          <div className={`border-2 border-dashed rounded-lg p-10 text-center transition-colors ${entityKey ? "hover:border-primary cursor-pointer" : "opacity-50"}`}
               onClick={() => entityKey && fileRef.current?.click()}>
            <Upload className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <div className="font-medium">{busy ? t("dataIO.dropAnalyzing") : t("dataIO.dropIdle")}</div>
            <div className="text-xs text-muted-foreground mt-1">{t("dataIO.supportedFormats")}</div>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv,.json"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
              disabled={busy || !entityKey}
            />
          </div>

          {entity && (
            <div className="bg-blue-50 dark:bg-blue-950/30 p-3 rounded-lg text-sm">
              <div className="font-medium mb-1">{t("dataIO.fieldsHeader", { name: entityLabel(entity, isAr) })}</div>
              <div className="text-muted-foreground text-xs leading-relaxed">
                {entity.fields.map((f, i) => (
                  <span key={f.name}>
                    {fieldLabel(f, isAr)}{f.required && <span className="text-red-600">*</span>}
                    {i < entity.fields.length - 1 && " • "}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {step === "analyze" && analysis && entity && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h3 className="font-semibold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-primary" />
              {t("dataIO.mappingTitle")}
            </h3>
            <div className="flex gap-3 text-sm text-muted-foreground">
              <span>{fileName}</span>
              <Badge variant="outline">{t("dataIO.rowsCount", { count: rows.length })}</Badge>
              <Badge variant="outline">{analysis.source === "ai" ? t("dataIO.sourceAi") : t("dataIO.sourceFallback")}</Badge>
            </div>
          </div>
          {analysis.missingRequired.length > 0 && (
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-300 p-3 rounded-lg text-sm">
              <div className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-200 mb-1">
                <AlertTriangle className="w-4 h-4" /> {t("dataIO.missingRequired")}
              </div>
              <div className="text-amber-700 dark:text-amber-300">
                {analysis.missingRequired.map((m) => isAr ? (m.labelAr || m.field) : m.field).join(isAr ? "، " : ", ")}
              </div>
              <div className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                {t("dataIO.missingRequiredHelp")}
              </div>
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.fileColumn")}</th>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.systemField")}</th>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.confidenceCol")}</th>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.sampleCol")}</th>
                </tr>
              </thead>
              <tbody>
                {headers.map((h) => (
                  <tr key={h} className="border-t">
                    <td className="p-2 font-medium">{h}</td>
                    <td className="p-2">
                      <select
                        className="w-full px-2 py-1 border rounded bg-background"
                        value={mapping[h] ?? ""}
                        onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value || null }))}
                      >
                        <option value="">{t("dataIO.ignoreOpt")}</option>
                        {entity.fields.map((f) => (
                          <option key={f.name} value={f.name}>
                            {fieldLabel(f, isAr)} {f.required ? "*" : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-2 text-muted-foreground text-xs">
                      {Math.round((analysis.mapping[h]?.confidence ?? 0) * 100)}%
                    </td>
                    <td className="p-2 text-muted-foreground text-xs max-w-[280px] truncate">
                      {String(rows[0]?.[h] ?? "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-between items-center pt-2">
            <Button variant="outline" onClick={() => setStep("upload")}>
              <ArrowIcon className="w-4 h-4 ml-2 rotate-180" /> {t("dataIO.back")}
            </Button>
            <Button onClick={onProcess} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <Eye className="w-4 h-4 ml-2" />}
              {t("dataIO.processBtn")}
            </Button>
          </div>
        </Card>
      )}

      {step === "review" && processed && (
        <ReviewPanel processed={processed} entity={entity} entityKey={entityKey} setProcessed={setProcessed} onCommit={onCommit} onBack={() => setStep("analyze")} busy={busy} isAr={isAr} ArrowIcon={ArrowIcon} allowDuplicates={allowDuplicates} setAllowDuplicates={setAllowDuplicates} />
      )}

      {step === "result" && commitResult && (
        <ResultPanel result={commitResult} onDownload={downloadReport} onReset={reset} />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// JOURNAL ACCOUNT-STATEMENT PREVIEW (built client-side from the imported rows,
// BEFORE saving — lets a maintainer verify migrated journal entries per account
// using the original entry dates).
// ════════════════════════════════════════════════════════════════════════════

function stmtNormalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}
function stmtToNum(v: any): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = stmtNormalizeDigits(String(v))
    .replace(/٫/g, ".")   // arabic decimal separator
    .replace(/[٬,]/g, "") // arabic / ascii thousands separator
    .replace(/[^\d.\-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function stmtDateValue(v: any): number {
  if (!v) return 0;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : 0; }
  const s = stmtNormalizeDigits(String(v)).trim();
  let t = new Date(s).getTime();
  if (Number.isFinite(t)) return t;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y;
    t = new Date(`${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`).getTime();
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

const STMT_ALL = "__all__";

function JournalStatementPreview({ rows, isAr }: { rows: any[]; isAr: boolean }) {
  const { t, i18n } = useTranslation();
  const { user, token } = useAuth() as any;
  const dateLocale = i18n.language?.startsWith("ar") ? "ar-EG" : "en-GB";
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const align = isAr ? "text-right" : "text-left";

  // The imported rows only carry the account NUMBER (accountCode). To let the
  // user search by account NAME (e.g. «أحمد الوكيل») we resolve number → name
  // from the company chart of accounts and match against both.
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const cid: number | undefined = user?.company?.id ?? user?.companyId ?? undefined;
  const { data: chartAccounts = [] } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return [];
      const j = await res.json();
      return Array.isArray(j) ? j : [];
    },
    enabled: !!token && open,
  });
  const codeName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of chartAccounts as any[]) {
      const code = String(a?.code ?? "").trim();
      if (!code) continue;
      const nm = isAr ? (a?.nameAr ?? a?.nameEn) : (a?.nameEn ?? a?.nameAr);
      if (nm != null && String(nm).trim() !== "") m.set(code, String(nm).trim());
    }
    return m;
  }, [chartAccounts, isAr]);
  const accountLabel = (code: any) => {
    const c = String(code ?? "").trim();
    const nm = codeName.get(c);
    return nm ? `${c} — ${nm}` : c;
  };

  const accounts = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const code = r?.accountCode;
      if (code != null && String(code).trim() !== "") set.add(String(code).trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [rows]);

  const selected = account || accounts[0] || "";
  const allMode = selected === STMT_ALL;

  // Free-text search by account NAME or NUMBER. When active it OVERRIDES the
  // dropdown and scopes the statement to EVERY account whose name/number matches
  // (so «أحمد الوكيل» surfaces all of that account's movements in the period).
  const searchNorm = stmtNormalizeDigits(search).trim().toLowerCase();
  const searchActive = searchNorm !== "";
  const matchedCodes = useMemo(() => {
    if (!searchActive) return [] as string[];
    return accounts.filter((code) => {
      const cd = stmtNormalizeDigits(code).toLowerCase();
      const nm = (codeName.get(code) || "").toLowerCase();
      return cd.includes(searchNorm) || nm.includes(searchNorm);
    });
  }, [accounts, codeName, searchActive, searchNorm]);

  // null = every account; otherwise the explicit set of in-scope account codes.
  const scopeCodes: string[] | null = searchActive ? matchedCodes : (allMode ? null : [selected]);
  const inScope = (code: string) => scopeCodes === null ? true : scopeCodes.includes(code);
  const multiAcct = scopeCodes === null || scopeCodes.length !== 1;
  const scopeLabel = searchActive
    ? (matchedCodes.length === 1 ? accountLabel(matchedCodes[0]) : t("dataIO.stmtMatchedScope", { q: search.trim(), count: matchedCodes.length }))
    : (allMode ? t("dataIO.stmtAllAccounts") : accountLabel(selected));

  // Inclusive date window over the original entry dates. "To" extends to the
  // end of that day so same-day entries are not dropped.
  const fromMs = fromDate ? stmtDateValue(fromDate) : null;
  const toMs = toDate ? stmtDateValue(toDate) + 86399999 : null;
  const inRange = (d: any) => {
    if (fromMs == null && toMs == null) return true;
    const ms = stmtDateValue(d);
    if (fromMs != null && ms < fromMs) return false;
    if (toMs != null && ms > toMs) return false;
    return true;
  };

  const lines = useMemo(() => {
    const list = rows
      .filter((r) => inScope(String(r?.accountCode ?? "").trim()))
      .filter((r) => inRange(r?.entryDate))
      .map((r) => ({
        date: r?.entryDate ?? "",
        doc: r?.docNumber != null ? String(r.docNumber) : "",
        acct: String(r?.accountCode ?? "").trim(),
        desc: String(r?.lineDescription ?? r?.description ?? ""),
        debit: stmtToNum(r?.debit),
        credit: stmtToNum(r?.credit),
      }))
      .sort((a, b) => stmtDateValue(a.date) - stmtDateValue(b.date));
    // Running balance is kept PER account so the "all accounts" listing shows
    // each account's own running balance (single-account mode reduces to one).
    const bals = new Map<string, number>();
    return list.map((l) => {
      const nb = (bals.get(l.acct) ?? 0) + l.debit - l.credit;
      bals.set(l.acct, nb);
      return { ...l, balance: nb };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selected, allMode, searchActive, matchedCodes, fromDate, toDate]);

  const totals = useMemo(
    () => lines.reduce((acc, l) => { acc.debit += l.debit; acc.credit += l.credit; return acc; }, { debit: 0, credit: 0 }),
    [lines],
  );

  const fmt = (n: number) => n.toLocaleString(dateLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (v: any) => { const ms = stmtDateValue(v); return ms ? new Date(ms).toLocaleDateString(dateLocale) : String(v ?? ""); };
  const esc = (s: any) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

  function exportStatement() {
    const wb = XLSX.utils.book_new();
    const header = multiAcct
      ? [t("dataIO.stmtDate"), t("dataIO.stmtDoc"), t("dataIO.stmtAccount"), t("dataIO.stmtDesc"), t("dataIO.stmtDebit"), t("dataIO.stmtCredit"), t("dataIO.stmtBalance")]
      : [t("dataIO.stmtDate"), t("dataIO.stmtDoc"), t("dataIO.stmtDesc"), t("dataIO.stmtDebit"), t("dataIO.stmtCredit"), t("dataIO.stmtBalance")];
    const body = lines.map((l) => multiAcct
      ? [fmtDate(l.date), l.doc, accountLabel(l.acct), l.desc, l.debit, l.credit, l.balance]
      : [fmtDate(l.date), l.doc, l.desc, l.debit, l.credit, l.balance]);
    const totalsRow = multiAcct
      ? [t("dataIO.stmtTotals"), "", "", "", totals.debit, totals.credit, totals.debit - totals.credit]
      : [t("dataIO.stmtTotals"), "", "", totals.debit, totals.credit, totals.debit - totals.credit];
    const aoa: any[][] = [
      [t("dataIO.stmtAccount"), scopeLabel],
      [],
      header,
      ...body,
      totalsRow,
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "statement");
    void saveWorkbook(wb, `account-statement-${searchActive ? "search" : (allMode ? "all" : selected)}-${Date.now()}.xlsx`);
  }

  // ── Print helpers (standalone window, same look as the system JE print) ──
  function buildShell(title: string, inner: string) {
    const dir = isAr ? "rtl" : "ltr";
    const lang = isAr ? "ar" : "en";
    const alignCss = isAr ? "right" : "left";
    const safeLogo = safeLogoSrc((user?.company as any)?.logo);
    const logo = safeLogo
      ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:54px;max-width:170px;object-fit:contain;display:block;margin:0 auto;"/></div>` : "";
    const cname = user?.company?.nameAr
      ? `<div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:2px;">${esc(user.company.nameAr)}</div>` : "";
    const today = new Date().toLocaleDateString(dateLocale);
    return `<!DOCTYPE html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
@page { size:A4; margin:12mm; }
@media print { thead { display:table-header-group; } .print-btn { display:none; } }
*{box-sizing:border-box;}
body{font-family:"Segoe UI","Tahoma","Arial",system-ui,sans-serif;color:#111;margin:0;padding:16px;}
.h{text-align:center;margin-bottom:10px;}
.h h1{margin:0 0 4px;font-size:18px;}
.h .meta{font-size:11px;color:#555;}
table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:4px;}
thead th{background:#1e3a8a;color:#fff;padding:6px 8px;border:1px solid #1e3a8a;text-align:${alignCss};font-weight:600;}
tbody td{padding:5px 8px;border:1px solid #d1d5db;text-align:${alignCss};}
tbody tr:nth-child(even) td{background:#f5f7fb;}
tfoot td{padding:5px 8px;border:1px solid #94a3b8;background:#eef2ff;font-weight:700;text-align:${alignCss};}
.num{font-family:"Consolas",monospace;}
.entry{margin-bottom:14px;page-break-inside:avoid;border:1px solid #cbd5e1;border-radius:6px;padding:8px;}
.entry-h{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px dashed #cbd5e1;}
.entry-h .ed{color:#475569;}
.grand{display:flex;gap:18px;justify-content:center;margin:8px 0 14px;font-size:13px;background:#f1f5f9;padding:8px;border-radius:6px;}
.grand b{color:#1e3a8a;}
.print-btn{position:fixed;top:10px;${isAr ? "left" : "right"}:10px;padding:8px 14px;background:#1e3a8a;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;}
</style></head><body>
<button class="print-btn" onclick="window.print()">${esc(t("dataIO.stmtPrintNow"))}</button>
<div class="h">${logo}${cname}<h1>${esc(title)}</h1><div class="meta">${esc(t("dataIO.stmtReportDate"))}: ${esc(today)}</div></div>
${inner}
<script>setTimeout(()=>window.print(),300);</script></body></html>`;
  }

  function openWin(html: string) {
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) return;
    w.document.open(); w.document.write(html); w.document.close();
  }

  function printStatement() {
    const acctHead = multiAcct ? `<th>${esc(t("dataIO.stmtAccount"))}</th>` : "";
    const head = `<tr><th>#</th><th>${esc(t("dataIO.stmtDate"))}</th><th>${esc(t("dataIO.stmtDoc"))}</th>${acctHead}<th>${esc(t("dataIO.stmtDesc"))}</th><th>${esc(t("dataIO.stmtDebit"))}</th><th>${esc(t("dataIO.stmtCredit"))}</th><th>${esc(t("dataIO.stmtBalance"))}</th></tr>`;
    const body = lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(fmtDate(l.date))}</td><td>${esc(l.doc)}</td>${multiAcct ? `<td>${esc(accountLabel(l.acct))}</td>` : ""}<td>${esc(l.desc)}</td><td class="num">${l.debit ? fmt(l.debit) : ""}</td><td class="num">${l.credit ? fmt(l.credit) : ""}</td><td class="num">${fmt(l.balance)}</td></tr>`).join("");
    const span = multiAcct ? 5 : 4;
    const foot = `<tr><td colspan="${span}">${esc(t("dataIO.stmtTotals"))}</td><td class="num">${fmt(totals.debit)}</td><td class="num">${fmt(totals.credit)}</td><td class="num">${fmt(totals.debit - totals.credit)}</td></tr>`;
    const inner = `<table><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
    openWin(buildShell(`${t("dataIO.stmtStatementTitle")} — ${scopeLabel}`, inner));
  }

  function printGrouped() {
    const filtered = rows
      .filter((r) => inScope(String(r?.accountCode ?? "").trim()))
      .filter((r) => inRange(r?.entryDate));
    const map = new Map<string, { date: string; doc: string; desc: string; lns: any[]; td: number; tc: number }>();
    for (const r of filtered) {
      const doc = r?.docNumber != null ? String(r.docNumber) : "";
      const date = r?.entryDate ?? "";
      const key = `${doc}__${stmtDateValue(date)}`;
      let g = map.get(key);
      if (!g) { g = { date, doc, desc: String(r?.description ?? ""), lns: [], td: 0, tc: 0 }; map.set(key, g); }
      const debit = stmtToNum(r?.debit), credit = stmtToNum(r?.credit);
      g.lns.push({ acct: String(r?.accountCode ?? "").trim(), desc: String(r?.lineDescription ?? r?.description ?? ""), debit, credit });
      g.td += debit; g.tc += credit;
      if (!g.desc && r?.description) g.desc = String(r.description);
    }
    const groups = Array.from(map.values()).sort((a, b) => stmtDateValue(a.date) - stmtDateValue(b.date));
    let gTd = 0, gTc = 0;
    const blocks = groups.map((g) => {
      gTd += g.td; gTc += g.tc;
      const lnsHtml = g.lns.map((l) => `<tr><td>${esc(accountLabel(l.acct))}</td><td>${esc(l.desc)}</td><td class="num">${l.debit ? fmt(l.debit) : ""}</td><td class="num">${l.credit ? fmt(l.credit) : ""}</td></tr>`).join("");
      return `<div class="entry"><div class="entry-h"><span>${esc(t("dataIO.stmtDoc"))}: <b>${esc(g.doc || "—")}</b></span><span>${esc(t("dataIO.stmtDate"))}: <b>${esc(fmtDate(g.date))}</b></span>${g.desc ? `<span class="ed">${esc(g.desc)}</span>` : ""}</div>`
        + `<table><thead><tr><th>${esc(t("dataIO.stmtAccount"))}</th><th>${esc(t("dataIO.stmtDesc"))}</th><th>${esc(t("dataIO.stmtDebit"))}</th><th>${esc(t("dataIO.stmtCredit"))}</th></tr></thead><tbody>${lnsHtml}</tbody>`
        + `<tfoot><tr><td colspan="2">${esc(t("dataIO.stmtTotals"))}</td><td class="num">${fmt(g.td)}</td><td class="num">${fmt(g.tc)}</td></tr></tfoot></table></div>`;
    }).join("");
    const grand = `<div class="grand"><span>${esc(t("dataIO.stmtEntriesCount", { count: groups.length }))}</span><span>${esc(t("dataIO.stmtDebit"))}: <b>${fmt(gTd)}</b></span><span>${esc(t("dataIO.stmtCredit"))}: <b>${fmt(gTc)}</b></span></div>`;
    openWin(buildShell(`${t("dataIO.stmtPrintTitle")} — ${scopeLabel}`, grand + blocks));
  }

  return (
    <Card className="p-4 border-sky-300 bg-sky-50/40 dark:bg-sky-950/20">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="w-4 h-4 text-sky-600" />
          <h3 className="font-semibold">{t("dataIO.stmtTitle")}</h3>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
          {open ? t("dataIO.stmtHide") : t("dataIO.stmtShow")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mt-1">{t("dataIO.stmtHint")}</p>

      {open && (accounts.length === 0 ? (
        <div className="mt-3 text-sm text-amber-700 dark:text-amber-300">{t("dataIO.stmtNoAccounts")}</div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">{t("dataIO.stmtSearch")}</span>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("dataIO.stmtSearchPh")}
              className="h-8 px-2 py-1 text-sm w-[240px]"
            />
            {searchActive && (
              <Button size="sm" variant="ghost" onClick={() => setSearch("")}>{t("dataIO.stmtClear")}</Button>
            )}
            <span className="text-sm text-muted-foreground">{t("dataIO.stmtAccount")}</span>
            <select
              className="px-2 py-1 text-sm border rounded bg-background min-w-[200px] max-w-[280px] disabled:opacity-50"
              value={selected}
              disabled={searchActive}
              onChange={(e) => { setAccount(e.target.value); setSearch(""); }}
            >
              <option value={STMT_ALL}>{t("dataIO.stmtAllAccounts")}</option>
              {accounts.map((a) => <option key={a} value={a}>{accountLabel(a)}</option>)}
            </select>
            <span className="text-sm text-muted-foreground">{t("dataIO.stmtFrom")}</span>
            <DateField value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="px-2 py-1 text-sm border rounded bg-background w-[150px]" />
            <span className="text-sm text-muted-foreground">{t("dataIO.stmtTo")}</span>
            <DateField value={toDate} onChange={(e) => setToDate(e.target.value)} className="px-2 py-1 text-sm border rounded bg-background w-[150px]" />
            {(fromDate || toDate) && (
              <Button size="sm" variant="ghost" onClick={() => { setFromDate(""); setToDate(""); }}>{t("dataIO.stmtClear")}</Button>
            )}
            <Badge variant="outline">{t("dataIO.stmtRows", { count: lines.length })}</Badge>
            <div className="flex items-center gap-2 ms-auto">
              <Button size="sm" variant="outline" onClick={printStatement}>
                <Printer className="w-4 h-4 ml-2" /> {t("dataIO.stmtPrintStatement")}
              </Button>
              <Button size="sm" variant="outline" onClick={printGrouped}>
                <Printer className="w-4 h-4 ml-2" /> {t("dataIO.stmtPrint")}
              </Button>
              <Button size="sm" variant="outline" onClick={exportStatement}>
                <FileDown className="w-4 h-4 ml-2" /> {t("dataIO.stmtExport")}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t("dataIO.stmtAccount")}:</span>
            <span className="font-semibold">{scopeLabel}</span>
          </div>

          {searchActive && matchedCodes.length === 0 ? (
            <div className="text-sm text-amber-700 dark:text-amber-300">{t("dataIO.stmtNoMatch")}</div>
          ) : null}

          <div className="overflow-x-auto rounded border max-h-[600px] bg-background">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 sticky top-0">
                <tr>
                  <th className={`p-2 ${align} w-10`}>#</th>
                  <th className={`p-2 ${align} whitespace-nowrap`}>{t("dataIO.stmtDate")}</th>
                  <th className={`p-2 ${align} whitespace-nowrap`}>{t("dataIO.stmtDoc")}</th>
                  {multiAcct && <th className={`p-2 ${align} whitespace-nowrap`}>{t("dataIO.stmtAccount")}</th>}
                  <th className={`p-2 ${align}`}>{t("dataIO.stmtDesc")}</th>
                  <th className={`p-2 ${align} whitespace-nowrap`}>{t("dataIO.stmtDebit")}</th>
                  <th className={`p-2 ${align} whitespace-nowrap`}>{t("dataIO.stmtCredit")}</th>
                  <th className={`p-2 ${align} whitespace-nowrap`}>{t("dataIO.stmtBalance")}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => (
                  <tr key={idx} className="border-t">
                    <td className="p-2 text-xs text-muted-foreground">{idx + 1}</td>
                    <td className="p-2 whitespace-nowrap">{fmtDate(l.date)}</td>
                    <td className="p-2 whitespace-nowrap">{l.doc}</td>
                    {multiAcct && <td className="p-2 whitespace-nowrap">{accountLabel(l.acct)}</td>}
                    <td className="p-2 max-w-[280px] truncate" title={l.desc}>{l.desc}</td>
                    <td className="p-2 whitespace-nowrap">{l.debit ? fmt(l.debit) : ""}</td>
                    <td className="p-2 whitespace-nowrap">{l.credit ? fmt(l.credit) : ""}</td>
                    <td className="p-2 whitespace-nowrap font-medium">{fmt(l.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/30 font-semibold">
                  <td className="p-2" colSpan={multiAcct ? 5 : 4}>{t("dataIO.stmtTotals")}</td>
                  <td className="p-2 whitespace-nowrap">{fmt(totals.debit)}</td>
                  <td className="p-2 whitespace-nowrap">{fmt(totals.credit)}</td>
                  <td className="p-2 whitespace-nowrap">{fmt(totals.debit - totals.credit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ))}
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// REVIEW PANEL
// ════════════════════════════════════════════════════════════════════════════

function ReviewPanel({ processed, entity, entityKey, setProcessed, onCommit, onBack, busy, isAr, ArrowIcon, allowDuplicates, setAllowDuplicates }: {
  processed: ProcessResult; entity: EntityCatalogItem | undefined; entityKey: string; setProcessed: (r: ProcessResult) => void;
  onCommit: () => void; onBack: () => void; busy: boolean; isAr: boolean; ArrowIcon: typeof ArrowLeft;
  allowDuplicates: boolean; setAllowDuplicates: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<"all" | "errors" | "warnings" | "info" | "duplicates">("all");
  const issuesByRow = useMemo(() => {
    const m = new Map<number, RowIssue[]>();
    for (const i of processed.issues) {
      if (!m.has(i.rowIndex)) m.set(i.rowIndex, []);
      m.get(i.rowIndex)!.push(i);
    }
    return m;
  }, [processed.issues]);

  const filteredRows = processed.processed.filter((r) => {
    if (filter === "all") return true;
    const list = issuesByRow.get(r.__rowIndex) ?? [];
    if (filter === "errors")     return list.some((i) => i.severity === "error");
    if (filter === "warnings")   return list.some((i) => i.severity === "warning");
    if (filter === "info")       return list.some((i) => i.severity === "info");
    if (filter === "duplicates") return list.some((i) => i.type === "duplicate");
    return true;
  });

  function updateCell(rowIndex: number, field: string, value: any) {
    const next = { ...processed };
    next.processed = next.processed.map((r) => r.__rowIndex === rowIndex ? { ...r, [field]: value } : r);
    setProcessed(next);
  }

  const cols = entity?.fields.filter((f) => processed.processed.some((r) => f.name in r)) ?? [];
  const align = isAr ? "text-right" : "text-left";

  return (
    <div className="space-y-4">
      {/* stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label={t("dataIO.statTotal")}      value={processed.stats.total}     icon={<Database />} />
        <StatCard label={t("dataIO.statErrors")}     value={processed.stats.errors}    icon={<X />} tone="error"   onClick={() => setFilter("errors")}     active={filter === "errors"} />
        <StatCard label={t("dataIO.statWarnings")}   value={processed.stats.warnings}  icon={<AlertTriangle />} tone="warning" onClick={() => setFilter("warnings")}   active={filter === "warnings"} />
        <StatCard label={t("dataIO.statFixes")}      value={processed.stats.info}      icon={<Sparkles />} tone="info"   onClick={() => setFilter("info")}        active={filter === "info"} />
        <StatCard label={t("dataIO.statDuplicates")} value={processed.stats.duplicates} icon={<CheckCircle2 />} tone="muted" onClick={() => setFilter("duplicates")} active={filter === "duplicates"} />
      </div>

      {entityKey === "journalEntries" && (
        <JournalStatementPreview rows={processed.processed} isAr={isAr} />
      )}

      <Card className="p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h3 className="font-semibold">{t("dataIO.previewTitle")}</h3>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t("dataIO.viewLabel")}</span>
            <select className="px-2 py-1 text-sm border rounded bg-background" value={filter} onChange={(e) => setFilter(e.target.value as any)}>
              <option value="all">{t("dataIO.filterAll", { count: processed.processed.length })}</option>
              <option value="errors">{t("dataIO.filterErrors")}</option>
              <option value="warnings">{t("dataIO.filterWarnings")}</option>
              <option value="info">{t("dataIO.filterFixes")}</option>
              <option value="duplicates">{t("dataIO.filterDuplicates")}</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto rounded border max-h-[500px]">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 sticky top-0">
              <tr>
                <th className={`p-2 ${align} w-10`}>#</th>
                <th className={`p-2 ${align} w-24`}>{t("dataIO.statusCol")}</th>
                {cols.map((c) => <th key={c.name} className={`p-2 ${align} whitespace-nowrap`}>{fieldLabel(c, isAr)}</th>)}
              </tr>
            </thead>
            <tbody>
              {filteredRows.slice(0, 200).map((r) => {
                const list = issuesByRow.get(r.__rowIndex) ?? [];
                const hasError = list.some((i) => i.severity === "error");
                const hasWarn  = list.some((i) => i.severity === "warning");
                return (
                  <tr key={r.__rowIndex} className={`border-t ${hasError ? "bg-red-50 dark:bg-red-950/30" : hasWarn ? "bg-amber-50 dark:bg-amber-950/20" : ""}`}>
                    <td className="p-2 text-xs text-muted-foreground">{r.__rowIndex + 1}</td>
                    <td className="p-2">
                      {hasError ? <Badge variant="destructive">{t("dataIO.rowError")}</Badge>
                        : hasWarn ? <Badge className="bg-amber-500">{t("dataIO.rowWarning")}</Badge>
                        : list.length ? <Badge variant="secondary">{t("dataIO.rowFix")}</Badge>
                        : <Badge variant="outline">{t("dataIO.rowReady")}</Badge>}
                    </td>
                    {cols.map((c) => {
                      const issue = list.find((i) => i.field === c.name);
                      return (
                        <td key={c.name} className={`p-1 ${issue ? "border-r-2 border-amber-400" : ""}`}>
                          <Input
                            className="h-7 text-xs"
                            value={r[c.name] ?? ""}
                            onChange={(e) => updateCell(r.__rowIndex, c.name, e.target.value)}
                            title={issue?.message}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredRows.length > 200 && (
            <div className="p-3 text-center text-xs text-muted-foreground bg-muted/20">
              {t("dataIO.showing200", { count: filteredRows.length })}
            </div>
          )}
        </div>
      </Card>

      {/* issues detail */}
      {processed.issues.length > 0 && (
        <Card className="p-4">
          <h3 className="font-semibold mb-3">{t("dataIO.issuesTitle")}</h3>
          <div className="overflow-x-auto rounded border max-h-[300px]">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 sticky top-0">
                <tr>
                  <th className={`p-2 ${align}`}>{t("dataIO.rowCol")}</th>
                  <th className={`p-2 ${align}`}>{t("dataIO.fieldCol")}</th>
                  <th className={`p-2 ${align}`}>{t("dataIO.typeCol")}</th>
                  <th className={`p-2 ${align}`}>{t("dataIO.beforeCol")}</th>
                  <th className={`p-2 ${align}`}>{t("dataIO.afterCol")}</th>
                  <th className={`p-2 ${align}`}>{t("dataIO.actionCol")}</th>
                  <th className={`p-2 ${align}`}>{t("dataIO.confidenceCol")}</th>
                </tr>
              </thead>
              <tbody>
                {processed.issues.slice(0, 300).map((i, idx) => (
                  <tr key={idx} className="border-t">
                    <td className="p-2">{i.rowIndex + 1}</td>
                    <td className="p-2">{i.field ?? "—"}</td>
                    <td className="p-2">
                      <Badge variant={i.severity === "error" ? "destructive" : i.severity === "warning" ? "secondary" : "outline"} className="text-[10px]">
                        {i.message}
                      </Badge>
                    </td>
                    <td className="p-2 text-muted-foreground max-w-[140px] truncate">{String(i.before ?? "")}</td>
                    <td className="p-2 max-w-[140px] truncate">{String(i.after ?? "")}</td>
                    <td className="p-2">{i.action}</td>
                    <td className="p-2">{Math.round(i.confidence * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {entityKey === "customers" && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <Copy className="w-4 h-4 text-primary" />
            <h3 className="font-semibold">{t("dataIO.dupModeTitle")}</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-3">{t("dataIO.dupModeHint")}</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setAllowDuplicates(false)}
              className={`text-start p-3 border rounded-lg transition-all ${!allowDuplicates ? "ring-2 ring-primary border-primary bg-primary/5" : "hover:bg-muted/40"}`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium">{t("dataIO.dupModePreventTitle")}</span>
                {!allowDuplicates && <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />}
              </div>
              <p className="text-xs text-muted-foreground">{t("dataIO.dupModePreventDesc")}</p>
            </button>
            <button
              type="button"
              onClick={() => setAllowDuplicates(true)}
              className={`text-start p-3 border rounded-lg transition-all ${allowDuplicates ? "ring-2 ring-primary border-primary bg-primary/5" : "hover:bg-muted/40"}`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium">{t("dataIO.dupModeAllowTitle")}</span>
                {allowDuplicates && <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />}
              </div>
              <p className="text-xs text-muted-foreground">{t("dataIO.dupModeAllowDesc")}</p>
            </button>
          </div>
        </Card>
      )}

      <div className="flex justify-between items-center">
        <Button variant="outline" onClick={onBack} disabled={busy}>
          <ArrowIcon className="w-4 h-4 ml-2 rotate-180" /> {t("dataIO.backToMap")}
        </Button>
        <Button onClick={onCommit} disabled={busy} size="lg">
          {busy ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 ml-2" />}
          {t("dataIO.commitBtn")}
        </Button>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, tone = "default", onClick, active }: {
  label: string; value: number; icon: React.ReactNode;
  tone?: "default" | "error" | "warning" | "info" | "muted"; onClick?: () => void; active?: boolean;
}) {
  const toneCls =
    tone === "error" ? "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900"
    : tone === "warning" ? "bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900"
    : tone === "info" ? "bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900"
    : tone === "muted" ? "bg-muted/30"
    : "bg-card";
  return (
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      className={`p-3 border rounded-lg text-right transition-all ${toneCls} ${active ? "ring-2 ring-primary" : ""} ${onClick ? "cursor-pointer hover:shadow" : "cursor-default"}`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs">{label}</span>
        <span className="opacity-50">{icon}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
    </button>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// RESULT PANEL
// ════════════════════════════════════════════════════════════════════════════

function ResultPanel({ result, onDownload, onReset }: { result: CommitResult; onDownload: () => void; onReset: () => void }) {
  const { t, i18n } = useTranslation();
  const isAr = i18n.language?.startsWith("ar");
  const dateLocale = isAr ? "ar-SA" : "en-US";
  const s = result.summary;
  return (
    <div className="space-y-4">
      <Card className="p-6 text-center bg-gradient-to-b from-green-50 to-card dark:from-green-950/40">
        <CheckCircle2 className="w-12 h-12 text-green-600 mx-auto mb-2" />
        <h3 className="text-xl font-semibold mb-1">{t("dataIO.completedTitle")}</h3>
        <p className="text-sm text-muted-foreground">{new Date(result.committedAt).toLocaleString(dateLocale)}</p>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label={t("dataIO.statTotal")}      value={s.total}    icon={<Database />} />
        <StatCard label={t("dataIO.statusInserted")} value={s.inserted} icon={<CheckCircle2 />} tone="info" />
        <StatCard label={t("dataIO.statusUpdated")}  value={s.updated}  icon={<Sparkles />} tone="info" />
        <StatCard label={t("dataIO.statusSkipped")}  value={s.skipped}  icon={<AlertTriangle />} tone="warning" />
        <StatCard label={t("dataIO.statErrors")}     value={s.errors}   icon={<X />} tone="error" />
      </div>

      {result.log.some((l) => l.status === "skipped" || l.status === "error") && (
        <Card className="p-4">
          <h3 className="font-semibold mb-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" /> {t("dataIO.failedRowsTitle")}
          </h3>
          <div className="overflow-x-auto rounded border max-h-[300px]">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 sticky top-0">
                <tr>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.rowCol")}</th>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.statusCol")}</th>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.excelReason")}</th>
                </tr>
              </thead>
              <tbody>
                {result.log.filter((l) => l.status !== "inserted" && l.status !== "updated").map((l, idx) => (
                  <tr key={idx} className="border-t">
                    <td className="p-2">{l.rowIndex + 1}</td>
                    <td className="p-2">
                      <Badge variant={l.status === "error" ? "destructive" : "secondary"}>{l.status === "skipped" ? t("dataIO.statusSkipped") : t("dataIO.statusError")}</Badge>
                    </td>
                    <td className="p-2">{l.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="flex justify-between items-center">
        <Button variant="outline" onClick={onReset}>{t("dataIO.importAnotherBtn")}</Button>
        <Button onClick={onDownload}>
          <FileDown className="w-4 h-4 ml-2" /> {t("dataIO.downloadReportBtn")}
        </Button>
      </div>
    </div>
  );
}
