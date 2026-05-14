import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, AlertCircle, Plug, Plus, Sparkles, Search, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Provider {
  id: string; nameAr: string; nameEn: string;
  category: "erp" | "ecommerce" | "pos" | "accounting" | "custom";
  taglineAr: string; status: "stable" | "beta" | "coming_soon";
  capabilities: { pull: boolean; push: boolean };
  accent: string; logoSvg: string;
  credentialFields: Array<{ key: string; labelAr: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string; helperAr?: string }>;
}
interface Connection {
  id: number; provider: string; displayName: string; status: string;
  lastSyncAt: string | null; lastSyncStatus: string | null; totalSyncs: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  erp: "ERP", ecommerce: "تجارة إلكترونية", pos: "نقاط بيع", accounting: "محاسبة", custom: "مخصص",
};

export default function IntegrationsMarketplace() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [connectingTo, setConnectingTo] = useState<Provider | null>(null);

  const { data: provData } = useQuery<{ providers: Provider[] }>({
    queryKey: ["integrations", "providers"],
    queryFn: async () => (await fetch("/api/integrations/providers").then(r => r.json())),
  });
  const { data: connData } = useQuery<{ connections: Connection[] }>({
    queryKey: ["integrations", "connections"],
    queryFn: async () => (await fetch("/api/integrations/connections").then(r => r.json())),
  });

  const providers = provData?.providers ?? [];
  const connections = connData?.connections ?? [];
  const connByProvider = new Map(connections.map(c => [c.provider, c]));

  const filtered = providers.filter(p => {
    if (category !== "all" && p.category !== category) return false;
    if (search && !p.nameAr.includes(search) && !p.nameEn.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6" dir="rtl">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-indigo-600" />
            مركز ربط الأنظمة
          </h1>
          <p className="text-sm text-slate-500 mt-1">اربط نظامك (أودو، سلة، SAP...) بمنظومة الفاتورة الإلكترونية بنقرة واحدة</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <span className="flex items-center gap-1"><ArrowDownToLine className="w-4 h-4" /> Pull مجدول</span>
          <span className="text-slate-300">|</span>
          <span className="flex items-center gap-1"><ArrowUpFromLine className="w-4 h-4" /> Push فوري</span>
        </div>
      </header>

      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-64">
          <Search className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input className="pr-9" placeholder="ابحث عن نظام..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل الفئات</SelectItem>
            <SelectItem value="erp">ERP</SelectItem>
            <SelectItem value="accounting">محاسبة</SelectItem>
            <SelectItem value="ecommerce">تجارة إلكترونية</SelectItem>
            <SelectItem value="pos">نقاط بيع</SelectItem>
            <SelectItem value="custom">مخصص</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {connections.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-slate-700 mb-3">الاتصالات النشطة ({connections.length})</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {connections.map(c => {
              const p = providers.find(p => p.id === c.provider);
              return (
                <Link key={c.id} href={`/integrations/connections/${c.id}`}>
                  <Card className="p-4 hover:shadow-md transition cursor-pointer flex items-center gap-3">
                    <div className="w-12 h-12 flex items-center justify-center rounded-lg bg-slate-50 shrink-0"
                         dangerouslySetInnerHTML={{ __html: p?.logoSvg ?? "" }} />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate">{c.displayName}</div>
                      <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-2">
                        {c.status === "connected"
                          ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><CheckCircle2 className="w-3 h-3 ml-1"/>متصل</Badge>
                          : c.status === "error"
                          ? <Badge className="bg-rose-100 text-rose-700 hover:bg-rose-100"><AlertCircle className="w-3 h-3 ml-1"/>خطأ</Badge>
                          : <Badge variant="secondary">غير متصل</Badge>}
                        <span>{c.totalSyncs} مزامنة</span>
                      </div>
                    </div>
                    <ExternalLink className="w-4 h-4 text-slate-400" />
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-slate-700 mb-3">المزوّدون المتاحون ({filtered.length})</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map(p => {
            const conn = connByProvider.get(p.id);
            const comingSoon = p.status === "coming_soon";
            return (
              <Card key={p.id} className="overflow-hidden hover:shadow-lg transition group relative"
                    style={{ borderTop: `3px solid #${p.accent}` }}>
                {comingSoon && (
                  <div className="absolute top-2 left-2 z-10">
                    <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">قريباً</Badge>
                  </div>
                )}
                {conn && !comingSoon && (
                  <div className="absolute top-2 left-2 z-10">
                    <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">متصل</Badge>
                  </div>
                )}
                <div className="p-5 flex flex-col items-center text-center">
                  <div className="w-16 h-16 mb-3 flex items-center justify-center rounded-xl bg-slate-50"
                       dangerouslySetInnerHTML={{ __html: p.logoSvg }} />
                  <h3 className="font-bold text-slate-900">{p.nameAr}</h3>
                  <div className="text-xs text-slate-400 font-mono">{p.nameEn}</div>
                  <Badge variant="outline" className="mt-2 text-[10px]">{CATEGORY_LABELS[p.category]}</Badge>
                  <p className="text-xs text-slate-600 mt-3 min-h-[2.5rem]">{p.taglineAr}</p>
                  <div className="flex gap-2 mt-3">
                    {p.capabilities.pull && <span title="مزامنة دورية" className="text-emerald-600"><ArrowDownToLine className="w-4 h-4"/></span>}
                    {p.capabilities.push && <span title="استقبال فوري" className="text-blue-600"><ArrowUpFromLine className="w-4 h-4"/></span>}
                  </div>
                </div>
                <div className="bg-slate-50 px-5 py-3 border-t">
                  <Button
                    className="w-full"
                    variant={conn ? "outline" : "default"}
                    disabled={comingSoon}
                    onClick={() => !comingSoon && (conn
                      ? (window.location.href = `/integrations/connections/${conn.id}`)
                      : setConnectingTo(p))}
                  >
                    {comingSoon ? "متاح قريباً" : conn ? "إدارة" : (<><Plug className="w-4 h-4 ml-1"/> ربط</>)}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      {connectingTo && (
        <ConnectDialog provider={connectingTo} onClose={() => setConnectingTo(null)} />
      )}
    </div>
  );
}

function ConnectDialog({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState(provider.nameAr);
  const [baseUrl, setBaseUrl] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [inboundUrl, setInboundUrl] = useState<string | null>(null);
  const [inboundToken, setInboundToken] = useState<string | null>(null);

  const baseUrlField = provider.credentialFields.find(f => f.key === "baseUrl" && f.type === "url");

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/integrations/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: provider.id, displayName,
          baseUrl: baseUrlField ? creds.baseUrl : (baseUrl || null),
          credentials: creds,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "فشل الحفظ");
      return r.json() as Promise<{ id: number; inboundToken: string; inboundUrl: string }>;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["integrations", "connections"] });
      setInboundUrl(data.inboundUrl);
      setInboundToken(data.inboundToken);
    },
    onError: (e: Error) => toast({ title: "تعذّر الإنشاء", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg" dir="rtl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-lg bg-slate-50 flex items-center justify-center"
                 dangerouslySetInnerHTML={{ __html: provider.logoSvg }} />
            <div>
              <DialogTitle>ربط {provider.nameAr}</DialogTitle>
              <DialogDescription>{provider.taglineAr}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {!inboundUrl ? (
          <div className="space-y-4">
            <div>
              <Label>اسم العرض</Label>
              <Input value={displayName} onChange={e => setDisplayName(e.target.value)} />
            </div>
            {provider.credentialFields.map(f => (
              <div key={f.key}>
                <Label>{f.labelAr}{f.required && <span className="text-rose-500"> *</span>}</Label>
                <Input
                  type={f.type === "password" ? "password" : "text"}
                  dir={f.type === "url" || f.type === "password" ? "ltr" : undefined}
                  placeholder={f.placeholder}
                  value={creds[f.key] ?? ""}
                  onChange={e => setCreds({ ...creds, [f.key]: e.target.value })}
                />
                {f.helperAr && <p className="text-xs text-slate-500 mt-1">{f.helperAr}</p>}
              </div>
            ))}
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={onClose}>إلغاء</Button>
              <Button onClick={() => create.mutate()} disabled={create.isPending}>
                <Plus className="w-4 h-4 ml-1" />
                {create.isPending ? "...جاري الحفظ" : "إنشاء الاتصال"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
              <div className="font-semibold text-emerald-900 flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5" /> تم إنشاء الاتصال بنجاح
              </div>
              <p className="text-sm text-emerald-800 mt-2">احفظ هذا التوكن الآن — لن يُعرض مرة أخرى. يُستخدم لاستقبال الفواتير من نظامك (Push).</p>
            </div>
            <div>
              <Label>رابط الاستقبال (Inbound URL)</Label>
              <Input readOnly value={window.location.origin + inboundUrl} dir="ltr" className="font-mono text-xs" />
            </div>
            <div>
              <Label>التوكن</Label>
              <Input readOnly value={inboundToken ?? ""} dir="ltr" className="font-mono text-xs" />
            </div>
            <DialogFooter>
              <Button onClick={() => { onClose(); window.location.href = `/integrations/marketplace`; }}>تم</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
