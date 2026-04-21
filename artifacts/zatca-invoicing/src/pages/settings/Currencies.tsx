import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { currenciesApi } from "@/lib/currenciesApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Plus, Pencil, Trash2, Search, X, Save, DollarSign,
  ArrowRightLeft, Star, CheckCircle2, RefreshCw, Calendar,
} from "lucide-react";

const EMPTY_CUR  = { code: "", nameAr: "", nameEn: "", symbol: "", isDefault: false, isActive: true, notes: "" };
const EMPTY_RATE = { fromCurrencyId: "", toCurrencyId: "", rate: "", effectiveDate: new Date().toISOString().slice(0, 10), notes: "" };

const COMMON_CURRENCIES = [
  { code: "SAR", nameAr: "ريال سعودي",    nameEn: "Saudi Riyal",    symbol: "ر.س" },
  { code: "USD", nameAr: "دولار أمريكي",  nameEn: "US Dollar",      symbol: "$"   },
  { code: "EUR", nameAr: "يورو",          nameEn: "Euro",            symbol: "€"   },
  { code: "AED", nameAr: "درهم إماراتي", nameEn: "UAE Dirham",      symbol: "د.إ" },
  { code: "GBP", nameAr: "جنيه إسترليني",nameEn: "British Pound",   symbol: "£"   },
  { code: "EGP", nameAr: "جنيه مصري",    nameEn: "Egyptian Pound",  symbol: "ج.م" },
  { code: "KWD", nameAr: "دينار كويتي",  nameEn: "Kuwaiti Dinar",   symbol: "د.ك" },
  { code: "BHD", nameAr: "دينار بحريني", nameEn: "Bahraini Dinar",  symbol: "د.ب" },
  { code: "QAR", nameAr: "ريال قطري",    nameEn: "Qatari Riyal",    symbol: "ر.ق" },
  { code: "OMR", nameAr: "ريال عُماني",  nameEn: "Omani Rial",      symbol: "ر.ع" },
  { code: "JOD", nameAr: "دينار أردني",  nameEn: "Jordanian Dinar", symbol: "د.أ" },
];

export default function Currencies() {
  const { user } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc  = useQueryClient();
  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState("currencies");
  const [search,    setSearch]    = useState("");

  const [curForm,      setCurForm]      = useState<any>(EMPTY_CUR);
  const [curEditId,    setCurEditId]    = useState<number | null>(null);
  const [showCurForm,  setShowCurForm]  = useState(false);
  const [deleteId,     setDeleteId]     = useState<number | null>(null);

  const [rateForm,     setRateForm]     = useState<any>(EMPTY_RATE);
  const [rateEditId,   setRateEditId]   = useState<number | null>(null);
  const [showRateForm, setShowRateForm] = useState(false);
  const [deleteRateId, setDeleteRateId] = useState<number | null>(null);

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["currencies", cid] });
    qc.invalidateQueries({ queryKey: ["exchange-rates", cid] });
  };

  const { data: currencies = [], isLoading } = useQuery<any[]>({
    queryKey: ["currencies", cid],
    queryFn: () => currenciesApi.list(cid),
    enabled: !!user,
  });

  const { data: rates = [] } = useQuery<any[]>({
    queryKey: ["exchange-rates", cid],
    queryFn: () => currenciesApi.listRates(cid),
    enabled: !!user,
  });

  const createCur  = useMutation({ mutationFn: (d: any) => currenciesApi.create({ ...d, companyId: cid }), onSuccess: () => { inv(); resetCur(); toast({ title: "تمت إضافة العملة" }); }, onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }) });
  const updateCur  = useMutation({ mutationFn: ({ id, data }: any) => currenciesApi.update(id, data), onSuccess: () => { inv(); resetCur(); toast({ title: "تم تعديل العملة" }); }, onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }) });
  const deleteCur  = useMutation({ mutationFn: (id: number) => currenciesApi.remove(id), onSuccess: () => { inv(); setDeleteId(null); toast({ title: "تم الحذف" }); }, onError: (e: any) => { setDeleteId(null); toast({ title: "خطأ", description: e.message, variant: "destructive" }); } });
  const createRate = useMutation({ mutationFn: (d: any) => currenciesApi.createRate({ ...d, companyId: cid }), onSuccess: () => { inv(); resetRate(); toast({ title: "تمت إضافة معامل التحويل" }); }, onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }) });
  const updateRate = useMutation({ mutationFn: ({ id, data }: any) => currenciesApi.updateRate(id, data), onSuccess: () => { inv(); resetRate(); toast({ title: "تم تعديل معامل التحويل" }); }, onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }) });
  const deleteRate = useMutation({ mutationFn: (id: number) => currenciesApi.removeRate(id), onSuccess: () => { inv(); setDeleteRateId(null); toast({ title: "تم الحذف" }); } });

  function resetCur()  { setCurForm(EMPTY_CUR);  setCurEditId(null);  setShowCurForm(false);  }
  function resetRate() { setRateForm(EMPTY_RATE); setRateEditId(null); setShowRateForm(false); }

  function handleEditCur(c: any) {
    setCurForm({ code: c.code, nameAr: c.nameAr, nameEn: c.nameEn ?? "", symbol: c.symbol ?? "", isDefault: c.isDefault, isActive: c.isActive, notes: c.notes ?? "" });
    setCurEditId(c.id); setShowCurForm(true); setActiveTab("currencies");
  }
  function handleEditRate(r: any) {
    setRateForm({ fromCurrencyId: String(r.fromCurrencyId), toCurrencyId: String(r.toCurrencyId), rate: String(Number(r.rate)), effectiveDate: r.effectiveDate, notes: r.notes ?? "" });
    setRateEditId(r.id); setShowRateForm(true); setActiveTab("rates");
  }

  function submitCur(e: React.FormEvent) {
    e.preventDefault();
    if (!curForm.code || !curForm.nameAr) { toast({ title: "الكود والاسم العربي مطلوبان", variant: "destructive" }); return; }
    if (curEditId) updateCur.mutate({ id: curEditId, data: curForm });
    else createCur.mutate(curForm);
  }
  function submitRate(e: React.FormEvent) {
    e.preventDefault();
    if (!rateForm.fromCurrencyId || !rateForm.toCurrencyId || !rateForm.rate || !rateForm.effectiveDate) {
      toast({ title: "جميع الحقول مطلوبة", variant: "destructive" }); return;
    }
    if (rateEditId) updateRate.mutate({ id: rateEditId, data: rateForm });
    else createRate.mutate(rateForm);
  }

  function fillFromCommon(c: typeof COMMON_CURRENCIES[0]) {
    setCurForm((p: any) => ({ ...p, code: c.code, nameAr: c.nameAr, nameEn: c.nameEn, symbol: c.symbol }));
  }

  const filtered = currencies.filter((c: any) =>
    !search || c.code.includes(search.toUpperCase()) || c.nameAr.includes(search) || (c.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-5" dir="rtl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <DollarSign className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">العملات ومعاملات التحويل</h1>
            <p className="text-xs text-muted-foreground">إدارة العملات وأسعار الصرف بين العملات</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "إجمالي العملات",  value: currencies.length,                                      icon: DollarSign,    cls: "text-blue-500 bg-blue-50" },
          { label: "العملة الافتراضية", value: currencies.find((c: any) => c.isDefault)?.code ?? "—", icon: Star,          cls: "text-yellow-500 bg-yellow-50" },
          { label: "معاملات التحويل", value: rates.length,                                            icon: ArrowRightLeft, cls: "text-purple-500 bg-purple-50" },
        ].map((s, i) => (
          <Card key={i} className="border-2">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-3">
                <s.icon className={cn("h-8 w-8 rounded-lg p-1.5", s.cls)} />
                <div>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                  <p className="text-2xl font-bold text-foreground">{s.value}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {showCurForm && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <h2 className="font-semibold flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-primary" />
              {curEditId ? "تعديل العملة" : "إضافة عملة جديدة"}
            </h2>
            <Button variant="ghost" size="icon" onClick={resetCur}><X className="h-4 w-4" /></Button>
          </div>
          <form onSubmit={submitCur} className="p-5 space-y-4">
            {!curEditId && (
              <div>
                <p className="text-[11px] font-medium text-muted-foreground mb-2">عملات شائعة — انقر للملء السريع:</p>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {COMMON_CURRENCIES.map(c => {
                    const exists = currencies.some((x: any) => x.code === c.code);
                    return (
                      <button key={c.code} type="button" onClick={() => fillFromCommon(c)} disabled={exists}
                        className={cn("text-[11px] px-2 py-1 rounded border font-mono font-bold transition-colors",
                          exists ? "opacity-40 cursor-not-allowed bg-muted text-muted-foreground border-border"
                                 : "bg-background hover:bg-primary/10 hover:border-primary text-primary border-border"
                        )}>
                        {c.code}
                      </button>
                    );
                  })}
                </div>
                <Separator />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>الكود <span className="text-destructive">*</span></Label><Input value={curForm.code} onChange={e => setCurForm((p: any) => ({ ...p, code: e.target.value.toUpperCase() }))} placeholder="SAR" className="font-mono" maxLength={5} /></div>
              <div className="space-y-1.5"><Label>الرمز</Label><Input value={curForm.symbol} onChange={e => setCurForm((p: any) => ({ ...p, symbol: e.target.value }))} placeholder="ر.س" maxLength={5} /></div>
            </div>
            <div className="space-y-1.5"><Label>الاسم العربي <span className="text-destructive">*</span></Label><Input value={curForm.nameAr} onChange={e => setCurForm((p: any) => ({ ...p, nameAr: e.target.value }))} placeholder="ريال سعودي" /></div>
            <div className="space-y-1.5"><Label>الاسم الإنجليزي</Label><Input value={curForm.nameEn} onChange={e => setCurForm((p: any) => ({ ...p, nameEn: e.target.value }))} placeholder="Saudi Riyal" /></div>
            <div className="flex items-center gap-6 pt-1">
              <div className="flex items-center gap-2">
                <Switch id="isDefault" checked={curForm.isDefault} onCheckedChange={v => setCurForm((p: any) => ({ ...p, isDefault: v }))} />
                <Label htmlFor="isDefault" className="flex items-center gap-1 cursor-pointer"><Star className="h-3 w-3 text-yellow-500" />افتراضية</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="isActive" checked={curForm.isActive} onCheckedChange={v => setCurForm((p: any) => ({ ...p, isActive: v }))} />
                <Label htmlFor="isActive" className="flex items-center gap-1 cursor-pointer"><CheckCircle2 className="h-3 w-3 text-green-500" />نشطة</Label>
              </div>
            </div>
            <div className="flex gap-2 pt-4 border-t">
              <Button type="button" variant="outline" className="gap-1" onClick={resetCur}><X className="h-4 w-4" />إلغاء</Button>
              <Button type="submit" className="gap-1 flex-1" disabled={createCur.isPending || updateCur.isPending}><Save className="h-4 w-4" />{curEditId ? "تعديل" : "إضافة"}</Button>
            </div>
          </form>
        </div>
      )}

      {showRateForm && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <h2 className="font-semibold flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5 text-primary" />
              {rateEditId ? "تعديل معامل التحويل" : "إضافة معامل تحويل"}
            </h2>
            <Button variant="ghost" size="icon" onClick={resetRate}><X className="h-4 w-4" /></Button>
          </div>
          <form onSubmit={submitRate} className="p-5 space-y-4">
            <div className="space-y-1.5"><Label>من العملة <span className="text-destructive">*</span></Label>
              <Select value={rateForm.fromCurrencyId || "__none"} onValueChange={v => setRateForm((p: any) => ({ ...p, fromCurrencyId: v === "__none" ? "" : v }))}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="— اختر العملة —" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">— اختر العملة —</SelectItem>
                  {currencies.filter((c: any) => c.isActive).map((c: any) => (<SelectItem key={c.id} value={String(c.id)}><span className="font-bold ml-2">{c.symbol}</span> {c.nameAr} ({c.code})</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-center text-muted-foreground"><ArrowRightLeft className="h-5 w-5" /></div>
            <div className="space-y-1.5"><Label>إلى العملة <span className="text-destructive">*</span></Label>
              <Select value={rateForm.toCurrencyId || "__none"} onValueChange={v => setRateForm((p: any) => ({ ...p, toCurrencyId: v === "__none" ? "" : v }))}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="— اختر العملة —" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">— اختر العملة —</SelectItem>
                  {currencies.filter((c: any) => c.isActive && String(c.id) !== rateForm.fromCurrencyId).map((c: any) => (<SelectItem key={c.id} value={String(c.id)}><span className="font-bold ml-2">{c.symbol}</span> {c.nameAr} ({c.code})</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            {rateForm.fromCurrencyId && rateForm.toCurrencyId && rateForm.rate && (
              <div className="rounded-lg border bg-primary/5 border-primary/20 px-4 py-3 text-sm text-center font-medium">
                {(() => { const from = currencies.find((c: any) => String(c.id) === rateForm.fromCurrencyId); const to = currencies.find((c: any) => String(c.id) === rateForm.toCurrencyId); return `1 ${from?.code ?? ""} = ${Number(rateForm.rate).toFixed(4)} ${to?.code ?? ""}`; })()}
              </div>
            )}
            <div className="space-y-1.5"><Label>معامل التحويل <span className="text-destructive">*</span></Label>
              <Input type="text" inputMode="decimal" value={rateForm.rate} onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ""); const parts = v.split("."); const clean = parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : v; setRateForm((p: any) => ({ ...p, rate: clean })); }} placeholder="3.7500" className="h-9 text-sm font-mono text-left" />
            </div>
            <div className="space-y-1.5"><Label className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />تاريخ التطبيق <span className="text-destructive">*</span></Label>
              <Input type="date" value={rateForm.effectiveDate} onChange={e => setRateForm((p: any) => ({ ...p, effectiveDate: e.target.value }))} className="h-9 text-sm" />
            </div>
            <div className="flex gap-2 pt-4 border-t">
              <Button type="button" variant="outline" className="gap-1" onClick={resetRate}><X className="h-4 w-4" />إلغاء</Button>
              <Button type="submit" className="gap-1 flex-1" disabled={createRate.isPending || updateRate.isPending}><Save className="h-4 w-4" />{rateEditId ? "تعديل" : "إضافة"}</Button>
            </div>
          </form>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} dir="rtl">
        <Card className="border-2">
          <CardHeader className="p-0">
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/20">
              <p className="text-[11px] text-muted-foreground">
                {activeTab === "currencies" ? `${filtered.length} عملة مسجّلة` : `${rates.length} معامل تحويل مسجّل`}
              </p>
              <div className="flex items-center gap-2">
                {activeTab === "currencies" && (
                  <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => { resetCur(); setShowCurForm(true); }}>
                    <Plus className="h-3.5 w-3.5" />إضافة عملة
                  </Button>
                )}
                {activeTab === "rates" && (
                  <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => { resetRate(); setShowRateForm(true); }} disabled={currencies.length < 2}>
                    <Plus className="h-3.5 w-3.5" />إضافة معامل تحويل
                  </Button>
                )}
                <TabsList className="h-8 bg-background border gap-1">
                  <TabsTrigger value="currencies" className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <DollarSign className="h-3.5 w-3.5" />العملات
                    {currencies.length > 0 && <span className="mr-1 bg-primary-foreground/20 rounded-full px-1.5 text-[10px] font-bold">{currencies.length}</span>}
                  </TabsTrigger>
                  <TabsTrigger value="rates" className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <ArrowRightLeft className="h-3.5 w-3.5" />معاملات التحويل
                    {rates.length > 0 && <span className="mr-1 bg-primary-foreground/20 rounded-full px-1.5 text-[10px] font-bold">{rates.length}</span>}
                  </TabsTrigger>
                </TabsList>
              </div>
            </div>
          </CardHeader>

          <TabsContent value="currencies" className="mt-0">
            <div className="px-4 py-3 border-b bg-muted/10">
              <div className="relative">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="ابحث بالكود أو الاسم..." className="h-8 pr-8 text-sm" />
              </div>
            </div>
            {isLoading ? (
              <div className="py-16 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
            ) : filtered.length === 0 ? (
              <div className="py-16 text-center space-y-2">
                <DollarSign className="h-10 w-10 text-muted-foreground/30 mx-auto" />
                <p className="text-sm text-muted-foreground">لا توجد عملات</p>
                <Button variant="outline" size="sm" onClick={() => setShowCurForm(true)}><Plus className="h-3.5 w-3.5 ml-1" />إضافة عملة</Button>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30 text-muted-foreground">
                    <th className="px-4 py-2.5 text-right font-medium">الكود</th>
                    <th className="px-4 py-2.5 text-right font-medium">الرمز</th>
                    <th className="px-4 py-2.5 text-right font-medium">الاسم العربي</th>
                    <th className="px-4 py-2.5 text-right font-medium hidden sm:table-cell">الاسم الإنجليزي</th>
                    <th className="px-4 py-2.5 text-right font-medium">الحالة</th>
                    <th className="px-4 py-2.5 text-center font-medium">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((c: any) => (
                    <tr key={c.id} className={cn("hover:bg-muted/20 transition-colors", curEditId === c.id && "bg-primary/5")}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-primary text-sm">{c.code}</span>
                          {c.isDefault && (
                            <Badge variant="outline" className="text-[9px] bg-yellow-50 text-yellow-700 border-yellow-200 gap-0.5">
                              <Star className="h-2.5 w-2.5" />افتراضي
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-bold text-base text-muted-foreground">{c.symbol ?? "—"}</td>
                      <td className="px-4 py-3 font-medium">{c.nameAr}</td>
                      <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{c.nameEn ?? "—"}</td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={cn("text-[10px]", c.isActive ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-600 border-red-200")}>
                          {c.isActive ? "نشطة" : "موقوفة"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary" onClick={() => handleEditCur(c)}><Pencil className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => setDeleteId(c.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TabsContent>

          <TabsContent value="rates" className="mt-0">
            {currencies.length < 2 ? (
              <div className="py-10 text-center space-y-2">
                <ArrowRightLeft className="h-10 w-10 text-muted-foreground/30 mx-auto" />
                <p className="text-sm text-muted-foreground">أضف عملتين على الأقل لإضافة معامل تحويل</p>
              </div>
            ) : rates.length === 0 ? (
              <div className="py-16 text-center space-y-2">
                <RefreshCw className="h-10 w-10 text-muted-foreground/30 mx-auto" />
                <p className="text-sm text-muted-foreground">لا توجد معاملات تحويل</p>
                <Button variant="outline" size="sm" onClick={() => setShowRateForm(true)}><Plus className="h-3.5 w-3.5 ml-1" />إضافة معامل</Button>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30 text-muted-foreground">
                    <th className="px-4 py-2.5 text-right font-medium">من</th>
                    <th className="px-4 py-2.5 text-center font-medium"></th>
                    <th className="px-4 py-2.5 text-right font-medium">إلى</th>
                    <th className="px-4 py-2.5 text-right font-medium">معامل التحويل</th>
                    <th className="px-4 py-2.5 text-right font-medium">تاريخ التطبيق</th>
                    <th className="px-4 py-2.5 text-center font-medium">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rates.map((r: any) => {
                    const from = currencies.find((c: any) => c.id === r.fromCurrencyId);
                    const to   = currencies.find((c: any) => c.id === r.toCurrencyId);
                    return (
                      <tr key={r.id} className={cn("hover:bg-muted/20 transition-colors", rateEditId === r.id && "bg-primary/5")}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-lg">{from?.symbol ?? ""}</span>
                            <div>
                              <p className="font-mono font-semibold text-primary text-xs">{from?.code ?? r.fromCurrencyId}</p>
                              <p className="text-[10px] text-muted-foreground">{from?.nameAr}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center text-muted-foreground"><ArrowRightLeft className="h-4 w-4 mx-auto" /></td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-lg">{to?.symbol ?? ""}</span>
                            <div>
                              <p className="font-mono font-semibold text-primary text-xs">{to?.code ?? r.toCurrencyId}</p>
                              <p className="text-[10px] text-muted-foreground">{to?.nameAr}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3"><span className="font-mono font-bold text-base text-foreground">{Number(r.rate).toFixed(4)}</span></td>
                        <td className="px-4 py-3 text-muted-foreground flex items-center gap-1.5"><Calendar className="h-3.5 w-3.5" />{r.effectiveDate}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary" onClick={() => handleEditRate(r)}><Pencil className="h-3.5 w-3.5" /></Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => setDeleteRateId(r.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </TabsContent>
        </Card>
      </Tabs>


      {/* AlertDialogs for delete confirmation */}
      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تأكيد الحذف</AlertDialogTitle>
            <AlertDialogDescription>هل أنت متأكد من حذف هذه العملة؟</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => deleteId && deleteCur.mutate(deleteId)}>حذف</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteRateId !== null} onOpenChange={() => setDeleteRateId(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تأكيد الحذف</AlertDialogTitle>
            <AlertDialogDescription>هل أنت متأكد من حذف معامل التحويل هذا؟</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => deleteRateId && deleteRate.mutate(deleteRateId)}>حذف</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
