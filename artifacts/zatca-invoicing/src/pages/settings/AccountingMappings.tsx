import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { AccountCombobox } from "@/components/AccountCombobox";
import { Lock, Unlock, Sparkles, Save, Info, Loader2, BookMarked, Wand2, FileStack, Download, Upload } from "lucide-react";
import { DOCUMENT_TYPES, type DocumentTypeDef } from "@/config/accountingMappings";
import { exportToExcel, type ExportColumn } from "@/lib/export";
import * as XLSX from "xlsx";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type MappingRow = {
  id?: number;
  documentType: string;
  roleKey: string;
  accountId: number | null;
  isLocked: boolean;
};

export default function AccountingMappings() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const { t, i18n } = useTranslation();
  const isAr = i18n.language?.startsWith("ar");
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const { data: serverMappings = [], isLoading: loadingMaps, isError: mapsError, error: mapsErrorObj } = useQuery<MappingRow[]>({
    queryKey: ["accounting-mappings", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/accounting-mappings?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error(`${t("accountingMappings.loadMappingsFailed")} (${r.status})`);
      return r.json();
    },
    enabled: !!cid,
    retry: 1,
  });

  const { data: accounts = [], isError: accountsError } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/accounts?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error(t("accountingMappings.loadAccountsFailed"));
      return r.json();
    },
    enabled: !!cid,
    staleTime: 60_000,
    retry: 1,
  });

  const loadFailed = mapsError || accountsError;

  const [state, setState] = useState<Record<string, MappingRow>>({});
  const [aiReasoning, setAiReasoning] = useState<Record<string, string>>({});
  const [aiBusy, setAiBusy] = useState<Record<string, boolean>>({});

  const hydratedRef = useRef(false);
  function rowsToState(rows: MappingRow[]): Record<string, MappingRow> {
    const next: Record<string, MappingRow> = {};
    for (const dt of DOCUMENT_TYPES) {
      for (const r of dt.roles) {
        const key = `${dt.key}.${r.key}`;
        const found = rows.find(m => m.documentType === dt.key && m.roleKey === r.key);
        next[key] = {
          documentType: dt.key,
          roleKey: r.key,
          accountId: found?.accountId ?? null,
          isLocked: !!found?.isLocked,
        };
      }
    }
    return next;
  }
  useEffect(() => {
    if (hydratedRef.current) return;
    if (loadingMaps) return;
    if (mapsError) return;
    setState(rowsToState(serverMappings));
    hydratedRef.current = true;
  }, [serverMappings, loadingMaps, mapsError]);

  const groupLocked = (docType: string) =>
    DOCUMENT_TYPES.find(d => d.key === docType)?.roles.every(r => state[`${docType}.${r.key}`]?.isLocked) ?? false;

  const setAccount = (docType: string, roleKey: string, accountId: number | null) => {
    const k = `${docType}.${roleKey}`;
    if (state[k]?.isLocked) {
      toast({ title: t("accountingMappings.lockedNoEdit"), variant: "destructive" });
      return;
    }
    setState(s => ({ ...s, [k]: { ...s[k]!, accountId } }));
  };

  const toggleGroupLock = (docType: string, locked: boolean) => {
    setState(s => {
      const next = { ...s };
      const dt = DOCUMENT_TYPES.find(d => d.key === docType);
      dt?.roles.forEach(r => {
        const k = `${docType}.${r.key}`;
        if (next[k]) next[k] = { ...next[k]!, isLocked: locked };
      });
      return next;
    });
  };

  const saveMut = useMutation({
    mutationFn: async (docType?: string) => {
      if (loadFailed) throw new Error(t("accountingMappings.cantSaveBeforeLoad"));
      const items = Object.values(state).filter(r => !docType || r.documentType === docType);
      const res = await fetch(`${API}/api/accounting-mappings/bulk`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid, items }),
      });
      if (!res.ok) {
        const text = await res.text(); let m = text;
        try { m = JSON.parse(text).error ?? text; } catch {}
        throw new Error(m || t("accountingMappings.saveBulkFailed"));
      }
      return { rows: (await res.json()) as MappingRow[], docType };
    },
    onSuccess: ({ rows, docType }) => {
      if (!Array.isArray(rows)) { toast({ title: t("accountingMappings.saved") }); return; }
      qc.setQueryData(["accounting-mappings", cid], rows);
      if (docType) {
        setState(prev => {
          const next = { ...prev };
          const dt = DOCUMENT_TYPES.find(d => d.key === docType);
          dt?.roles.forEach(r => {
            const k = `${docType}.${r.key}`;
            const found = rows.find(m => m.documentType === docType && m.roleKey === r.key);
            next[k] = {
              documentType: docType,
              roleKey: r.key,
              accountId: found?.accountId ?? null,
              isLocked: !!found?.isLocked,
            };
          });
          return next;
        });
      } else {
        setState(rowsToState(rows));
      }
      toast({ title: t("accountingMappings.saved") });
    },
    onError: (e: any) => toast({ title: t("accountingMappings.saveFailedTitle"), description: e?.message, variant: "destructive" }),
  });

  async function aiSuggest(doc: DocumentTypeDef, roleKey: string) {
    const k = `${doc.key}.${roleKey}`;
    if (state[k]?.isLocked) {
      toast({ title: t("accountingMappings.lockedCannotEdit"), variant: "destructive" });
      return;
    }
    const role = doc.roles.find(r => r.key === roleKey)!;
    setAiBusy(b => ({ ...b, [k]: true }));
    try {
      const res = await fetch(`${API}/api/accounting-mappings/ai-suggest`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          documentType: doc.key,
          roleKey,
          roleLabel: role.label,
          roleDescription: role.description,
          accounts: accounts.filter((a: any) => a.isActive).map((a: any) => ({
            id: a.id, code: a.code, nameAr: a.nameAr, accountType: a.accountType, isPosting: a.isPosting,
          })),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "");
      const data = await res.json();
      if (data.accountId) {
        setState(s => ({ ...s, [k]: { ...s[k]!, accountId: Number(data.accountId) } }));
      }
      if (data.created) {
        await qc.invalidateQueries({ queryKey: ["accounts", cid] });
      }
      setAiReasoning(r => ({ ...r, [k]: data.reasoning || "" }));
      const title = data.created
        ? t("accountingMappings.aiAccountCreated", { code: data.createdAccount?.code, name: data.createdAccount?.nameAr })
        : data.accountId ? t("accountingMappings.aiSuggested") : t("accountingMappings.aiNoMatch");
      toast({ title, description: data.reasoning?.slice(0, 160) });
    } catch (e: any) {
      toast({ title: t("accountingMappings.aiSuggestFailed"), description: e?.message, variant: "destructive" });
    } finally {
      setAiBusy(b => ({ ...b, [k]: false }));
    }
  }

  const seedDefaultsMut = useMutation({
    mutationFn: async (overwrite: boolean) => {
      const res = await fetch(`${API}/api/accounting-mappings/seed-defaults`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid, overwrite }),
      });
      if (!res.ok) {
        const text = await res.text(); let m = text;
        try { m = JSON.parse(text).error ?? text; } catch {}
        throw new Error(m || t("accountingMappings.defaultsFailedTitle"));
      }
      return res.json() as Promise<{
        inserted: number; updated: number;
        skippedMissingAccount: number; skippedAlreadyMapped: number;
        missingAccountCodes: string[];
      }>;
    },
    onSuccess: async (data) => {
      try {
        const r = await fetch(`${API}/api/accounting-mappings?companyId=${cid}`, { headers });
        if (r.ok) {
          const rows: MappingRow[] = await r.json();
          qc.setQueryData(["accounting-mappings", cid], rows);
        }
      } catch {/* non-fatal */}
      qc.invalidateQueries({ queryKey: ["accounting-mappings", cid] });
      const applied = data.inserted + data.updated;
      const tail = data.missingAccountCodes.length > 0
        ? ` — ${t("accountingMappings.missingAccountsHint", { count: data.missingAccountCodes.length })}`
        : "";
      const updatedClause = data.updated ? t("accountingMappings.defaultsUpdatedClause", { updated: data.updated }) : "";
      toast({
        title: applied > 0 ? t("accountingMappings.defaultsAppliedTitle") : t("accountingMappings.defaultsNothingNew"),
        description: t("accountingMappings.defaultsAppliedDesc", { inserted: data.inserted, updatedClause }) + tail,
      });
    },
    onError: (e: any) => {
      toast({ title: t("accountingMappings.defaultsFailedTitle"), description: e?.message, variant: "destructive" });
    },
  });

  const seedLcMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/accounting-mappings/seed-lc`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid }),
      });
      if (!res.ok) {
        const text = await res.text(); let m = text;
        try { m = JSON.parse(text).error ?? text; } catch {}
        throw new Error(m || t("accountingMappings.lcFailedTitle"));
      }
      return res.json();
    },
    onSuccess: async (data) => {
      qc.invalidateQueries({ queryKey: ["accounts", cid] });
      try {
        const r = await fetch(`${API}/api/accounting-mappings?companyId=${cid}`, { headers });
        if (r.ok) {
          const rows: MappingRow[] = await r.json();
          qc.setQueryData(["accounting-mappings", cid], rows);
          setState(prev => {
            const next = { ...prev };
            const dt = DOCUMENT_TYPES.find(d => d.key === "letter_of_credit");
            dt?.roles.forEach(role => {
              const k = `letter_of_credit.${role.key}`;
              const found = rows.find(m => m.documentType === "letter_of_credit" && m.roleKey === role.key);
              next[k] = {
                documentType: "letter_of_credit",
                roleKey: role.key,
                accountId: found?.accountId ?? null,
                isLocked: !!found?.isLocked,
              };
            });
            return next;
          });
        }
      } catch { /* tolerate transient fetch failures */ }
      const created = data?.created?.length ?? 0;
      const reused = data?.reused?.length ?? 0;
      toast({
        title: t("accountingMappings.lcCreatedTitle"),
        description: t("accountingMappings.lcCreatedDesc", { created, reused }),
      });
    },
    onError: (e: any) => toast({ title: t("accountingMappings.lcFailedTitle"), description: e?.message, variant: "destructive" }),
  });

  async function aiSuggestAll() {
    for (const doc of DOCUMENT_TYPES) {
      for (const r of doc.roles) {
        const k = `${doc.key}.${r.key}`;
        if (state[k]?.isLocked || state[k]?.accountId) continue;
        await aiSuggest(doc, r.key);
      }
    }
    try { await saveMut.mutateAsync(undefined); } catch {}
  }

  const IO_COLUMNS: ExportColumn[] = [
    { header: t("accountingMappings.colDocType"),    key: "docTypeLabel", width: 28 },
    { header: t("accountingMappings.colDocTypeKey"), key: "docTypeKey",   width: 22 },
    { header: t("accountingMappings.colRole"),       key: "roleLabel",    width: 28 },
    { header: t("accountingMappings.colRoleKey"),    key: "roleKey",      width: 16 },
    { header: t("accountingMappings.colAccountCode"), key: "accountCode", width: 14 },
    { header: t("accountingMappings.colAccountName"), key: "accountName", width: 32 },
    { header: t("accountingMappings.colAccountId"),   key: "accountId",   width: 14 },
    { header: t("accountingMappings.colLocked"),      key: "lockedLabel", width: 8  },
  ];

  function buildExportRows(): Record<string, unknown>[] {
    const accountById = new Map<number, any>(accounts.map((a: any) => [a.id, a]));
    const rows: Record<string, unknown>[] = [];
    for (const doc of DOCUMENT_TYPES) {
      for (const role of doc.roles) {
        const k = `${doc.key}.${role.key}`;
        const row = state[k];
        const acc = row?.accountId ? accountById.get(row.accountId) : null;
        rows.push({
          docTypeLabel: doc.label,
          docTypeKey:   doc.key,
          roleLabel:    role.label,
          roleKey:      role.key,
          accountCode:  acc?.code ?? "",
          accountName:  acc?.nameAr ?? "",
          accountId:    row?.accountId ?? "",
          lockedLabel:  row?.isLocked ? t("accountingMappings.yes") : t("accountingMappings.no"),
        });
      }
    }
    return rows;
  }

  function exportAll() {
    if (loadFailed) {
      toast({ title: t("accountingMappings.cantExportBeforeLoad"), variant: "destructive" });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    exportToExcel(buildExportRows(), IO_COLUMNS, `${t("accountingMappings.filenamePrefix")}-${today}`, t("accountingMappings.sheetName"));
    toast({ title: t("accountingMappings.exportSuccess") });
  }

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function parseLocked(v: unknown): boolean | undefined {
    if (v === null || v === undefined || v === "") return undefined;
    const s = String(v).trim().toLowerCase();
    if (["نعم", "yes", "y", "true", "1", "✓", "✔"].includes(s)) return true;
    if (["لا", "no", "n", "false", "0", "x", "✗"].includes(s)) return false;
    return undefined;
  }

  const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
  const IMPORT_MAX_ROWS  = 10_000;

  const importMut = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > IMPORT_MAX_BYTES) {
        throw new Error(t("accountingMappings.fileTooLarge", { mb: Math.round(IMPORT_MAX_BYTES / (1024 * 1024)) }));
      }
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error(t("accountingMappings.noWorksheet"));

      const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
      if (aoa.length < 2) throw new Error(t("accountingMappings.fileEmpty"));
      if (aoa.length > IMPORT_MAX_ROWS + 1) {
        throw new Error(t("accountingMappings.tooManyRows", { max: IMPORT_MAX_ROWS }));
      }

      const headerRow = (aoa[0] ?? []).map((h: any) => String(h ?? "").trim());
      const headerKeyByLabel: Record<string, string> = {};
      for (const c of IO_COLUMNS) {
        headerKeyByLabel[c.header] = c.key;
        headerKeyByLabel[c.key] = c.key;
      }
      const colIndex: Record<string, number> = {};
      headerRow.forEach((h, i) => {
        const k = headerKeyByLabel[h];
        if (k && colIndex[k] === undefined) colIndex[k] = i;
      });
      if (colIndex.docTypeKey === undefined || colIndex.roleKey === undefined) {
        throw new Error(t("accountingMappings.missingMatchCols"));
      }

      const accById = new Map<number, any>(accounts.map((a: any) => [a.id, a]));
      const accByCode = new Map<string, any>(
        accounts
          .filter((a: any) => a.code != null && a.code !== "")
          .map((a: any) => [String(a.code).trim(), a]),
      );

      const docTypeMap = new Map<string, DocumentTypeDef>(DOCUMENT_TYPES.map(d => [d.key, d]));

      const itemsByKey = new Map<string, MappingRow>(
        Object.values(state).map(r => [`${r.documentType}.${r.roleKey}`, { ...r }]),
      );
      const changedItems: MappingRow[] = [];

      let updated = 0;
      let unchanged = 0;
      let lockedSkipped = 0;
      const skippedUnknown: string[] = [];
      const accountNotFound: string[] = [];

      for (let r = 1; r < aoa.length; r++) {
        const row = aoa[r] ?? [];
        const docTypeKey = String(row[colIndex.docTypeKey] ?? "").trim();
        const roleKey    = String(row[colIndex.roleKey] ?? "").trim();
        if (!docTypeKey && !roleKey) continue;

        const doc = docTypeMap.get(docTypeKey);
        const role = doc?.roles.find(rr => rr.key === roleKey);
        if (!doc || !role) {
          skippedUnknown.push(`${docTypeKey || "?"}.${roleKey || "?"}`);
          continue;
        }

        const k = `${docTypeKey}.${roleKey}`;
        const cur = itemsByKey.get(k);
        if (!cur) continue;

        let nextAccountId: number | null | undefined = undefined;
        const idCellRaw = colIndex.accountId !== undefined ? row[colIndex.accountId] : null;
        const codeCellRaw = colIndex.accountCode !== undefined ? row[colIndex.accountCode] : null;
        const idCell = idCellRaw === null || idCellRaw === undefined ? "" : String(idCellRaw).trim();
        const codeCell = codeCellRaw === null || codeCellRaw === undefined ? "" : String(codeCellRaw).trim();

        if (idCell !== "") {
          const wantsClear = idCell === "-" || idCell === "0";
          const idNum = wantsClear ? null : Number(idCell);
          if (wantsClear) {
            nextAccountId = null;
          } else if (Number.isFinite(idNum) && idNum! > 0 && accById.has(idNum!)) {
            nextAccountId = idNum;
          } else {
            accountNotFound.push(t("accountingMappings.accountNotFoundById", { key: k, id: idCell }));
          }
        } else if (codeCell !== "") {
          const wantsClear = codeCell === "-";
          if (wantsClear) {
            nextAccountId = null;
          } else {
            const acc = accByCode.get(codeCell);
            if (acc) nextAccountId = acc.id;
            else accountNotFound.push(t("accountingMappings.accountNotFoundByCode", { key: k, code: codeCell }));
          }
        }

        const lockedCell = colIndex.lockedLabel !== undefined ? row[colIndex.lockedLabel] : undefined;
        const nextLocked = parseLocked(lockedCell);

        const changed =
          (nextAccountId !== undefined && nextAccountId !== cur.accountId) ||
          (nextLocked   !== undefined && nextLocked   !== cur.isLocked);
        if (!changed) { unchanged++; continue; }

        if (cur.isLocked) {
          const onlyUnlock =
            nextLocked === false &&
            (nextAccountId === undefined || nextAccountId === cur.accountId);
          if (!onlyUnlock) {
            lockedSkipped++;
            continue;
          }
        }

        updated++;
        const merged: MappingRow = {
          ...cur,
          accountId: nextAccountId !== undefined ? nextAccountId : cur.accountId,
          isLocked:  nextLocked   !== undefined ? nextLocked   : cur.isLocked,
        };
        itemsByKey.set(k, merged);
        changedItems.push(merged);
      }

      if (updated === 0) {
        return { updated: 0, unchanged, lockedSkipped, skippedUnknown, accountNotFound, rows: null as MappingRow[] | null };
      }

      const res = await fetch(`${API}/api/accounting-mappings/bulk`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid, items: changedItems }),
      });
      if (!res.ok) {
        const text = await res.text(); let m = text;
        try { m = JSON.parse(text).error ?? text; } catch {}
        throw new Error(m || t("accountingMappings.saveBulkFailed"));
      }
      const rows = (await res.json()) as MappingRow[];
      return { updated, unchanged, lockedSkipped, skippedUnknown, accountNotFound, rows };
    },
    onSuccess: (r) => {
      if (r.rows) {
        qc.invalidateQueries({ queryKey: ["accounting-mappings", cid] });
        setState(prev => {
          const next = { ...prev };
          for (const row of r.rows!) {
            const k = `${row.documentType}.${row.roleKey}`;
            if (next[k]) next[k] = { ...next[k]!, accountId: row.accountId, isLocked: row.isLocked };
          }
          return next;
        });
      }
      const parts = [t("accountingMappings.summaryUpdated", { n: r.updated })];
      if (r.unchanged)             parts.push(t("accountingMappings.summaryUnchanged",        { n: r.unchanged }));
      if (r.lockedSkipped)         parts.push(t("accountingMappings.summaryLockedSkipped",    { n: r.lockedSkipped }));
      if (r.skippedUnknown.length) parts.push(t("accountingMappings.summaryUnknownRows",      { n: r.skippedUnknown.length }));
      if (r.accountNotFound.length) parts.push(t("accountingMappings.summaryAccountsNotFound", { n: r.accountNotFound.length }));
      toast({
        title: r.updated ? t("accountingMappings.importSuccessTitle") : t("accountingMappings.importNoChanges"),
        description: parts.join(" • "),
        variant: r.accountNotFound.length || r.skippedUnknown.length || r.lockedSkipped ? "default" : undefined,
      });
    },
    onError: (e: any) =>
      toast({ title: t("accountingMappings.importErrorTitle"), description: e?.message, variant: "destructive" }),
  });

  const anyBulkPending = importMut.isPending || saveMut.isPending || seedLcMut.isPending || seedDefaultsMut.isPending;

  function onPickImportFile(file: File) {
    if (loadFailed) {
      toast({ title: t("accountingMappings.cantImportBeforeLoad"), variant: "destructive" });
      return;
    }
    importMut.mutate(file);
  }

  const completion = useMemo(() => {
    const total = DOCUMENT_TYPES.reduce((n, d) => n + d.roles.length, 0);
    const done = Object.values(state).filter(r => r.accountId).length;
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
  }, [state]);

  return (
    <div className="space-y-6 max-w-7xl" dir={isAr ? "rtl" : "ltr"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BookMarked className="h-6 w-6 text-primary" />
            {t("accountingMappings.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("accountingMappings.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-muted-foreground px-3 py-1.5 rounded-full bg-muted">
            {t("accountingMappings.completion")}: <span className="font-semibold text-foreground">{completion.done}/{completion.total}</span> ({completion.pct}%)
          </div>
          <Button variant="outline" size="sm" className="gap-1 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
            onClick={() => seedDefaultsMut.mutate(false)} disabled={anyBulkPending || !cid}
            title={t("accountingMappings.applyDefaultsTitle")}>
            {seedDefaultsMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {t("accountingMappings.applyDefaults")}
          </Button>
          <Button variant="outline" size="sm" className="gap-1 border-blue-300 text-blue-700 hover:bg-blue-50"
            onClick={() => seedLcMut.mutate()} disabled={anyBulkPending || !cid}>
            {seedLcMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileStack className="h-4 w-4" />}
            {t("accountingMappings.createLcAccounts")}
          </Button>
          <Button variant="outline" size="sm" className="gap-1"
            onClick={exportAll} disabled={loadingMaps || !!loadFailed}>
            <Download className="h-4 w-4" />{t("accountingMappings.exportExcel")}
          </Button>
          <Button variant="outline" size="sm" className="gap-1"
            onClick={() => fileInputRef.current?.click()}
            disabled={loadingMaps || !!loadFailed || anyBulkPending}>
            {importMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {t("accountingMappings.importExcel")}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPickImportFile(f);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          <Button variant="outline" size="sm" className="gap-1" onClick={aiSuggestAll} disabled={anyBulkPending}>
            <Wand2 className="h-4 w-4" />{t("accountingMappings.aiSuggestAll")}
          </Button>
          <Button size="sm" className="gap-1" onClick={() => saveMut.mutate(undefined)} disabled={anyBulkPending}>
            {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t("accountingMappings.saveAll")}
          </Button>
        </div>
      </div>

      {loadingMaps ? (
        <div className="text-center py-12 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin inline" /></div>
      ) : loadFailed ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="text-sm text-destructive font-medium">
            {(mapsErrorObj as any)?.message ?? t("accountingMappings.loadFailedDefault")}
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            {t("accountingMappings.loadFailedHint")}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {DOCUMENT_TYPES.map(doc => {
            const locked = groupLocked(doc.key);
            return (
              <Card key={doc.key} className={locked ? "border-amber-200 bg-amber-50/30" : ""}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-base truncate">{doc.label}</h3>
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{doc.description}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 text-xs">
                      <Checkbox
                        id={`lock-${doc.key}`}
                        checked={locked}
                        onCheckedChange={(v) => toggleGroupLock(doc.key, !!v)}
                      />
                      <label htmlFor={`lock-${doc.key}`} className="flex items-center gap-1.5 cursor-pointer select-none">
                        {locked ? <Lock className="h-3.5 w-3.5 text-amber-600" /> : <Unlock className="h-3.5 w-3.5 text-muted-foreground" />}
                        <span>{locked ? t("accountingMappings.groupLockOn") : t("accountingMappings.groupLockOff")}</span>
                      </label>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  {doc.roles.map(role => {
                    const k = `${doc.key}.${role.key}`;
                    const row = state[k];
                    const busy = !!aiBusy[k];
                    const reasoning = aiReasoning[k];
                    return (
                      <div key={role.key} className="space-y-1.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <Label className="text-xs font-medium text-foreground/80">{role.label}</Label>
                            <p className="text-[11px] text-muted-foreground flex items-start gap-1 leading-snug mt-0.5">
                              <Info className="h-3 w-3 shrink-0 mt-0.5" />{role.description}
                            </p>
                          </div>
                          <Button
                            type="button" size="sm" variant="ghost"
                            className="h-7 px-2 text-xs gap-1 text-primary hover:bg-primary/10 shrink-0"
                            disabled={busy || locked}
                            onClick={() => aiSuggest(doc, role.key)}
                          >
                            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                            {t("accountingMappings.suggest")}
                          </Button>
                        </div>
                        <AccountCombobox
                          value={row?.accountId ? String(row.accountId) : ""}
                          onValueChange={(v) => setAccount(doc.key, role.key, v ? Number(v) : null)}
                          filterTypes={role.accountType ? [role.accountType] : undefined}
                          disabled={locked}
                          placeholder={role.defaultHintCode
                            ? t("accountingMappings.accountHintPrefix", { code: role.defaultHintCode })
                            : t("accountingMappings.accountPlaceholder")}
                        />
                        {reasoning && (
                          <p className="text-[11px] text-primary/80 bg-primary/5 rounded px-2 py-1 leading-snug">
                            <Sparkles className="h-3 w-3 inline ml-1" />{reasoning}
                          </p>
                        )}
                      </div>
                    );
                  })}
                  <div className="flex justify-end pt-2 border-t">
                    <Button size="sm" variant="outline" className="gap-1 h-7 text-xs"
                      onClick={() => saveMut.mutate(doc.key)} disabled={saveMut.isPending}>
                      <Save className="h-3 w-3" />{t("accountingMappings.saveGroup")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
