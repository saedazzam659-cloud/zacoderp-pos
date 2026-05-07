import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, Plus, Save, X, UserCog, Truck, ClipboardCopy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type PartyKind = "customer" | "supplier";

interface PartyRow {
  id: number;
  companyId: number;
  nameAr: string;
  nameEn?: string | null;
  vatNumber?: string | null;
  crNumber?: string | null;
  phone?: string | null;
  city?: string | null;
  district?: string | null;
  street?: string | null;
  buildingNumber?: string | null;
  postalCode?: string | null;
  country?: string | null;
  nationalAddressShort?: string | null;
}

function authHeaders(token?: string | null): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Compose a printable, multi-line block describing the selected party.
// Only non-empty fields are emitted so the JE description stays clean
// when the user hasn't filled the optional national-address fields.
function formatPartyBlock(kind: PartyKind, p: PartyRow): string {
  const label = kind === "customer" ? "العميل" : "المورد";
  const lines: string[] = [];
  lines.push(`${label}: ${p.nameAr}${p.nameEn ? ` / ${p.nameEn}` : ""}`);
  if (p.crNumber)  lines.push(`السجل التجاري: ${p.crNumber}`);
  if (p.vatNumber) lines.push(`الرقم الضريبي: ${p.vatNumber}`);
  if (p.phone)     lines.push(`الجوال: ${p.phone}`);
  // National address — Saudi Post 4-line format (building street district city + postal).
  const naParts = [
    p.buildingNumber,
    p.street,
    p.district,
    p.city,
    p.postalCode,
  ].filter(x => x && String(x).trim().length).join(" - ");
  if (naParts) lines.push(`العنوان الوطني: ${naParts}`);
  if (p.nationalAddressShort) lines.push(`الرمز المختصر: ${p.nationalAddressShort}`);
  return lines.join("\n");
}

interface Props {
  /** Called when the user clicks "إدراج" — receives the composed text block. */
  onInsert: (text: string) => void;
  /** Optional className for the trigger button. */
  className?: string;
}

/**
 * Quick-pick dialog used on the Journal Entry form to fetch (or create on the
 * fly) a customer / supplier and inject its key info — name, CR, VAT, phone,
 * national address — into the entry's description so the printed قيد carries
 * a complete party reference. Talks to /api/customers and /api/suppliers and
 * invalidates the same query keys those screens use, so any new row created
 * here also appears immediately on the parent management screens.
 */
export function JournalPartyPicker({ onInsert, className }: Props) {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const companyId = user?.role === "superadmin" ? undefined : user?.company?.id ?? user?.companyId;

  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<PartyKind>("customer");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [mode, setMode] = useState<"pick" | "create">("pick");

  // ─── Listing query ────────────────────────────────────────────────────────
  const listKey = kind === "customer" ? ["customers", companyId] : ["suppliers", companyId];
  const path    = kind === "customer" ? "/api/customers"          : "/api/suppliers";
  const list = useQuery<PartyRow[]>({
    queryKey: listKey,
    queryFn: async () => {
      const url = companyId ? `${API}${path}?companyId=${companyId}` : `${API}${path}`;
      const r = await fetch(url, { headers: authHeaders(token) });
      if (!r.ok) throw new Error("تعذّر جلب القائمة");
      return r.json();
    },
    enabled: open,
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = list.data ?? [];
    if (!q) return rows;
    return rows.filter(r =>
      [r.nameAr, r.nameEn, r.vatNumber, r.crNumber, r.phone, r.city]
        .filter(Boolean)
        .some(v => String(v).toLowerCase().includes(q))
    );
  }, [list.data, search]);

  const selected = useMemo(
    () => (list.data ?? []).find(r => r.id === selectedId) ?? null,
    [list.data, selectedId],
  );

  // ─── Create-new form state ────────────────────────────────────────────────
  const [nName, setNName] = useState("");
  const [nNameEn, setNNameEn] = useState("");
  const [nVat, setNVat] = useState("");
  const [nCr, setNCr] = useState("");
  const [nPhone, setNPhone] = useState("");
  const [nBuilding, setNBuilding] = useState("");
  const [nStreet, setNStreet] = useState("");
  const [nDistrict, setNDistrict] = useState("");
  const [nCity, setNCity] = useState("");
  const [nPostal, setNPostal] = useState("");
  const [nNAShort, setNNAShort] = useState("");

  function resetCreate() {
    setNName(""); setNNameEn(""); setNVat(""); setNCr(""); setNPhone("");
    setNBuilding(""); setNStreet(""); setNDistrict("");
    setNCity(""); setNPostal(""); setNNAShort("");
  }

  const create = useMutation({
    mutationFn: async () => {
      if (nName.trim().length < 2) throw new Error("الاسم مطلوب");
      if (!companyId) throw new Error("يجب اختيار شركة قبل إضافة طرف جديد");
      const body: any = {
        companyId,
        nameAr:               nName.trim(),
        nameEn:               nNameEn.trim() || undefined,
        vatNumber:            nVat.trim()    || undefined,
        crNumber:             nCr.trim()     || undefined,
        phone:                nPhone.trim()  || undefined,
        buildingNumber:       nBuilding.trim() || undefined,
        street:               nStreet.trim()   || undefined,
        district:             nDistrict.trim() || undefined,
        city:                 nCity.trim()     || undefined,
        postalCode:           nPostal.trim()   || undefined,
        nationalAddressShort: nNAShort.trim()  || undefined,
        country: "SA",
      };
      const r = await fetch(`${API}${path}`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const txt = await r.text(); let msg = txt;
        try { msg = JSON.parse(txt).error ?? txt; } catch {}
        throw new Error(msg || "تعذّر الحفظ");
      }
      return r.json() as Promise<PartyRow>;
    },
    onSuccess: (row) => {
      toast({ title: kind === "customer" ? "تم إضافة العميل" : "تم إضافة المورد" });
      // Invalidate BOTH the scoped list (this dialog) and the root key
      // ([customers]/[suppliers]) used by other screens like
      // CustomerVatControl/SupplierVatControl so the new row appears
      // app-wide without forcing a manual refresh.
      const rootKey = kind === "customer" ? ["customers"] : ["suppliers"];
      qc.invalidateQueries({ queryKey: listKey });
      qc.invalidateQueries({ queryKey: rootKey });
      resetCreate();
      setMode("pick");
      // pre-select the new row so the user can immediately insert it
      setSelectedId(row.id);
    },
    onError: (e: any) => toast({
      title: "تعذّر الحفظ",
      description: e?.message ?? "خطأ غير معروف",
      variant: "destructive",
    }),
  });

  function handleInsert() {
    if (!selected) return;
    const text = formatPartyBlock(kind, selected);
    onInsert(text);
    toast({ title: "تم إدراج بيانات الطرف في البيان" });
    setOpen(false);
  }

  function switchKind(k: PartyKind) {
    setKind(k);
    setSelectedId(null);
    setSearch("");
    setMode("pick");
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setMode("pick"); setSelectedId(null); setSearch(""); } }}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={className ?? "h-8 gap-1.5 text-xs"}
          title="جلب أو إضافة بيانات عميل / مورد لإدراجها في بيان القيد"
        >
          <UserCog className="h-3.5 w-3.5" />
          عميل / مورد
        </Button>
      </DialogTrigger>

      <DialogContent dir="rtl" className="sm:max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>إدراج بيانات عميل أو مورد في القيد</DialogTitle>
          <DialogDescription>
            ابحث عن طرف موجود أو أضف طرفاً جديداً بسرعة. عند الإدراج تُضاف
            بيانات الاسم والسجل التجاري والرقم الضريبي والعنوان الوطني إلى
            بيان القيد ليطبع بشكل سليم متوافق مع متطلبات الزكاة والدخل.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={kind} onValueChange={(v) => switchKind(v as PartyKind)} className="mt-2">
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="customer" className="gap-1.5">
              <UserCog className="h-4 w-4" />العملاء
            </TabsTrigger>
            <TabsTrigger value="supplier" className="gap-1.5">
              <Truck className="h-4 w-4" />الموردين
            </TabsTrigger>
          </TabsList>

          {(["customer", "supplier"] as const).map(k => (
            <TabsContent key={k} value={k} className="mt-3 space-y-3">
              {mode === "pick" ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={k === "customer" ? "ابحث بالاسم / الرقم الضريبي / السجل" : "ابحث عن مورد"}
                        className="h-9 pr-7 text-sm"
                      />
                    </div>
                    <Button
                      type="button" size="sm" variant="secondary"
                      onClick={() => { resetCreate(); setMode("create"); }}
                      className="h-9 gap-1 text-xs shrink-0"
                      disabled={!companyId}
                      title={companyId ? undefined : "يجب اختيار شركة محددة لإضافة طرف جديد"}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {k === "customer" ? "عميل جديد" : "مورد جديد"}
                    </Button>
                  </div>

                  <div className="border rounded-md max-h-[260px] overflow-y-auto divide-y">
                    {list.isLoading ? (
                      <div className="p-4 text-sm text-muted-foreground text-center">جاري التحميل...</div>
                    ) : filtered.length === 0 ? (
                      <div className="p-4 text-sm text-muted-foreground text-center">
                        {search ? "لا توجد نتائج مطابقة" : "لا توجد بيانات بعد"}
                      </div>
                    ) : (
                      filtered.map(r => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setSelectedId(r.id)}
                          className={`w-full text-right px-3 py-2 text-sm hover:bg-accent flex items-center justify-between gap-2 ${
                            selectedId === r.id ? "bg-accent/60" : ""
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="font-medium truncate">{r.nameAr}</div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {[r.crNumber && `س.ت ${r.crNumber}`, r.vatNumber && `ض ${r.vatNumber}`, r.city]
                                .filter(Boolean).join(" • ") || "—"}
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>

                  {selected && (
                    <div className="rounded-md border bg-muted/30 p-3 space-y-1 text-sm">
                      <div className="font-semibold">{selected.nameAr}</div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {selected.crNumber  && <div>س.ت: <span className="text-foreground font-mono" dir="ltr">{selected.crNumber}</span></div>}
                        {selected.vatNumber && <div>ض: <span className="text-foreground font-mono" dir="ltr">{selected.vatNumber}</span></div>}
                        {selected.phone     && <div>جوال: <span className="text-foreground font-mono" dir="ltr">{selected.phone}</span></div>}
                        {selected.city      && <div>المدينة: <span className="text-foreground">{selected.city}</span></div>}
                      </div>
                      {(selected.buildingNumber || selected.street || selected.district || selected.postalCode) && (
                        <div className="text-[11px] text-muted-foreground pt-1 border-t mt-1">
                          العنوان: {[selected.buildingNumber, selected.street, selected.district, selected.city, selected.postalCode].filter(Boolean).join(" - ")}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                /* ── Create-new form ─────────────────────────────────────── */
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1 col-span-2">
                      <Label className="text-xs">الاسم (عربي) *</Label>
                      <Input value={nName} onChange={(e) => setNName(e.target.value)} className="h-9" autoFocus />
                    </div>
                    <div className="space-y-1 col-span-2">
                      <Label className="text-xs">الاسم (إنجليزي)</Label>
                      <Input value={nNameEn} onChange={(e) => setNNameEn(e.target.value)} className="h-9" dir="ltr" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">السجل التجاري</Label>
                      <Input value={nCr} onChange={(e) => setNCr(e.target.value)} className="h-9 font-mono" dir="ltr" placeholder="1010xxxxxx" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">الرقم الضريبي</Label>
                      <Input value={nVat} onChange={(e) => setNVat(e.target.value)} className="h-9 font-mono" dir="ltr" placeholder="3xxxxxxxxxxxxx3" maxLength={15} />
                    </div>
                    <div className="space-y-1 col-span-2">
                      <Label className="text-xs">رقم الجوال</Label>
                      <Input value={nPhone} onChange={(e) => setNPhone(e.target.value)} className="h-9 font-mono" dir="ltr" placeholder="05xxxxxxxx" />
                    </div>
                  </div>

                  <div className="rounded-md border bg-muted/30 p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-semibold">العنوان الوطني (اختياري)</Label>
                      <span className="text-[10px] text-muted-foreground">يُطبع على القيد لمتابعة الزكاة والدخل</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">رقم المبنى</Label>
                        <Input value={nBuilding} onChange={(e) => setNBuilding(e.target.value)} className="h-9 font-mono" dir="ltr" placeholder="1234" maxLength={4} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">الرمز البريدي</Label>
                        <Input value={nPostal} onChange={(e) => setNPostal(e.target.value)} className="h-9 font-mono" dir="ltr" placeholder="12345" maxLength={5} />
                      </div>
                      <div className="space-y-1 col-span-2">
                        <Label className="text-xs text-muted-foreground">الشارع</Label>
                        <Input value={nStreet} onChange={(e) => setNStreet(e.target.value)} className="h-9" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">الحي</Label>
                        <Input value={nDistrict} onChange={(e) => setNDistrict(e.target.value)} className="h-9" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">المدينة</Label>
                        <Input value={nCity} onChange={(e) => setNCity(e.target.value)} className="h-9" />
                      </div>
                      <div className="space-y-1 col-span-2">
                        <Label className="text-xs text-muted-foreground">رمز العنوان الوطني المختصر</Label>
                        <Input value={nNAShort} onChange={(e) => setNNAShort(e.target.value)} className="h-9 font-mono" dir="ltr" placeholder="RIYD1234" />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </TabsContent>
          ))}
        </Tabs>

        <DialogFooter className="gap-2 sm:gap-2">
          {mode === "create" ? (
            <>
              <Button type="button" variant="outline" onClick={() => setMode("pick")} className="gap-1">
                <X className="h-4 w-4" />رجوع
              </Button>
              <Button
                type="button"
                onClick={() => create.mutate()}
                disabled={create.isPending || nName.trim().length < 2 || !companyId}
                className="gap-1"
              >
                <Save className="h-4 w-4" />
                {create.isPending ? "جاري الحفظ..." : "حفظ"}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} className="gap-1">
                <X className="h-4 w-4" />إلغاء
              </Button>
              <Button
                type="button"
                onClick={handleInsert}
                disabled={!selected}
                className="gap-1"
              >
                <ClipboardCopy className="h-4 w-4" />إدراج في البيان
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
