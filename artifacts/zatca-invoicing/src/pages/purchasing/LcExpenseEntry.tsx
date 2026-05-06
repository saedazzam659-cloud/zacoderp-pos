import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Switch } from "@/components/ui/switch";
import { CreditCard, Plus, Banknote, Loader2, ListOrdered, Sparkles, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

// Standalone "Add LC Expense" page.
// Lets the user pick an existing LC and add a single expense (with optional
// immediate payment from a bank/cash source) without opening the full LC
// edit dialog. Designed for the common workflow where expenses come in
// stages (shipping → customs → insurance → bank fees) over weeks.
export default function LcExpenseEntry() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`purchasingPages.lcExpenseEntry.${k}`, opts) as string;
  const trLc = (k: string, opts?: any) => t(`purchasingPages.lettersOfCredit.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");
  const numLocale = isRtl ? "ar-SA" : "en-US";
  const fmt = (n: any) => Number(n || 0).toLocaleString(numLocale, { minimumFractionDigits: 2 });
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authH   = { Authorization: `Bearer ${token}` };

  const [lcId, setLcId] = useState<string>("");
  const [form, setForm] = useState({
    expenseType: "", accountId: "", amount: "", currencyCode: "SAR", exchangeRate: "1",
    notes: "", date: today(),
  });
  const [payNow, setPayNow] = useState(true);
  const [paySource, setPaySource] = useState<{ type: "bank" | "cash"; id: string }>({ type: "bank", id: "" });

  // Data
  const { data: lcs = [] } = useQuery<any[]>({
    queryKey: ["lc", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/purchasing/letters-of-credit?companyId=${cid}` : `${API}/api/purchasing/letters-of-credit`;
      const res = await fetch(url, { headers: authH }); return res.json();
    },
    enabled: !!user,
  });
  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`;
      const res = await fetch(url, { headers: authH }); return res.json();
    }, enabled: !!user,
  });
  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const res = await fetch(url, { headers: authH }); return res.json();
    }, enabled: !!user,
  });
  const { data: currencies = [] } = useQuery<any[]>({
    queryKey: ["currencies", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/currencies?companyId=${cid}` : `${API}/api/currencies`;
      const res = await fetch(url, { headers: authH }); return res.json();
    }, enabled: !!user,
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/bank-accounts?companyId=${cid}` : `${API}/api/bank-accounts`;
      const res = await fetch(url, { headers: authH }); return res.json();
    }, enabled: !!user,
  });
  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/cash-boxes?companyId=${cid}` : `${API}/api/cash-boxes`;
      const res = await fetch(url, { headers: authH }); return res.json();
    }, enabled: !!user,
  });
  const defaultCurrency = currencies.find((c: any) => c.isDefault) ?? currencies[0];
  const baseCode = defaultCurrency?.code ?? "SAR";

  const selectedLc = useMemo(() => lcs.find((l: any) => String(l.id) === String(lcId)), [lcs, lcId]);

  // Fetch expanded LC (with expenses) for selected LC — used in "recent expenses" panel
  const { data: lcDetail } = useQuery<any>({
    queryKey: ["lc-detail", lcId, cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/purchasing/letters-of-credit/${lcId}?companyId=${cid}` : `${API}/api/purchasing/letters-of-credit/${lcId}`;
      const res = await fetch(url, { headers: authH }); return res.json();
    },
    enabled: !!lcId && !!user,
  });

  async function fetchRateInto(code: string, asOf: string, apply: (r: string) => void) {
    if (!code || code === baseCode) { apply("1"); return; }
    try {
      const res = await fetch(`${API}/api/currencies/lookup-rate?fromCode=${encodeURIComponent(code)}&toCode=${encodeURIComponent(baseCode)}&asOf=${encodeURIComponent(asOf)}`, { headers: authH });
      const j = await res.json();
      const rate = j?.rate && Number(j.rate) > 0 ? String(j.rate) : "1";
      apply(rate);
      if (j?.fallback) toast({ title: trLc("fetchRateMissing"), variant: "destructive" });
    } catch { apply("1"); }
  }

  // When LC selected, prefill expense currency & rate from LC's currency
  useEffect(() => {
    if (!selectedLc) return;
    setForm(p => ({
      ...p,
      currencyCode: p.currencyCode === "SAR" || p.currencyCode === baseCode ? selectedLc.currencyCode : p.currencyCode,
      exchangeRate: String(selectedLc.exchangeRate ?? "1"),
    }));
  }, [selectedLc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // When expense currency changes, auto-fetch rate
  useEffect(() => {
    if (!form.currencyCode || form.currencyCode === baseCode) {
      if (form.exchangeRate !== "1") setForm(p => ({ ...p, exchangeRate: "1" }));
      return;
    }
    fetchRateInto(form.currencyCode, form.date, (r) => setForm(p => ({ ...p, exchangeRate: r })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.currencyCode, form.date, baseCode]);

  // Selectors
  const lcItems = lcs
    .filter((l: any) => l.status !== "closed")
    .map((l: any) => {
      const sup = suppliers.find((s: any) => s.id === l.supplierId);
      const supName = sup ? pickName(sup.nameAr, sup.nameEn) : "";
      return {
        value: String(l.id),
        label: `${l.lcNumber} — ${supName || trLc("supplierNone")} • ${l.currencyCode} ${fmt(l.totalAmount)}`,
      };
    });
  const accountItems  = [{ value: "", label: trLc("accountNone") }, ...accounts.filter((a: any) => a.isPosting).map((a: any) => ({ value: String(a.id), label: `${a.code} — ${pickName(a.nameAr, a.nameEn)}` }))];
  const currencyItems = currencies.length > 0
    ? currencies.map((c: any) => ({ value: c.code, label: `${c.code} — ${pickName(c.nameAr, c.nameEn) || c.code}${c.isDefault ? " ★" : ""}` }))
    : [{ value: "SAR", label: trLc("currencyDefaultNone") }];
  const sourceList = paySource.type === "bank" ? bankAccounts : cashBoxes;
  const sourceItems = [
    { value: "", label: tr("pickSource") },
    ...sourceList.map((s: any) => ({ value: String(s.id), label: pickName(s.nameAr, s.nameEn) })),
  ];

  // Totals preview
  const amt      = Number(form.amount || 0);
  const rate     = Number(form.exchangeRate || 1);
  const baseAmt  = +(amt * rate).toFixed(2);

  // Submit: (1) create the expense; (2) optionally create the funding JE
  const submitMut = useMutation({
    mutationFn: async () => {
      if (!selectedLc) throw new Error(tr("errPickLc"));
      if (!form.expenseType.trim()) throw new Error(tr("errType"));
      if (!form.accountId) throw new Error(tr("errAccount"));
      if (!(amt > 0)) throw new Error(tr("errAmount"));

      // 1) create the expense row on the LC
      const eRes = await fetch(`${API}/api/purchasing/letters-of-credit/${selectedLc.id}/expenses`, {
        method: "POST", headers,
        body: JSON.stringify({
          companyId: cid,
          expenseType: form.expenseType.trim(),
          accountId: form.accountId,
          amount: amt,
          currencyCode: form.currencyCode,
          exchangeRate: rate,
          notes: form.notes || null,
        }),
      });
      const exp = await eRes.json();
      if (!eRes.ok) throw new Error(exp?.error || tr("errCreateExp"));

      // 2) optional immediate payment — same balanced JE the LC dialog posts:
      //   Dr expense account     (baseAmt)
      //   Cr bank/cash source    (baseAmt)
      // Tagged [LC#id][LCE#id] so the LC Statement report can link & resolve source.
      if (payNow) {
        if (!paySource.id) throw new Error(tr("errSource"));
        const src = sourceList.find((s: any) => String(s.id) === String(paySource.id));
        const sourceAccountId = src?.accountId;
        if (!sourceAccountId) throw new Error(trLc("transferSourceAccMissing"));
        const tag  = `[LC#${selectedLc.id}][LCE#${exp.id}]`;
        const desc = `${trLc("transferDefaultDescExp", { lc: selectedLc.lcNumber, exp: form.expenseType.trim() })} ${tag}`;
        const body = {
          companyId: cid,
          entryDate: form.date,
          currency:  form.currencyCode,
          exchangeRate: String(rate),
          description: desc,
          entryType: "lc_expense_payment",
          lines: [
            { accountId: Number(form.accountId), debit: baseAmt, credit: 0,
              description: `${desc} — ${form.expenseType.trim()}` },
            { accountId: Number(sourceAccountId), debit: 0, credit: baseAmt,
              description: `${desc} — ${pickName(src?.nameAr, src?.nameEn) ?? ""}` },
          ],
        };
        const jRes = await fetch(`${API}/api/journal-entries`, {
          method: "POST", headers, body: JSON.stringify(body),
        });
        const j = await jRes.json();
        if (!jRes.ok) throw new Error(j?.error || trLc("transferFailed"));
      }
      return exp;
    },
    onSuccess: () => {
      toast({ title: payNow ? tr("toastSavedAndPaid") : tr("toastSaved") });
      // Reset for the next expense (keep the LC selected so user can add multiple in one go)
      setForm(p => ({ ...p, expenseType: "", accountId: "", amount: "", notes: "" }));
      setPaySource(p => ({ ...p, id: "" }));
      qc.invalidateQueries({ queryKey: ["lc"] });
      qc.invalidateQueries({ queryKey: ["lc-detail", lcId] });
      qc.invalidateQueries({ queryKey: ["journal-entries"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const align = isRtl ? "text-right" : "text-left";

  return (
    <div className="space-y-6 max-w-5xl mx-auto" dir={isRtl ? "rtl" : "ltr"}>
      {/* ─── Page header ───────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="h-6 w-6 text-amber-600" />{tr("title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{tr("subtitle")}</p>
        </div>
        <Link href="/purchasing/lc">
          <Button variant="outline" size="sm" className="gap-2">
            <ListOrdered className="h-4 w-4" />{tr("openLcList")}
          </Button>
        </Link>
      </div>

      {/* ─── 1. LC picker + summary ─────────────────────────────────── */}
      <div className="rounded-xl border bg-gradient-to-br from-emerald-50/50 to-amber-50/50 p-4 shadow-sm space-y-3">
        <Label className="text-xs font-semibold flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-amber-600" />{tr("pickLc")}
        </Label>
        <SearchCombobox items={lcItems} value={lcId} onValueChange={setLcId} placeholder={tr("pickLcPh")} />

        {selectedLc && (() => {
          const sup     = suppliers.find((s: any) => s.id === selectedLc.supplierId);
          const lcBase  = Number(selectedLc.totalAmountBase   ?? selectedLc.totalAmount ?? 0);
          const usedBase = Number(selectedLc.usedAmount ?? 0);
          const expBase  = Number(selectedLc.totalExpensesBase ?? 0);
          const isFx     = selectedLc.currencyCode && selectedLc.baseCurrency && selectedLc.currencyCode !== selectedLc.baseCurrency;
          return (
            <div className="rounded-lg border-2 border-emerald-200 bg-white p-4 grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
              <div>
                <div className="text-[10px] text-muted-foreground mb-0.5">{trLc("colNumber")}</div>
                <div className="font-mono font-bold text-primary">{selectedLc.lcNumber}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground mb-0.5">{trLc("colSupplier")}</div>
                <div className="font-semibold truncate">{sup ? pickName(sup.nameAr, sup.nameEn) : "—"}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground mb-0.5">{trLc("colTotal")} ({selectedLc.currencyCode})</div>
                <div className="font-mono font-bold">{fmt(selectedLc.totalAmount)}</div>
                {isFx && <div className="text-[9px] text-muted-foreground font-mono">≈ {fmt(lcBase)} {selectedLc.baseCurrency}</div>}
              </div>
              <div title={tr("usedHint")}>
                <div className="text-[10px] text-muted-foreground mb-0.5">{tr("usedByInvoices")}</div>
                <div className="font-mono font-bold text-blue-700">{fmt(usedBase)} {selectedLc.baseCurrency || baseCode}</div>
                <div className="text-[9px] text-muted-foreground mt-0.5">{tr("usedPct", { pct: lcBase > 0 ? ((usedBase / lcBase) * 100).toFixed(0) : "0" })}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground mb-0.5">{tr("currentExpenses")}</div>
                <div className="font-mono font-bold text-amber-700">+ {fmt(expBase)} {selectedLc.baseCurrency || baseCode}</div>
                <div className="text-[9px] text-primary mt-0.5">→ {tr("loadedCost")}: {fmt(lcBase + expBase)}</div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* ─── 2. New expense form ────────────────────────────────────── */}
      <fieldset disabled={!selectedLc} className={cn("rounded-xl border bg-card p-5 shadow-sm space-y-4", !selectedLc && "opacity-50")}>
        <div className="flex items-center gap-2 border-b pb-2">
          <Plus className="h-4 w-4 text-amber-600" />
          <h2 className="font-semibold text-sm">{tr("newExpenseTitle")}</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">{trLc("expenseType")} <span className="text-destructive">*</span></Label>
            <Input className={align} placeholder={trLc("expenseTypePh")}
              value={form.expenseType} onChange={e => setForm(p => ({ ...p, expenseType: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{trLc("expenseAccount")} <span className="text-destructive">*</span></Label>
            <SearchCombobox items={accountItems} value={form.accountId}
              onValueChange={v => setForm(p => ({ ...p, accountId: v }))}
              placeholder={trLc("expenseAccountPh")} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{tr("date")}</Label>
            <Input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{trLc("expenseCurrency")}</Label>
            <SearchCombobox items={currencyItems} value={form.currencyCode}
              onValueChange={v => setForm(p => ({ ...p, currencyCode: v }))} placeholder={trLc("fCurrencyPh")} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{trLc("expenseAmount")} <span className="text-destructive">*</span></Label>
            <Input type="text" inputMode="decimal" placeholder="0.00" dir="ltr" className="text-left font-mono"
              value={form.amount}
              onChange={e => setForm(p => ({ ...p, amount: e.target.value.replace(/[^0-9.]/g, "") }))} />
          </div>
          {form.currencyCode && form.currencyCode !== baseCode && (
            <div className="space-y-1.5">
              <Label className="text-xs">{trLc("fExchangeRate")} ({form.currencyCode} → {baseCode})</Label>
              <div className="flex gap-2">
                <Input type="text" inputMode="decimal" dir="ltr" className="text-left font-mono"
                  value={form.exchangeRate}
                  onChange={e => setForm(p => ({ ...p, exchangeRate: e.target.value.replace(/[^0-9.]/g, "") }))} />
                <Button type="button" variant="outline" size="sm" className="shrink-0"
                  onClick={() => fetchRateInto(form.currencyCode, form.date, (r) => setForm(p => ({ ...p, exchangeRate: r })))}>
                  {trLc("fetchRate")}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground font-mono">≈ {fmt(baseAmt)} {baseCode}</p>
            </div>
          )}
          <div className="space-y-1.5 md:col-span-2">
            <Label className="text-xs">{tr("notes")}</Label>
            <Textarea rows={2} className="resize-none text-sm"
              value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
          </div>
        </div>

        {/* ─── 3. Optional immediate payment ─────────────────────── */}
        <div className="rounded-lg border-2 border-dashed border-emerald-200 bg-emerald-50/40 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs font-semibold flex items-center gap-1.5">
              <Banknote className="h-3.5 w-3.5 text-emerald-600" />{tr("payNow")}
            </Label>
            <Switch checked={payNow} onCheckedChange={setPayNow} />
          </div>
          {payNow && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{tr("sourceType")}</Label>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant={paySource.type === "bank" ? "default" : "outline"}
                    onClick={() => setPaySource({ type: "bank", id: "" })} className="flex-1">
                    {tr("bank")}
                  </Button>
                  <Button type="button" size="sm" variant={paySource.type === "cash" ? "default" : "outline"}
                    onClick={() => setPaySource({ type: "cash", id: "" })} className="flex-1">
                    {tr("cash")}
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {paySource.type === "bank" ? tr("bankAccount") : tr("cashBox")} <span className="text-destructive">*</span>
                </Label>
                <SearchCombobox items={sourceItems} value={paySource.id}
                  onValueChange={v => setPaySource(p => ({ ...p, id: v }))} placeholder={tr("pickSource")} />
              </div>
            </div>
          )}
          {payNow && amt > 0 && form.accountId && paySource.id && (
            <div className="text-[11px] text-muted-foreground border-t border-emerald-200 pt-2 leading-relaxed">
              {tr("jePreview", { dr: fmt(baseAmt), cr: fmt(baseAmt), cur: baseCode })}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button type="button" variant="outline" onClick={() => {
            setForm({ expenseType: "", accountId: "", amount: "", currencyCode: selectedLc?.currencyCode ?? baseCode, exchangeRate: String(selectedLc?.exchangeRate ?? "1"), notes: "", date: today() });
            setPaySource(p => ({ ...p, id: "" }));
          }}>{tr("clear")}</Button>
          <Button type="button" onClick={() => submitMut.mutate()} disabled={submitMut.isPending} className="gap-2">
            {submitMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {payNow ? tr("saveAndPay") : tr("save")}
          </Button>
        </div>
      </fieldset>

      {/* ─── 4. Recent expenses on the selected LC ─────────────────── */}
      {selectedLc && lcDetail?.expenses?.length > 0 && (
        <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
          <div className="px-4 py-3 border-b bg-muted/30 flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <ListOrdered className="h-4 w-4 text-muted-foreground" />
              {tr("recentExpenses", { lc: selectedLc.lcNumber })}
            </h3>
            <Link href={`/purchasing/reports/lc-statement?lcId=${selectedLc.id}`}>
              <Button variant="ghost" size="sm" className="text-xs gap-1">
                {tr("openStatement")} <ArrowRight className={cn("h-3 w-3", isRtl && "rotate-180")} />
              </Button>
            </Link>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-muted/20 border-b">
              <tr>
                {[trLc("expenseType"), trLc("expenseAccount"), trLc("expenseCurrency"), trLc("expenseAmount"), tr("baseAmount", { cur: baseCode })].map(h => (
                  <th key={h} className={`${align} px-3 py-2 font-semibold text-muted-foreground`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lcDetail.expenses.map((e: any) => {
                const acc = accounts.find((a: any) => a.id === e.accountId);
                const eAmt  = Number(e.amount || 0);
                const eRate = Number(e.exchangeRate || 1);
                return (
                  <tr key={e.id} className="border-b hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium">{e.expenseType}</td>
                    <td className="px-3 py-2 text-muted-foreground">{acc ? `${acc.code} — ${pickName(acc.nameAr, acc.nameEn)}` : "—"}</td>
                    <td className="px-3 py-2 font-mono">{e.currencyCode}</td>
                    <td className="px-3 py-2 font-mono">{fmt(eAmt)}</td>
                    <td className="px-3 py-2 font-mono text-primary font-semibold">{fmt(eAmt * eRate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
