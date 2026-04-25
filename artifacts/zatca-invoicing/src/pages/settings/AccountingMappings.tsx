import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  // Load mappings — fail-closed: throw on non-OK so UI stays in loading/error state
  // instead of presenting empty mappings which could be saved and wipe existing rows.
  const { data: serverMappings = [], isLoading: loadingMaps, isError: mapsError, error: mapsErrorObj } = useQuery<MappingRow[]>({
    queryKey: ["accounting-mappings", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/accounting-mappings?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error(`فشل تحميل الربط المحاسبي (${r.status})`);
      return r.json();
    },
    enabled: !!cid,
    retry: 1,
  });

  // Load accounts for AI context
  const { data: accounts = [], isError: accountsError } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/accounts?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل شجرة الحسابات");
      return r.json();
    },
    enabled: !!cid,
    staleTime: 60_000,
    retry: 1,
  });

  const loadFailed = mapsError || accountsError;

  // Local state — keyed by `${docType}.${roleKey}`
  const [state, setState] = useState<Record<string, MappingRow>>({});
  const [aiReasoning, setAiReasoning] = useState<Record<string, string>>({});
  const [aiBusy, setAiBusy] = useState<Record<string, boolean>>({});

  // Initialize local state from server data ONCE on first successful load,
  // then explicitly merge after save responses. Without this guard, any
  // background refetch (e.g. after qc.invalidateQueries on save success)
  // would clobber the user's pending edits — including a freshly-toggled
  // lock checkbox that hasn't been saved yet.
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
    if (loadingMaps) return;            // wait for initial fetch to settle
    if (mapsError) return;               // never hydrate from a failed response
    setState(rowsToState(serverMappings));
    hydratedRef.current = true;
  }, [serverMappings, loadingMaps, mapsError]);

  // Group-level isLocked
  const groupLocked = (docType: string) =>
    DOCUMENT_TYPES.find(d => d.key === docType)?.roles.every(r => state[`${docType}.${r.key}`]?.isLocked) ?? false;

  const setAccount = (docType: string, roleKey: string, accountId: number | null) => {
    const k = `${docType}.${roleKey}`;
    if (state[k]?.isLocked) {
      toast({ title: "المجموعة مقفلة — قم بإلغاء القفل للتعديل", variant: "destructive" });
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

  // Save mutation. Per-card save passes a docType so only that group's rows
  // are sent and reconciled — preserving unsaved edits in OTHER cards.
  const saveMut = useMutation({
    mutationFn: async (docType?: string) => {
      if (loadFailed) throw new Error("لا يمكن الحفظ قبل تحميل البيانات بنجاح");
      const items = Object.values(state).filter(r => !docType || r.documentType === docType);
      const res = await fetch(`${API}/api/accounting-mappings/bulk`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid, items }),
      });
      if (!res.ok) {
        const t = await res.text(); let m = t;
        try { m = JSON.parse(t).error ?? t; } catch {}
        throw new Error(m || "فشل الحفظ");
      }
      return { rows: (await res.json()) as MappingRow[], docType };
    },
    onSuccess: ({ rows, docType }) => {
      if (!Array.isArray(rows)) { toast({ title: "تم حفظ الربط المحاسبي" }); return; }
      // Always refresh the query cache with full authoritative server rows.
      qc.setQueryData(["accounting-mappings", cid], rows);
      // For local component state: when saving a single card, ONLY merge rows
      // for that docType — never touch the user's unsaved edits in other
      // cards. For "save all" (no docType), it's safe to fully re-hydrate.
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
      toast({ title: "تم حفظ الربط المحاسبي" });
    },
    onError: (e: any) => toast({ title: "تعذّر الحفظ", description: e?.message, variant: "destructive" }),
  });

  async function aiSuggest(doc: DocumentTypeDef, roleKey: string) {
    const k = `${doc.key}.${roleKey}`;
    if (state[k]?.isLocked) {
      toast({ title: "المجموعة مقفلة — لا يمكن التعديل", variant: "destructive" });
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
      if (!res.ok) throw new Error((await res.json()).error ?? "خطأ");
      const data = await res.json();
      if (data.accountId) {
        setState(s => ({ ...s, [k]: { ...s[k]!, accountId: Number(data.accountId) } }));
      }
      if (data.created) {
        await qc.invalidateQueries({ queryKey: ["accounts", cid] });
      }
      setAiReasoning(r => ({ ...r, [k]: data.reasoning || "" }));
      const title = data.created
        ? `تم إنشاء حساب جديد: ${data.createdAccount?.code} — ${data.createdAccount?.nameAr}`
        : data.accountId ? "تم اقتراح حساب" : "لم يجد الذكاء الاصطناعي حساباً مناسباً";
      toast({ title, description: data.reasoning?.slice(0, 160) });
    } catch (e: any) {
      toast({ title: "فشل اقتراح الذكاء الاصطناعي", description: e?.message, variant: "destructive" });
    } finally {
      setAiBusy(b => ({ ...b, [k]: false }));
    }
  }

  const seedLcMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/accounting-mappings/seed-lc`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid }),
      });
      if (!res.ok) {
        const t = await res.text(); let m = t;
        try { m = JSON.parse(t).error ?? t; } catch {}
        throw new Error(m || "فشل إنشاء حسابات الاعتماد المستندي");
      }
      return res.json();
    },
    onSuccess: async (data) => {
      qc.invalidateQueries({ queryKey: ["accounts", cid] });
      // Re-fetch authoritative mappings and merge ONLY the LC group's rows
      // into local state — other cards keep their unsaved edits intact.
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
        title: "تم إعداد حسابات الاعتماد المستندي",
        description: `تم إنشاء ${created} حساب جديد وإعادة استخدام ${reused}. افتح بطاقة «الاعتمادات المستندية» بالأسفل.`,
      });
    },
    onError: (e: any) => toast({ title: "تعذّر الإنشاء", description: e?.message, variant: "destructive" }),
  });

  async function aiSuggestAll() {
    for (const doc of DOCUMENT_TYPES) {
      for (const r of doc.roles) {
        const k = `${doc.key}.${r.key}`;
        if (state[k]?.isLocked || state[k]?.accountId) continue;
        await aiSuggest(doc, r.key);
      }
    }
    // Persist newly mapped accounts (including AI-created ones) to the server
    try { await saveMut.mutateAsync(undefined); } catch {}
  }

  // ── Excel Export / Import ──────────────────────────────────────────────
  // Stable column schema. The first two columns (`docTypeKey`, `roleKey`) are
  // the *machine* keys we use to match rows on import — they must NEVER be
  // renamed or the round-trip breaks. The label/account-name columns are
  // human-readable convenience and are IGNORED on import. `accountId` is the
  // canonical FK; `accountCode` is a fallback used when the user edits the
  // file by hand and only knows the account code.
  const IO_COLUMNS: ExportColumn[] = [
    { header: "نوع المستند", key: "docTypeLabel", width: 28 },
    { header: "كود نوع المستند", key: "docTypeKey", width: 22 },
    { header: "الدور المحاسبي", key: "roleLabel", width: 28 },
    { header: "كود الدور", key: "roleKey", width: 16 },
    { header: "كود الحساب", key: "accountCode", width: 14 },
    { header: "اسم الحساب", key: "accountName", width: 32 },
    { header: "معرّف الحساب", key: "accountId", width: 14 },
    { header: "مقفل", key: "lockedLabel", width: 8 },
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
          lockedLabel:  row?.isLocked ? "نعم" : "لا",
        });
      }
    }
    return rows;
  }

  function exportAll() {
    if (loadFailed) {
      toast({ title: "تعذّر التصدير قبل تحميل البيانات", variant: "destructive" });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    exportToExcel(buildExportRows(), IO_COLUMNS, `accounting-mappings-${today}`, "ربط القيود");
    toast({ title: "تم تصدير الملف" });
  }

  // Hidden file picker for import
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Truthy/yes/no parsing tolerant of Arabic, English, common spellings.
  function parseLocked(v: unknown): boolean | undefined {
    if (v === null || v === undefined || v === "") return undefined;
    const s = String(v).trim().toLowerCase();
    if (["نعم", "yes", "y", "true", "1", "✓", "✔"].includes(s)) return true;
    if (["لا", "no", "n", "false", "0", "x", "✗"].includes(s)) return false;
    return undefined;
  }

  // Hard caps to keep a malicious or accidentally-huge file from freezing
  // the browser tab or DOSing the bulk endpoint. The mappings table has
  // ~50 rows in steady state; 10k is several orders of magnitude of safety
  // margin while still rejecting million-row files outright.
  const IMPORT_MAX_BYTES = 5 * 1024 * 1024;     // 5 MB
  const IMPORT_MAX_ROWS  = 10_000;

  const importMut = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > IMPORT_MAX_BYTES) {
        throw new Error(`حجم الملف كبير جداً (الحد الأقصى ${Math.round(IMPORT_MAX_BYTES / (1024 * 1024))} ميغابايت)`);
      }
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error("الملف لا يحتوي على أي ورقة عمل");

      // Read as array-of-arrays so we can match headers in either Arabic or
      // the English machine-key (in case the user edited the header row).
      const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
      if (aoa.length < 2) throw new Error("الملف فارغ — يجب أن يحتوي على صفّ عناوين وصف بيانات واحد على الأقل");
      if (aoa.length > IMPORT_MAX_ROWS + 1) {
        throw new Error(`عدد الصفوف يتجاوز الحد الأقصى (${IMPORT_MAX_ROWS} صف)`);
      }

      const headerRow = (aoa[0] ?? []).map((h: any) => String(h ?? "").trim());
      // Build a header-name → column-index map. Accept both the human label
      // ("نوع المستند") and the machine key ("docTypeKey") interchangeably.
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
        throw new Error("الملف لا يحتوي على عمودي «كود نوع المستند» و «كود الدور» المطلوبَين للمطابقة");
      }

      // Index accounts by id and by code for quick lookup
      const accById = new Map<number, any>(accounts.map((a: any) => [a.id, a]));
      const accByCode = new Map<string, any>(
        accounts
          .filter((a: any) => a.code != null && a.code !== "")
          .map((a: any) => [String(a.code).trim(), a]),
      );

      // Index DOCUMENT_TYPES so we can validate (docType, role) pairs
      const docTypeMap = new Map<string, DocumentTypeDef>(DOCUMENT_TYPES.map(d => [d.key, d]));

      // Snapshot the existing state ONLY for change-detection / lock-checks.
      // We deliberately do NOT send the entire snapshot to the server later
      // — only the rows we actually modified — so a stale local state cannot
      // overwrite changes another tab/user made between page-load and import.
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
        if (!docTypeKey && !roleKey) continue;  // blank line

        const doc = docTypeMap.get(docTypeKey);
        const role = doc?.roles.find(rr => rr.key === roleKey);
        if (!doc || !role) {
          skippedUnknown.push(`${docTypeKey || "?"}.${roleKey || "?"}`);
          continue;
        }

        const k = `${docTypeKey}.${roleKey}`;
        const cur = itemsByKey.get(k);
        if (!cur) continue;  // shouldn't happen — state covers all defs

        // Resolve account: prefer accountId column, then accountCode. An
        // empty cell means "leave unchanged"; an explicit "-" or "0"
        // means "clear the mapping".
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
            accountNotFound.push(`${k} → معرّف ${idCell}`);
          }
        } else if (codeCell !== "") {
          const wantsClear = codeCell === "-";
          if (wantsClear) {
            nextAccountId = null;
          } else {
            const acc = accByCode.get(codeCell);
            if (acc) nextAccountId = acc.id;
            else accountNotFound.push(`${k} → كود ${codeCell}`);
          }
        }

        // Resolve lock state: empty cell ⇒ leave unchanged
        const lockedCell = colIndex.lockedLabel !== undefined ? row[colIndex.lockedLabel] : undefined;
        const nextLocked = parseLocked(lockedCell);

        // Detect change vs current state to surface a meaningful summary
        const changed =
          (nextAccountId !== undefined && nextAccountId !== cur.accountId) ||
          (nextLocked   !== undefined && nextLocked   !== cur.isLocked);
        if (!changed) { unchanged++; continue; }

        // LOCK PROTECTION: if the row is currently locked in the LOCAL state,
        // refuse to mutate it from import — same UX guarantee as the manual
        // edit path (which blocks setAccount when isLocked is true). Allow the
        // import to UNLOCK a row only as an explicit, isolated operation —
        // i.e. when the only change is `isLocked: true → false` and the
        // account stays the same. That keeps the lock as a real safety
        // gate while still letting the user unlock-via-import when intended.
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

      // Send ONLY the rows we actually modified — never the whole snapshot.
      // This eliminates the "stale full-state PUT clobbers concurrent edits"
      // risk: the bulk endpoint upserts what we send and leaves everything
      // else untouched.
      const res = await fetch(`${API}/api/accounting-mappings/bulk`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid, items: changedItems }),
      });
      if (!res.ok) {
        const t = await res.text(); let m = t;
        try { m = JSON.parse(t).error ?? t; } catch {}
        throw new Error(m || "فشل حفظ البيانات المستوردة");
      }
      const rows = (await res.json()) as MappingRow[];
      return { updated, unchanged, lockedSkipped, skippedUnknown, accountNotFound, rows };
    },
    onSuccess: (r) => {
      if (r.rows) {
        // Authoritative server response is the truth — re-fetch the FULL
        // mappings list from the server (rather than just patching the
        // changed rows into local state). This guarantees we display any
        // concurrent edits another tab/user made instead of overwriting
        // our local cache with a partial view.
        qc.invalidateQueries({ queryKey: ["accounting-mappings", cid] });
        // Eagerly merge server-confirmed rows into local state for snappier
        // UI feedback while the refetch is in flight.
        setState(prev => {
          const next = { ...prev };
          for (const row of r.rows!) {
            const k = `${row.documentType}.${row.roleKey}`;
            if (next[k]) next[k] = { ...next[k]!, accountId: row.accountId, isLocked: row.isLocked };
          }
          return next;
        });
      }
      const parts = [`تم تحديث ${r.updated} سجل`];
      if (r.unchanged)            parts.push(`${r.unchanged} بدون تغيير`);
      if (r.lockedSkipped)        parts.push(`${r.lockedSkipped} مقفل (تم تجاهله)`);
      if (r.skippedUnknown.length) parts.push(`${r.skippedUnknown.length} صفّ غير معروف`);
      if (r.accountNotFound.length) parts.push(`${r.accountNotFound.length} حساب لم يُعثر عليه`);
      toast({
        title: r.updated ? "تم استيراد الملف" : "لم تطرأ أي تغييرات",
        description: parts.join(" • "),
        variant: r.accountNotFound.length || r.skippedUnknown.length || r.lockedSkipped ? "default" : undefined,
      });
    },
    onError: (e: any) =>
      toast({ title: "تعذّر استيراد الملف", description: e?.message, variant: "destructive" }),
  });

  // Mutual-exclusion gate: when ANY of import / save / AI-suggest-all is in
  // flight we disable the others to prevent overlapping bulk writes from
  // racing on the same endpoint (last-write-wins). AI per-row suggestions
  // don't write to the bulk endpoint themselves, so they're not gated here.
  const anyBulkPending = importMut.isPending || saveMut.isPending || seedLcMut.isPending;

  function onPickImportFile(file: File) {
    if (loadFailed) {
      toast({ title: "تعذّر الاستيراد قبل تحميل البيانات", variant: "destructive" });
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
    <div className="space-y-6 max-w-7xl" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BookMarked className="h-6 w-6 text-primary" />
            ربط القيود المحاسبية
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            اختر الحسابات التي تُستخدم تلقائياً لترحيل القيود لكل نوع مستند. استخدم الذكاء الاصطناعي لاقتراح أفضل حساب من شجرة حساباتك.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-muted-foreground px-3 py-1.5 rounded-full bg-muted">
            اكتمال: <span className="font-semibold text-foreground">{completion.done}/{completion.total}</span> ({completion.pct}%)
          </div>
          <Button variant="outline" size="sm" className="gap-1 border-blue-300 text-blue-700 hover:bg-blue-50"
            onClick={() => seedLcMut.mutate()} disabled={anyBulkPending || !cid}>
            {seedLcMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileStack className="h-4 w-4" />}
            إنشاء حسابات الاعتماد المستندي
          </Button>
          <Button variant="outline" size="sm" className="gap-1"
            onClick={exportAll} disabled={loadingMaps || !!loadFailed}>
            <Download className="h-4 w-4" />تصدير Excel
          </Button>
          <Button variant="outline" size="sm" className="gap-1"
            onClick={() => fileInputRef.current?.click()}
            disabled={loadingMaps || !!loadFailed || anyBulkPending}>
            {importMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            استيراد Excel
          </Button>
          {/* Hidden file picker triggered by the import button. We reset the
              input value after each pick so re-uploading the same file fires
              onChange again. */}
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
            <Wand2 className="h-4 w-4" />اقتراح الكل بالذكاء الاصطناعي
          </Button>
          <Button size="sm" className="gap-1" onClick={() => saveMut.mutate(undefined)} disabled={anyBulkPending}>
            {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            حفظ الكل
          </Button>
        </div>
      </div>

      {loadingMaps ? (
        <div className="text-center py-12 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin inline" /></div>
      ) : loadFailed ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="text-sm text-destructive font-medium">
            {(mapsErrorObj as any)?.message ?? "تعذّر تحميل البيانات"}
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            الرجاء تحديث الصفحة أو المحاولة لاحقاً. لن يتم السماح بالحفظ أثناء فشل التحميل لتفادي فقدان الإعدادات.
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
                    {/* Radix Checkbox is a <button>; wrapping it in <label> causes
                        the click to fire twice (label → forwarded click → button),
                        which silently cancels out the toggle and explains why the
                        UI appeared checked once but the state never actually
                        flipped. Use sibling htmlFor instead. */}
                    <div className="flex items-center gap-1.5 shrink-0 text-xs">
                      <Checkbox
                        id={`lock-${doc.key}`}
                        checked={locked}
                        onCheckedChange={(v) => toggleGroupLock(doc.key, !!v)}
                      />
                      <label htmlFor={`lock-${doc.key}`} className="flex items-center gap-1.5 cursor-pointer select-none">
                        {locked ? <Lock className="h-3.5 w-3.5 text-amber-600" /> : <Unlock className="h-3.5 w-3.5 text-muted-foreground" />}
                        <span>{locked ? "محفوظ دائم" : "قفل دائم"}</span>
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
                            اقتراح
                          </Button>
                        </div>
                        <AccountCombobox
                          value={row?.accountId ? String(row.accountId) : ""}
                          onValueChange={(v) => setAccount(doc.key, role.key, v ? Number(v) : null)}
                          filterTypes={role.accountType ? [role.accountType] : undefined}
                          disabled={locked}
                          placeholder={role.defaultHintCode ? `يُفضّل حساب يبدأ بـ ${role.defaultHintCode}` : "— اختر حساباً —"}
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
                      <Save className="h-3 w-3" />حفظ هذه المجموعة
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
