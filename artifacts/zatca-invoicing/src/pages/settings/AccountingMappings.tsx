import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { AccountCombobox } from "@/components/AccountCombobox";
import { Lock, Unlock, Sparkles, Save, Info, Loader2, BookMarked, Wand2, FileStack } from "lucide-react";
import { DOCUMENT_TYPES, type DocumentTypeDef } from "@/config/accountingMappings";

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

  useEffect(() => {
    const next: Record<string, MappingRow> = {};
    for (const dt of DOCUMENT_TYPES) {
      for (const r of dt.roles) {
        const key = `${dt.key}.${r.key}`;
        const found = serverMappings.find(m => m.documentType === dt.key && m.roleKey === r.key);
        next[key] = {
          documentType: dt.key,
          roleKey: r.key,
          accountId: found?.accountId ?? null,
          isLocked: !!found?.isLocked,
        };
      }
    }
    setState(next);
  }, [serverMappings]);

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

  // Save mutation
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
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounting-mappings", cid] });
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
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["accounts", cid] });
      qc.invalidateQueries({ queryKey: ["accounting-mappings", cid] });
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
            onClick={() => seedLcMut.mutate()} disabled={seedLcMut.isPending || !cid}>
            {seedLcMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileStack className="h-4 w-4" />}
            إنشاء حسابات الاعتماد المستندي
          </Button>
          <Button variant="outline" size="sm" className="gap-1" onClick={aiSuggestAll}>
            <Wand2 className="h-4 w-4" />اقتراح الكل بالذكاء الاصطناعي
          </Button>
          <Button size="sm" className="gap-1" onClick={() => saveMut.mutate(undefined)} disabled={saveMut.isPending}>
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
                    <label className="flex items-center gap-1.5 shrink-0 cursor-pointer text-xs">
                      <Checkbox checked={locked} onCheckedChange={(v) => toggleGroupLock(doc.key, !!v)} />
                      {locked ? <Lock className="h-3.5 w-3.5 text-amber-600" /> : <Unlock className="h-3.5 w-3.5 text-muted-foreground" />}
                      <span>{locked ? "محفوظ دائم" : "قفل دائم"}</span>
                    </label>
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
