import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Code2, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { COUNTRIES } from "@/lib/countries";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────────────
// DevStudio — public developer self-registration ("التطوير من خلال زاكود").
//
// A developer registers with name + phone + country + chosen package + a login
// password and accepts the NDA. The account is created as `pending`; a platform
// SuperAdmin must approve it (which applies the package entitlements) before the
// developer can log in to the in-browser studio. Mirrors the public-portal
// pattern (own identity, NOT a tenant user).
// ─────────────────────────────────────────────────────────────────────────

interface Pkg {
  id: number; nameAr: string; nameEn: string | null;
  offices: number; units: number; readLineQuota: number; writeLineQuota: number;
  priceMonthly: number; priceAnnual: number;
}

export default function DevStudioRegister() {
  const [, navigate] = useLocation();
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("SA");
  const [packageId, setPackageId] = useState<string>("");
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("monthly");
  const [password, setPassword] = useState("");
  const [nda, setNda] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/dev-studio/packages`)
      .then((r) => r.json())
      .then((d) => {
        const list: Pkg[] = d?.packages ?? [];
        setPackages(list);
        if (list.length) setPackageId(String(list[0].id));
      })
      .catch(() => { /* packages are optional */ });
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!nda) { setError("يجب الموافقة على اتفاقية السرية (NDA)"); return; }
    if (password.length < 8) { setError("كلمة المرور يجب أن تكون 8 أحرف على الأقل"); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/dev-studio/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), phone: phone.trim(), country,
          packageId: packageId || null, billingCycle, password, ndaAccepted: nda,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data?.error ?? "تعذّر إرسال الطلب"); return; }
      setDone(true);
    } catch {
      setError("تعذّر الاتصال بالخادم");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <CheckCircle2 className="h-14 w-14 text-emerald-500 mx-auto" />
            <h1 className="text-xl font-bold">تم استلام طلبك</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              سيتم مراجعة طلبك من قِبل مدير المنصة. عند الاعتماد ستتمكن من تسجيل الدخول
              إلى استوديو التطوير برقم جوالك وكلمة المرور.
            </p>
            <Button className="w-full" onClick={() => navigate("/dev-studio")}>الذهاب لتسجيل الدخول</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4" dir="rtl">
      <Card className="w-full max-w-lg">
        <CardContent className="pt-8 pb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="h-11 w-11 rounded-xl bg-indigo-600 flex items-center justify-center">
              <Code2 className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold leading-tight">التطوير من خلال زاكود</h1>
              <p className="text-xs text-muted-foreground">تسجيل مطوّر جديد — استوديو تطوير داخل المتصفح</p>
            </div>
          </div>

          {error && (
            <div className="mb-4 mt-4 flex items-start gap-2 rounded-md bg-destructive/10 text-destructive p-3 text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-4 mt-4">
            <div className="space-y-1.5">
              <Label>الاسم الكامل</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="مثال: محمد العتيبي" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>رقم الجوال</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} required placeholder="05xxxxxxxx" dir="ltr" />
              </div>
              <div className="space-y-1.5">
                <Label>الدولة</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  value={country} onChange={(e) => setCountry(e.target.value)}
                >
                  {COUNTRIES.map((c: any) => (
                    <option key={c.code} value={c.code}>{c.nameAr ?? c.name ?? c.code}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>الباقة</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={packageId} onChange={(e) => setPackageId(e.target.value)}
              >
                <option value="">— بدون باقة محددة —</option>
                {packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nameAr} — {p.offices} مكتب / {p.units} وحدة
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label>دورة الاشتراك</Label>
              <div className="flex gap-2">
                <button type="button" onClick={() => setBillingCycle("monthly")}
                  className={`flex-1 h-9 rounded-md border text-sm ${billingCycle === "monthly" ? "bg-indigo-600 text-white border-indigo-600" : "border-input"}`}>
                  شهري
                </button>
                <button type="button" onClick={() => setBillingCycle("annual")}
                  className={`flex-1 h-9 rounded-md border text-sm ${billingCycle === "annual" ? "bg-indigo-600 text-white border-indigo-600" : "border-input"}`}>
                  سنوي
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>كلمة المرور (لتسجيل الدخول لاحقاً)</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="٨ أحرف على الأقل" dir="ltr" />
            </div>

            <label className="flex items-start gap-2 text-sm cursor-pointer rounded-md border p-3">
              <Checkbox checked={nda} onCheckedChange={(v) => setNda(v === true)} className="mt-0.5" />
              <span className="text-muted-foreground leading-relaxed">
                أوافق على <span className="font-medium text-foreground">اتفاقية السرية (NDA)</span> وألتزم بعدم نسخ
                أو إعادة توزيع أي جزء من الشيفرة المصدرية التي أُمنح صلاحية الاطلاع عليها. أُقر بأن جميع عمليات
                الاطلاع موثّقة وتحمل علامة مائية باسمي.
              </span>
            </label>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <><Loader2 className="h-4 w-4 animate-spin ml-2" /> جارٍ الإرسال…</> : "إرسال الطلب"}
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              لديك حساب مُعتمد؟{" "}
              <button type="button" className="text-indigo-600 hover:underline" onClick={() => navigate("/dev-studio")}>
                تسجيل الدخول
              </button>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
