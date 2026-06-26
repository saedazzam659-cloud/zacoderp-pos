import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Code2, Loader2, Plus, Trash2, CheckCircle2, XCircle, PauseCircle, PlayCircle,
  Eye, ShieldCheck, Camera, Send, FolderTree, RefreshCw,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────────────
// DevStudio — SuperAdmin control center ("التطوير من خلال زاكود").
//
// Full governance over the in-browser developer studio: packages (editions),
// developer lifecycle (approve→entitlements, reject, suspend = instant
// kill-switch, resume, edit, delete), per-developer file visibility (default
// deny), version/snapshot distribution, audit trail, and submitted proposals.
// Mounted SA-only at /admin/dev-studio. Uses the tenant SA bearer token.
// ─────────────────────────────────────────────────────────────────────────

function useApi() {
  const token = localStorage.getItem("zatca_token");
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }), [token]);
  const base = `${API}/api/admin/dev-studio`;
  return { headers, base };
}

async function jsonOrThrow(r: Response) {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error ?? "تعذّر تنفيذ العملية");
  return d;
}

export default function DevStudioAdmin() {
  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-indigo-600 flex items-center justify-center">
          <Code2 className="h-6 w-6 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">التطوير من خلال زاكود</h1>
          <p className="text-sm text-muted-foreground">مركز تحكم المطوّرين — استوديو تطوير داخل المتصفح بصلاحيات محكومة</p>
        </div>
      </div>

      <Tabs defaultValue="developers">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="developers">المطوّرون</TabsTrigger>
          <TabsTrigger value="packages">الباقات</TabsTrigger>
          <TabsTrigger value="snapshots">النسخ</TabsTrigger>
          <TabsTrigger value="proposals">المقترحات</TabsTrigger>
          <TabsTrigger value="audit">سجل التدقيق</TabsTrigger>
        </TabsList>
        <TabsContent value="developers" className="mt-4"><DevelopersTab /></TabsContent>
        <TabsContent value="packages" className="mt-4"><PackagesTab /></TabsContent>
        <TabsContent value="snapshots" className="mt-4"><SnapshotsTab /></TabsContent>
        <TabsContent value="proposals" className="mt-4"><ProposalsTab /></TabsContent>
        <TabsContent value="audit" className="mt-4"><AuditTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function statusBadge(s: string) {
  const map: Record<string, { label: string; variant: any }> = {
    pending: { label: "قيد المراجعة", variant: "secondary" },
    active: { label: "نشِط", variant: "default" },
    suspended: { label: "موقوف", variant: "destructive" },
    rejected: { label: "مرفوض", variant: "destructive" },
  };
  const m = map[s] ?? { label: s, variant: "secondary" };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

// ── Developers ────────────────────────────────────────────────────────────────
function DevelopersTab() {
  const { headers, base } = useApi();
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [selId, setSelId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["devstudio-developers", filter],
    queryFn: async () => jsonOrThrow(await fetch(`${base}/developers${filter ? `?status=${filter}` : ""}`, { headers })),
  });
  const developers: any[] = data?.developers ?? [];

  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="col-span-12 lg:col-span-5 space-y-3">
        <div className="flex items-center gap-2">
          <select className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">كل الحالات</option>
            <option value="pending">قيد المراجعة</option>
            <option value="active">نشِط</option>
            <option value="suspended">موقوف</option>
            <option value="rejected">مرفوض</option>
          </select>
          <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["devstudio-developers"] })}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
        {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
          <div className="space-y-2">
            {developers.length === 0 && <p className="text-sm text-muted-foreground">لا يوجد مطوّرون.</p>}
            {developers.map((d) => (
              <button key={d.id} onClick={() => setSelId(d.id)}
                className={`w-full text-right border rounded-md p-3 hover:bg-slate-50 dark:hover:bg-slate-900 ${selId === d.id ? "border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30" : ""}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{d.name}</span>
                  {statusBadge(d.status)}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5" dir="ltr">{d.phone} · {d.country}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="col-span-12 lg:col-span-7">
        {selId ? <DeveloperDetail id={selId} onChanged={() => qc.invalidateQueries({ queryKey: ["devstudio-developers"] })} />
          : <Card><CardContent className="p-8 text-center text-muted-foreground text-sm">اختر مطوّراً لعرض التفاصيل وإدارة الصلاحيات.</CardContent></Card>}
      </div>
    </div>
  );
}

function DeveloperDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const { headers, base } = useApi();
  const qc = useQueryClient();
  const key = ["devstudio-developer", id];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: async () => jsonOrThrow(await fetch(`${base}/developers/${id}`, { headers })) });
  const { data: pkgData } = useQuery({ queryKey: ["devstudio-packages"], queryFn: async () => jsonOrThrow(await fetch(`${base}/packages`, { headers })) });
  const { data: snapData } = useQuery({ queryKey: ["devstudio-snapshots"], queryFn: async () => jsonOrThrow(await fetch(`${base}/snapshots`, { headers })) });

  const [approvePkg, setApprovePkg] = useState("");
  const [approveSnap, setApproveSnap] = useState("");
  const [newPrefix, setNewPrefix] = useState("");

  const refresh = () => { qc.invalidateQueries({ queryKey: key }); onChanged(); };

  const act = useMutation({
    mutationFn: async ({ path, method, body }: { path: string; method?: string; body?: any }) =>
      jsonOrThrow(await fetch(`${base}${path}`, { method: method ?? "POST", headers, body: body ? JSON.stringify(body) : undefined })),
    onSuccess: refresh,
  });

  if (isLoading || !data) return <Card><CardContent className="p-8 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></CardContent></Card>;
  const d = data.developer;
  const ent = d.entitlements ?? {};
  const visibility: any[] = data.visibility ?? [];
  const usage: any[] = data.usage ?? [];
  const packages: any[] = pkgData?.packages ?? [];
  const publishedSnaps: any[] = (snapData?.snapshots ?? []).filter((s: any) => s.status === "published");

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-bold">{d.name}</div>
            <div className="text-xs text-muted-foreground" dir="ltr">{d.phone} · {d.country}</div>
          </div>
          {statusBadge(d.status)}
        </div>

        {/* Lifecycle actions */}
        <div className="flex flex-wrap gap-2">
          {d.status === "pending" && (
            <div className="w-full space-y-2 border rounded-md p-3 bg-slate-50 dark:bg-slate-900">
              <div className="text-sm font-medium flex items-center gap-1"><CheckCircle2 className="h-4 w-4 text-emerald-600" /> اعتماد المطوّر</div>
              <div className="grid grid-cols-2 gap-2">
                <select className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" value={approvePkg} onChange={(e) => setApprovePkg(e.target.value)}>
                  <option value="">الباقة (من اختيار المطوّر)</option>
                  {packages.map((p) => <option key={p.id} value={p.id}>{p.nameAr}</option>)}
                </select>
                <select className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" value={approveSnap} onChange={(e) => setApproveSnap(e.target.value)}>
                  <option value="">النسخة (اختياري)</option>
                  {publishedSnaps.map((s) => <option key={s.id} value={s.id}>{s.version}</option>)}
                </select>
              </div>
              <Button size="sm" disabled={act.isPending}
                onClick={() => act.mutate({ path: `/developers/${id}/approve`, body: { packageId: approvePkg || undefined, snapshotId: approveSnap || undefined } })}>
                <CheckCircle2 className="h-4 w-4 ml-1" /> اعتماد وتطبيق الباقة
              </Button>
              <Button size="sm" variant="outline" className="mr-2" disabled={act.isPending}
                onClick={() => act.mutate({ path: `/developers/${id}/reject` })}>
                <XCircle className="h-4 w-4 ml-1" /> رفض
              </Button>
            </div>
          )}
          {d.status === "active" && (
            <Button size="sm" variant="destructive" disabled={act.isPending} onClick={() => act.mutate({ path: `/developers/${id}/suspend` })}>
              <PauseCircle className="h-4 w-4 ml-1" /> إيقاف فوري (Kill-switch)
            </Button>
          )}
          {d.status === "suspended" && (
            <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ path: `/developers/${id}/resume` })}>
              <PlayCircle className="h-4 w-4 ml-1" /> استئناف
            </Button>
          )}
          <Button size="sm" variant="ghost" className="text-destructive" disabled={act.isPending}
            onClick={() => { if (confirm("حذف المطوّر نهائياً؟")) act.mutate({ path: `/developers/${id}`, method: "DELETE" }); }}>
            <Trash2 className="h-4 w-4 ml-1" /> حذف
          </Button>
        </div>

        {/* Entitlements */}
        {d.status !== "pending" && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
            <Metric label="المكاتب" value={ent.offices ?? "—"} />
            <Metric label="الوحدات" value={ent.units ?? "—"} />
            <Metric label="حد القراءة" value={ent.readLineQuota ?? "—"} />
            <Metric label="حد الكتابة" value={ent.writeLineQuota ?? "—"} />
          </div>
        )}

        {/* Snapshot assignment */}
        <div className="border rounded-md p-3 space-y-2">
          <div className="text-sm font-medium flex items-center gap-1"><Camera className="h-4 w-4" /> النسخة المعيّنة</div>
          <div className="flex gap-2">
            <select className="h-9 flex-1 rounded-md border border-input bg-transparent px-2 text-sm" defaultValue={d.snapshotId ?? ""}
              onChange={(e) => act.mutate({ path: `/developers/${id}/assign-snapshot`, body: { snapshotId: e.target.value || null } })}>
              <option value="">— بدون نسخة —</option>
              {publishedSnaps.map((s) => <option key={s.id} value={s.id}>{s.version} {s.label ? `· ${s.label}` : ""}</option>)}
            </select>
          </div>
        </div>

        {/* Visibility (default deny) */}
        <div className="border rounded-md p-3 space-y-2">
          <div className="text-sm font-medium flex items-center gap-1"><FolderTree className="h-4 w-4" /> الملفات المسموح بها (المنع افتراضي)</div>
          <div className="flex gap-2">
            <Input value={newPrefix} onChange={(e) => setNewPrefix(e.target.value)} placeholder="مثال: artifacts/zatca-invoicing/src/pages" dir="ltr" className="text-xs" />
            <Button size="sm" disabled={!newPrefix.trim() || act.isPending}
              onClick={() => { act.mutate({ path: `/developers/${id}/visibility`, body: { pathPrefix: newPrefix.trim() } }); setNewPrefix(""); }}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          {visibility.length === 0 && <p className="text-xs text-muted-foreground">لا توجد مسارات مسموحة — لن يرى المطوّر أي ملف.</p>}
          <div className="space-y-1">
            {visibility.map((v) => (
              <div key={v.id} className="flex items-center justify-between bg-slate-50 dark:bg-slate-900 rounded px-2 py-1 text-xs">
                <span className="font-mono" dir="ltr">{v.pathPrefix}</span>
                <button className="text-destructive" onClick={() => act.mutate({ path: `/developers/${id}/visibility/${v.id}`, method: "DELETE" })}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Usage */}
        {usage.length > 0 && (
          <div className="border rounded-md p-3">
            <div className="text-sm font-medium mb-2">الاستهلاك الشهري</div>
            <div className="space-y-1 text-xs">
              {usage.map((u) => (
                <div key={u.periodKey} className="flex justify-between">
                  <span>{u.periodKey}</span>
                  <span className="text-muted-foreground">قراءة {u.readLinesUsed} · كتابة {u.writeLinesUsed}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: any }) {
  return (
    <div className="border rounded-md p-2">
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

// ── Packages ──────────────────────────────────────────────────────────────────
function PackagesTab() {
  const { headers, base } = useApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["devstudio-packages"], queryFn: async () => jsonOrThrow(await fetch(`${base}/packages`, { headers })) });
  const packages: any[] = data?.packages ?? [];
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);

  const del = useMutation({
    mutationFn: async (id: number) => jsonOrThrow(await fetch(`${base}/packages/${id}`, { method: "DELETE", headers })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["devstudio-packages"] }),
  });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => { setEdit(null); setOpen(true); }}><Plus className="h-4 w-4 ml-1" /> باقة جديدة</Button>
      </div>
      {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {packages.map((p) => (
            <Card key={p.id}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-bold">{p.nameAr}</div>
                  {!p.isActive && <Badge variant="secondary">غير مفعّلة</Badge>}
                </div>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div>{p.offices} مكتب · {p.units} وحدة</div>
                  <div>قراءة {p.readLineQuota} · كتابة {p.writeLineQuota} سطر</div>
                  <div>شهري {p.priceMonthly} · سنوي {p.priceAnnual}</div>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => { setEdit(p); setOpen(true); }}>تعديل</Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm("حذف الباقة؟")) del.mutate(p.id); }}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {packages.length === 0 && <p className="text-sm text-muted-foreground">لا توجد باقات بعد.</p>}
        </div>
      )}
      {open && <PackageDialog pkg={edit} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); qc.invalidateQueries({ queryKey: ["devstudio-packages"] }); }} />}
    </div>
  );
}

function PackageDialog({ pkg, onClose, onSaved }: { pkg: any | null; onClose: () => void; onSaved: () => void }) {
  const { headers, base } = useApi();
  const [f, setF] = useState({
    nameAr: pkg?.nameAr ?? "", nameEn: pkg?.nameEn ?? "",
    offices: pkg?.offices ?? 1, units: pkg?.units ?? 1,
    readLineQuota: pkg?.readLineQuota ?? 5000, writeLineQuota: pkg?.writeLineQuota ?? 1000,
    priceMonthly: pkg?.priceMonthly ?? 0, priceAnnual: pkg?.priceAnnual ?? 0,
    isActive: pkg?.isActive ?? true,
  });
  const set = (k: string, v: any) => setF((s) => ({ ...s, [k]: v }));
  const save = useMutation({
    mutationFn: async () => jsonOrThrow(await fetch(`${base}/packages${pkg ? `/${pkg.id}` : ""}`, {
      method: pkg ? "PUT" : "POST", headers, body: JSON.stringify(f),
    })),
    onSuccess: onSaved,
  });
  const num = (k: string) => (
    <div className="space-y-1"><Label className="text-xs">{labelFor(k)}</Label>
      <Input type="number" value={(f as any)[k]} onChange={(e) => set(k, parseInt(e.target.value) || 0)} dir="ltr" /></div>
  );
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent dir="rtl">
        <DialogHeader><DialogTitle>{pkg ? "تعديل باقة" : "باقة جديدة"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1"><Label className="text-xs">الاسم (عربي)</Label><Input value={f.nameAr} onChange={(e) => set("nameAr", e.target.value)} /></div>
            <div className="space-y-1"><Label className="text-xs">الاسم (إنجليزي)</Label><Input value={f.nameEn} onChange={(e) => set("nameEn", e.target.value)} dir="ltr" /></div>
          </div>
          <div className="grid grid-cols-2 gap-2">{num("offices")}{num("units")}</div>
          <div className="grid grid-cols-2 gap-2">{num("readLineQuota")}{num("writeLineQuota")}</div>
          <div className="grid grid-cols-2 gap-2">{num("priceMonthly")}{num("priceAnnual")}</div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => set("isActive", e.target.checked)} /> مفعّلة</label>
          {save.isError && <p className="text-sm text-destructive">{(save.error as Error).message}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button disabled={!f.nameAr.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "حفظ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function labelFor(k: string): string {
  return ({ offices: "عدد المكاتب", units: "عدد الوحدات", readLineQuota: "حد القراءة (سطر)", writeLineQuota: "حد الكتابة (سطر)", priceMonthly: "السعر الشهري", priceAnnual: "السعر السنوي" } as Record<string, string>)[k] ?? k;
}

// ── Snapshots ─────────────────────────────────────────────────────────────────
function SnapshotsTab() {
  const { headers, base } = useApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["devstudio-snapshots"], queryFn: async () => jsonOrThrow(await fetch(`${base}/snapshots`, { headers })) });
  const snapshots: any[] = data?.snapshots ?? [];
  const [version, setVersion] = useState("");
  const [label, setLabel] = useState("");

  const capture = useMutation({
    mutationFn: async () => jsonOrThrow(await fetch(`${base}/snapshots`, { method: "POST", headers, body: JSON.stringify({ version: version.trim() || undefined, label: label.trim() || undefined }) })),
    onSuccess: () => { setVersion(""); setLabel(""); qc.invalidateQueries({ queryKey: ["devstudio-snapshots"] }); },
  });
  const act = useMutation({
    mutationFn: async ({ path, method }: { path: string; method?: string }) => jsonOrThrow(await fetch(`${base}${path}`, { method: method ?? "POST", headers })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["devstudio-snapshots"] }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="text-sm font-medium flex items-center gap-1"><Camera className="h-4 w-4" /> التقاط نسخة جديدة من الشيفرة الحالية</div>
          <p className="text-xs text-muted-foreground">تُجمَّد نسخة من شجرة المصدر الحالية وتُخزَّن مضغوطة. انشرها لتصبح قابلة للتعيين للمطوّرين.</p>
          <div className="flex flex-wrap gap-2">
            <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="رقم النسخة (اختياري)" className="max-w-[200px]" dir="ltr" />
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="وصف مختصر" className="max-w-[260px]" />
            <Button size="sm" disabled={capture.isPending} onClick={() => capture.mutate()}>
              {capture.isPending ? <><Loader2 className="h-4 w-4 animate-spin ml-1" /> جارٍ الالتقاط…</> : <><Camera className="h-4 w-4 ml-1" /> التقاط</>}
            </Button>
          </div>
          {capture.isError && <p className="text-sm text-destructive">{(capture.error as Error).message}</p>}
        </CardContent>
      </Card>
      {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
        <div className="space-y-2">
          {snapshots.map((s) => (
            <div key={s.id} className="flex items-center justify-between border rounded-md p-3 text-sm">
              <div>
                <div className="font-medium" dir="ltr">{s.version} {s.label ? <span className="text-muted-foreground">· {s.label}</span> : null}</div>
                <div className="text-xs text-muted-foreground">{s.fileCount} ملف · {(s.byteSize / 1024).toFixed(0)} ك.ب</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={s.status === "published" ? "default" : s.status === "archived" ? "secondary" : "secondary"}>
                  {s.status === "published" ? "منشورة" : s.status === "archived" ? "مؤرشفة" : "مسودة"}
                </Badge>
                {s.status === "draft" && <Button size="sm" onClick={() => act.mutate({ path: `/snapshots/${s.id}/publish` })}><Send className="h-3.5 w-3.5 ml-1" /> نشر</Button>}
                {s.status === "published" && <Button size="sm" variant="outline" onClick={() => act.mutate({ path: `/snapshots/${s.id}/archive` })}>أرشفة</Button>}
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm("حذف النسخة؟")) act.mutate({ path: `/snapshots/${s.id}`, method: "DELETE" }); }}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
          ))}
          {snapshots.length === 0 && <p className="text-sm text-muted-foreground">لا توجد نسخ بعد.</p>}
        </div>
      )}
    </div>
  );
}

// ── Proposals ─────────────────────────────────────────────────────────────────
function ProposalsTab() {
  const { headers, base } = useApi();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [viewId, setViewId] = useState<number | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["devstudio-proposals", status],
    queryFn: async () => jsonOrThrow(await fetch(`${base}/proposals${status ? `?status=${status}` : ""}`, { headers })),
  });
  const proposals: any[] = data?.proposals ?? [];
  const act = useMutation({
    mutationFn: async ({ id, to }: { id: number; to: string }) => jsonOrThrow(await fetch(`${base}/proposals/${id}/status`, { method: "POST", headers, body: JSON.stringify({ status: to }) })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["devstudio-proposals"] }),
  });

  return (
    <div className="space-y-3">
      <select className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">كل الحالات</option>
        <option value="submitted">مُرسَل</option>
        <option value="draft">مسودة</option>
        <option value="published">معتمد</option>
        <option value="rejected">مرفوض</option>
      </select>
      {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
        <div className="space-y-2">
          {proposals.map((p) => (
            <div key={p.id} className="flex items-center justify-between border rounded-md p-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium truncate">{p.title}</div>
                <div className="text-xs text-muted-foreground" dir="ltr">{p.developerName ?? "—"} · {p.targetPath ?? "—"} · {p.writeLines} سطر</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant={p.status === "submitted" ? "default" : p.status === "published" ? "default" : p.status === "rejected" ? "destructive" : "secondary"}>
                  {p.status === "submitted" ? "مُرسَل" : p.status === "published" ? "معتمد" : p.status === "rejected" ? "مرفوض" : "مسودة"}
                </Badge>
                <Button size="sm" variant="outline" onClick={() => setViewId(p.id)}><Eye className="h-3.5 w-3.5" /></Button>
                {p.status === "submitted" && (
                  <>
                    <Button size="sm" onClick={() => act.mutate({ id: p.id, to: "published" })}><CheckCircle2 className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => act.mutate({ id: p.id, to: "rejected" })}><XCircle className="h-3.5 w-3.5" /></Button>
                  </>
                )}
              </div>
            </div>
          ))}
          {proposals.length === 0 && <p className="text-sm text-muted-foreground">لا توجد مقترحات.</p>}
        </div>
      )}
      {viewId && <ProposalDialog id={viewId} onClose={() => setViewId(null)} />}
    </div>
  );
}

function ProposalDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const { headers, base } = useApi();
  const { data, isLoading } = useQuery({ queryKey: ["devstudio-proposal", id], queryFn: async () => jsonOrThrow(await fetch(`${base}/proposals/${id}`, { headers })) });
  const p = data?.proposal;
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent dir="rtl" className="max-w-3xl">
        <DialogHeader><DialogTitle>{p?.title ?? "مقترح"}</DialogTitle></DialogHeader>
        {isLoading || !p ? <Loader2 className="h-5 w-5 animate-spin mx-auto" /> : (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground" dir="ltr">{p.targetPath ?? "—"} · {p.writeLines} سطر</div>
            {p.description && <p className="text-sm whitespace-pre-wrap">{p.description}</p>}
            {p.diff && <pre className="p-3 text-xs bg-slate-900 text-slate-100 rounded-md overflow-x-auto max-h-[50vh]" dir="ltr"><code>{p.diff}</code></pre>}
          </div>
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>إغلاق</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Audit ─────────────────────────────────────────────────────────────────────
function AuditTab() {
  const { headers, base } = useApi();
  const { data, isLoading } = useQuery({ queryKey: ["devstudio-audit"], queryFn: async () => jsonOrThrow(await fetch(`${base}/audit`, { headers })) });
  const rows: any[] = data?.audit ?? [];
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium flex items-center gap-1"><ShieldCheck className="h-4 w-4" /> آخر 300 عملية</div>
      {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
        <div className="border rounded-md divide-y text-xs">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between px-3 py-1.5">
              <span className="font-mono" dir="ltr">{r.action}{r.path ? ` · ${r.path}` : ""}</span>
              <span className="text-muted-foreground">{new Date(r.createdAt).toLocaleString("ar")}</span>
            </div>
          ))}
          {rows.length === 0 && <div className="px-3 py-4 text-muted-foreground text-center">لا يوجد نشاط بعد.</div>}
        </div>
      )}
    </div>
  );
}
