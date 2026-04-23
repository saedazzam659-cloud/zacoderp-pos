import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Banknote, CreditCard, Smartphone, Wallet, Save, Loader2, Building2, Info, Check, ChevronsUpDown, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type ComboOption = { value: string; label: string; keywords?: string };

function SearchCombobox({
  value, onChange, options, placeholder, emptyText, searchPlaceholder, allowClear = true, className, testId,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  options: ComboOption[];
  placeholder: string;
  emptyText: string;
  searchPlaceholder: string;
  allowClear?: boolean;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find(o => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          data-testid={testId}
          className={cn("w-full justify-between font-normal", !selected && "text-muted-foreground", className)}
        >
          <span className="truncate text-start">{selected?.label ?? placeholder}</span>
          <span className="flex items-center gap-1 shrink-0 ms-2">
            {allowClear && selected && (
              <button
                type="button"
                aria-label="مسح الاختيار"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onChange(null); } }}
                className="opacity-50 hover:opacity-100 focus:opacity-100 focus:outline-none rounded"
              ><X className="w-3.5 h-3.5" /></button>
            )}
            <ChevronsUpDown className="w-4 h-4 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map(opt => (
                <CommandItem
                  key={opt.value}
                  value={`${opt.label} ${opt.keywords ?? ""}`}
                  onSelect={() => {
                    if (opt.value === value) {
                      if (allowClear) onChange(null);
                    } else {
                      onChange(opt.value);
                    }
                    setOpen(false);
                  }}
                >
                  <Check className={cn("me-2 h-4 w-4", value === opt.value ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{opt.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type CashBox     = { id: number; nameAr: string; code?: string; accountId?: number | null };
type BankAccount = { id: number; nameAr: string; bankName?: string | null; accountId?: number | null };
type Account     = { id: number; code: string; nameAr: string };
type Company     = { id: number; nameAr: string };

type Settings = {
  posCashCashBoxId:       number | null;
  posCardBankAccountId:   number | null;
  posAppleBankAccountId:  number | null;
  posWalletBankAccountId: number | null;
};

export default function PosSettings() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isSuperAdmin = user?.role === "superadmin";

  const [companyId, setCompanyId] = useState<number | null>(user?.companyId ?? null);
  useEffect(() => { if (user?.companyId) setCompanyId(user.companyId); }, [user?.companyId]);

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const companiesQ = useQuery<Company[]>({
    queryKey: ["pos-settings-companies"],
    enabled: isSuperAdmin,
    queryFn: async () => {
      const r = await fetch(`${API}/api/companies`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الشركات");
      return r.json();
    },
  });

  const cidQS = companyId ? `?companyId=${companyId}` : "";

  const settingsQ = useQuery<Settings>({
    queryKey: ["pos-settings", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/companies/${companyId}/pos-settings`, { headers });
      if (!r.ok) throw new Error("فشل تحميل إعدادات نقاط البيع");
      return r.json();
    },
  });

  const cashBoxesQ = useQuery<CashBox[]>({
    queryKey: ["pos-settings-cashboxes", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/cash-boxes${cidQS}`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const bankAccountsQ = useQuery<BankAccount[]>({
    queryKey: ["pos-settings-banks", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/bank-accounts${cidQS}`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const accountsQ = useQuery<Account[]>({
    queryKey: ["pos-settings-accounts", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/accounts${cidQS}`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const accountById = useMemo(() => {
    const m = new Map<number, Account>();
    (accountsQ.data ?? []).forEach(a => m.set(a.id, a));
    return m;
  }, [accountsQ.data]);

  const [draft, setDraft] = useState<Settings>({
    posCashCashBoxId: null, posCardBankAccountId: null, posAppleBankAccountId: null, posWalletBankAccountId: null,
  });
  useEffect(() => {
    if (settingsQ.data) setDraft(settingsQ.data);
  }, [settingsQ.data]);

  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/companies/${companyId}/pos-settings`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || "فشل الحفظ");
      }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "تم حفظ إعدادات الدفع لنقاط البيع" });
      qc.invalidateQueries({ queryKey: ["pos-settings", companyId] });
    },
    onError: (e: any) => toast({ title: "خطأ في الحفظ", description: e?.message, variant: "destructive" }),
  });

  const accountLabel = (id: number | null | undefined) => {
    if (!id) return "بدون حساب محاسبي مرتبط";
    const a = accountById.get(id);
    return a ? `${a.code} — ${a.nameAr}` : `حساب #${id}`;
  };

  const cashBoxOption = (cb: CashBox) =>
    `${cb.nameAr}${cb.accountId ? "  •  " + accountLabel(cb.accountId) : "  •  ⚠ بدون حساب محاسبي"}`;
  const bankOption = (b: BankAccount) =>
    `${b.nameAr}${b.bankName ? " (" + b.bankName + ")" : ""}${b.accountId ? "  •  " + accountLabel(b.accountId) : "  •  ⚠ بدون حساب محاسبي"}`;

  const Row = ({ icon: Icon, color, title, subtitle, kind, value, onChange }: {
    icon: any; color: string; title: string; subtitle: string;
    kind: "cashbox" | "bank";
    value: number | null; onChange: (v: number | null) => void;
  }) => {
    const list = kind === "cashbox" ? (cashBoxesQ.data ?? []) : (bankAccountsQ.data ?? []);
    const linkedAcc = kind === "cashbox"
      ? cashBoxesQ.data?.find(x => x.id === value)?.accountId ?? null
      : bankAccountsQ.data?.find(x => x.id === value)?.accountId ?? null;
    return (
      <div className="rounded-xl border bg-card p-5 flex flex-col md:flex-row md:items-center gap-4">
        <div className={`shrink-0 w-12 h-12 rounded-xl flex items-center justify-center ${color}`}>
          <Icon className="w-6 h-6 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-base">{title}</div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
        <div className="flex-1 min-w-[260px]">
          <Label className="text-xs text-muted-foreground mb-1 block">
            {kind === "cashbox" ? "اختر صندوق نقدي" : "اختر حساب بنكي"}
          </Label>
          <SearchCombobox
            testId={`select-${title}`}
            value={value ? String(value) : null}
            onChange={(v) => onChange(v ? Number(v) : null)}
            placeholder="— بدون ربط —"
            searchPlaceholder={kind === "cashbox" ? "ابحث عن صندوق نقدي..." : "ابحث عن حساب بنكي..."}
            emptyText="لا توجد نتائج"
            options={list.map((x: any) => {
              const label = kind === "cashbox" ? cashBoxOption(x) : bankOption(x);
              const acc = accountById.get(x.accountId ?? -1);
              return {
                value: String(x.id),
                label,
                keywords: [x.nameAr, (x as any).bankName, (x as any).code, acc?.code, acc?.nameAr].filter(Boolean).join(" "),
              };
            })}
          />
          {value && (
            <div className="mt-1.5 text-[11px] flex items-center gap-1 text-muted-foreground">
              <span>الترحيل المحاسبي إلى:</span>
              <span className="font-semibold text-foreground">{accountLabel(linkedAcc)}</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="w-6 h-6 text-primary" />
            ربط طرق الدفع بالحسابات العامة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            حدّد لكل طريقة دفع في نقاط البيع الصندوق أو الحساب البنكي اللي يستلم النقدية، ويظهر تحته الحساب المحاسبي اللي راح يقيد فيه القيد تلقائياً.
          </p>
        </div>
        {isSuperAdmin && (
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-muted-foreground" />
            <SearchCombobox
              testId="select-company"
              className="w-64"
              value={companyId ? String(companyId) : null}
              onChange={(v) => setCompanyId(v ? Number(v) : null)}
              placeholder="اختر شركة"
              searchPlaceholder="ابحث عن شركة..."
              emptyText="لا توجد شركات"
              allowClear={false}
              options={(companiesQ.data ?? []).map(c => ({
                value: String(c.id),
                label: c.nameAr,
                keywords: c.nameAr,
              }))}
            />
          </div>
        )}
      </div>

      {!companyId ? (
        <Card><CardContent className="p-10 text-center text-muted-foreground">اختر شركة للمتابعة</CardContent></Card>
      ) : settingsQ.isLoading ? (
        <Card><CardContent className="p-10 grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-primary" /></CardContent></Card>
      ) : (
        <>
          <Card className="border-blue-200 bg-blue-50">
            <CardContent className="p-4 flex items-start gap-2 text-sm text-blue-900">
              <Info className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                كل صندوق نقدي وحساب بنكي مربوط بحساب من شجرة الحسابات (يظهر بجانبه). عند إتمام أي عملية بيع POS، يقيّد النظام الإيراد في حساب المبيعات وضريبة القيمة المضافة في حساب الضريبة، ويقيد المقابل تلقائيًا في حساب الصندوق/البنك المختار هنا حسب طريقة الدفع.
                <br />
                لو ما اخترت ربطًا لطريقة دفع، الكاشير ما راح يقدر يستخدمها في POS.
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">طرق الدفع</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Row
                icon={Banknote} color="bg-emerald-500"
                title="نقداً" subtitle="المبيعات النقدية المباشرة في الصندوق"
                kind="cashbox" value={draft.posCashCashBoxId}
                onChange={(v) => setDraft(d => ({ ...d, posCashCashBoxId: v }))}
              />
              <Row
                icon={CreditCard} color="bg-blue-500"
                title="شبكة" subtitle="مبيعات نقاط الشبكة (مدى/فيزا/ماستركارد)"
                kind="bank" value={draft.posCardBankAccountId}
                onChange={(v) => setDraft(d => ({ ...d, posCardBankAccountId: v }))}
              />
              <Row
                icon={Smartphone} color="bg-slate-800"
                title="Apple Pay" subtitle="مدفوعات Apple Pay عبر القارئ"
                kind="bank" value={draft.posAppleBankAccountId}
                onChange={(v) => setDraft(d => ({ ...d, posAppleBankAccountId: v }))}
              />
              <Row
                icon={Wallet} color="bg-amber-500"
                title="محفظة" subtitle="محافظ STC Pay / Urpay وما شابهها"
                kind="bank" value={draft.posWalletBankAccountId}
                onChange={(v) => setDraft(d => ({ ...d, posWalletBankAccountId: v }))}
              />
            </CardContent>
          </Card>

          <div className="flex items-center justify-end gap-2">
            <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} data-testid="btn-save">
              {saveMut.isPending ? <Loader2 className="w-4 h-4 animate-spin me-1" /> : <Save className="w-4 h-4 me-1" />}
              حفظ الإعدادات
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
