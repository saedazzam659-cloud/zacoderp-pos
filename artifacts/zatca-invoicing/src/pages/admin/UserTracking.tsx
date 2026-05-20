import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { userTrackingApi, type VisitRow, type TrackingZone } from "@/lib/userTrackingApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { MapPin, Users, Clock, AlertTriangle, Trash2, Plus, BarChart3, UserPlus, X, Search, Loader2, Globe2, LocateFixed, Pencil } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line, Legend } from "recharts";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// FREE OpenStreetMap raster tile style — no API key required. Uses the
// standard OSM tile server which has full coverage of Saudi Arabia with
// Arabic labels. Subject to OSM's usage policy.
const OSM_STYLE: any = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png", "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png", "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: [{ id: "osm-tiles", type: "raster", source: "osm" }],
};

function fmtMin(min: number | null | undefined): string {
  if (!min || min <= 0) return "—";
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 0) return `${m} د`;
  return `${h} س ${m} د`;
}
function fmtDt(s: string | null | undefined): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short" }); }
  catch { return s; }
}

export default function UserTracking() {
  const { user } = useAuth();
  const cid = user?.companyId ?? undefined;
  const qc = useQueryClient();

  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [userId, setUserId] = useState<number | undefined>(undefined);
  const [status, setStatus] = useState<string>("");

  const dashboardQ = useQuery({
    queryKey: ["user-tracking-dashboard", cid, from, to, userId],
    queryFn: () => userTrackingApi.dashboard({ companyId: cid, from, to, userId }),
    enabled: !!cid,
  });

  const visitsQ = useQuery({
    queryKey: ["user-tracking-visits", cid, from, to, userId, status],
    queryFn: () => userTrackingApi.visits({ companyId: cid, from, to, userId, status: status || undefined, limit: 500 }),
    enabled: !!cid,
  });

  const zonesQ = useQuery({
    queryKey: ["user-tracking-zones", cid],
    queryFn: () => userTrackingApi.zones(cid),
    enabled: !!cid,
  });

  const totals = dashboardQ.data?.totals;
  const visits = visitsQ.data ?? [];
  const zones = zonesQ.data ?? [];

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2"><MapPin className="h-6 w-6 text-indigo-600" /> تتبع مواقع المستخدمين</h1>
      </div>

      {/* Filter bar */}
      <Card>
        <CardContent className="pt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="space-y-1.5"><Label>من</Label><Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>إلى</Label><Input type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
          <div className="space-y-1.5">
            <Label>المستخدم</Label>
            <select className="w-full h-10 rounded-md border px-3 text-sm bg-background"
              value={userId ?? ""} onChange={e => setUserId(e.target.value ? Number(e.target.value) : undefined)}>
              <option value="">كل المستخدمين</option>
              {(dashboardQ.data?.perUser ?? []).map(u => <option key={u.userId} value={u.userId}>{u.userName}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>الحالة</Label>
            <select className="w-full h-10 rounded-md border px-3 text-sm bg-background"
              value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">الكل</option>
              <option value="active">نشطة</option>
              <option value="completed">منتهية</option>
              <option value="cancelled">ملغاة</option>
            </select>
          </div>
        </CardContent>
      </Card>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiTile icon={MapPin}   label="عدد الزيارات"     value={totals?.visitCount ?? 0} color="indigo" />
        <KpiTile icon={Users}    label="مستخدمين نشطين"   value={totals?.activeUsers ?? 0} color="blue" />
        <KpiTile icon={Clock}    label="إجمالي وقت التواجد" value={fmtMin(totals?.totalMinutes ?? 0)} color="emerald" />
        <KpiTile icon={AlertTriangle} label="تنبيهات" value={totals?.alertCount ?? 0} color="rose" />
      </div>

      <Tabs defaultValue="dashboard" className="w-full">
        <TabsList className="grid grid-cols-4 w-full max-w-2xl">
          <TabsTrigger value="dashboard"><BarChart3 className="h-4 w-4 me-1" /> الداش بورد</TabsTrigger>
          <TabsTrigger value="visits"><MapPin className="h-4 w-4 me-1" /> الزيارات</TabsTrigger>
          <TabsTrigger value="map">🗺 الخريطة</TabsTrigger>
          <TabsTrigger value="zones">🚧 المناطق المحددة</TabsTrigger>
        </TabsList>

        {/* Dashboard tab */}
        <TabsContent value="dashboard" className="space-y-4 pt-4">
          <Card>
            <CardHeader><CardTitle>مقارنة أداء المستخدمين</CardTitle></CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead><tr className="text-start text-muted-foreground">
                    <th className="py-2 px-2 text-start">المستخدم</th>
                    <th className="py-2 px-2">عدد الزيارات</th>
                    <th className="py-2 px-2">منتهية</th>
                    <th className="py-2 px-2">نشطة</th>
                    <th className="py-2 px-2">إجمالي الوقت</th>
                    <th className="py-2 px-2">متوسط الزيارة</th>
                    <th className="py-2 px-2">أماكن مختلفة</th>
                    <th className="py-2 px-2">تنبيهات</th>
                  </tr></thead>
                  <tbody>
                    {(dashboardQ.data?.perUser ?? []).map(u => (
                      <tr key={u.userId} className="border-t">
                        <td className="py-2 px-2 font-medium">{u.userName}</td>
                        <td className="py-2 px-2 text-center tabular-nums">{u.visitCount}</td>
                        <td className="py-2 px-2 text-center tabular-nums text-emerald-700">{u.completedCount}</td>
                        <td className="py-2 px-2 text-center tabular-nums text-blue-700">{u.activeCount}</td>
                        <td className="py-2 px-2 text-center tabular-nums">{fmtMin(u.totalMinutes)}</td>
                        <td className="py-2 px-2 text-center tabular-nums">{fmtMin(u.avgMinutes)}</td>
                        <td className="py-2 px-2 text-center tabular-nums">{u.distinctPlaces}</td>
                        <td className="py-2 px-2 text-center">
                          {u.alertCount > 0 ? <Badge variant="destructive">{u.alertCount}</Badge> : <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    ))}
                    {(dashboardQ.data?.perUser ?? []).length === 0 && (
                      <tr><td colSpan={8} className="py-8 text-center text-muted-foreground">لا توجد بيانات</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle>الزيارات اليومية</CardTitle></CardHeader>
              <CardContent style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={dashboardQ.data?.perDay ?? []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="day" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="visitCount" name="عدد الزيارات" stroke="#6366f1" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>الأماكن الأكثر زيارة</CardTitle></CardHeader>
              <CardContent style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dashboardQ.data?.topPlaces ?? []} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" />
                    <YAxis dataKey="place" type="category" width={140} />
                    <Tooltip />
                    <Bar dataKey="visitCount" name="عدد الزيارات" fill="#10b981" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Visits table tab */}
        <TabsContent value="visits" className="pt-4">
          <Card>
            <CardContent className="pt-4 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead><tr className="text-muted-foreground">
                  <th className="py-2 px-2 text-start">المستخدم</th>
                  <th className="py-2 px-2 text-start">المكان</th>
                  <th className="py-2 px-2 text-start">العنوان الكامل</th>
                  <th className="py-2 px-2">وقت الوصول</th>
                  <th className="py-2 px-2">وقت المغادرة</th>
                  <th className="py-2 px-2">المدة</th>
                  <th className="py-2 px-2">الحالة</th>
                  <th className="py-2 px-2">سبب الزيارة</th>
                  <th className="py-2 px-2">تنبيهات</th>
                </tr></thead>
                <tbody>
                  {visits.map(v => (
                    <tr key={v.id} className="border-t hover:bg-muted/40">
                      <td className="py-2 px-2 font-medium">{v.userName}</td>
                      <td className="py-2 px-2">{v.checkinPlace || <span className="text-muted-foreground">—</span>}</td>
                      <td className="py-2 px-2 text-xs text-muted-foreground max-w-[260px] truncate" title={v.checkinAddress || ""}>{v.checkinAddress || "—"}</td>
                      <td className="py-2 px-2 text-center text-xs">{fmtDt(v.checkinAt)}</td>
                      <td className="py-2 px-2 text-center text-xs">{fmtDt(v.checkoutAt)}</td>
                      <td className="py-2 px-2 text-center tabular-nums">{fmtMin(v.durationMinutes)}</td>
                      <td className="py-2 px-2 text-center">
                        {v.status === "active"     && <Badge className="bg-blue-100 text-blue-800">نشطة</Badge>}
                        {v.status === "completed"  && <Badge className="bg-emerald-100 text-emerald-800">منتهية</Badge>}
                        {v.status === "cancelled"  && <Badge variant="outline">ملغاة</Badge>}
                      </td>
                      <td className="py-2 px-2">{v.purpose || "—"}</td>
                      <td className="py-2 px-2">
                        {v.alertFlags ? <Badge variant="destructive" title={v.alertFlags}>{v.alertFlags.split(",").length}</Badge> : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  ))}
                  {visits.length === 0 && <tr><td colSpan={9} className="py-8 text-center text-muted-foreground">لا توجد زيارات</td></tr>}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Map tab */}
        <TabsContent value="map" className="pt-4">
          <Card>
            <CardContent className="pt-4">
              <VisitsMap visits={visits} zones={zones} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Zones tab */}
        <TabsContent value="zones" className="pt-4">
          <ZonesTab zones={zones} onChanged={() => qc.invalidateQueries({ queryKey: ["user-tracking-zones"] })} cid={cid} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function KpiTile({ icon: Icon, label, value, color }: { icon: any; label: string; value: any; color: string }) {
  const bg: Record<string, string> = {
    indigo: "from-indigo-50 to-indigo-100/40 text-indigo-700 border-indigo-200",
    blue:   "from-blue-50 to-blue-100/40 text-blue-700 border-blue-200",
    emerald:"from-emerald-50 to-emerald-100/40 text-emerald-700 border-emerald-200",
    rose:   "from-rose-50 to-rose-100/40 text-rose-700 border-rose-200",
  };
  return (
    <Card className={`bg-gradient-to-br border ${bg[color]}`}>
      <CardContent className="pt-4 flex items-center gap-3">
        <Icon className="h-8 w-8 opacity-80" />
        <div>
          <p className="text-xs">{label}</p>
          <p className="text-xl font-bold tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function VisitsMap({ visits, zones }: { visits: VisitRow[]; zones: TrackingZone[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (mapRef.current) return;
    mapRef.current = new maplibregl.Map({
      container: ref.current,
      style: OSM_STYLE,
      center: [46.6753, 24.7136], // Riyadh
      zoom: 5,
    });
    mapRef.current.addControl(new maplibregl.NavigationControl(), "top-left");
    return () => { mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers: maplibregl.Marker[] = [];
    const pts: [number, number][] = [];
    for (const v of visits) {
      if (v.checkinLat && v.checkinLng) {
        const lat = Number(v.checkinLat), lng = Number(v.checkinLng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const el = document.createElement("div");
        el.style.cssText = "background:#6366f1;width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.3);cursor:pointer;";
        const marker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat])
          .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(
            `<div style="font-family:system-ui;font-size:12px;direction:rtl"><strong>${v.userName}</strong><br/>${v.checkinPlace || ""}<br/><small>${fmtDt(v.checkinAt)} · ${fmtMin(v.durationMinutes)}</small></div>`,
          ))
          .addTo(map);
        markers.push(marker);
        pts.push([lng, lat]);
      }
    }
    // zones as circular markers (red = forbidden, green = allowed)
    for (const z of zones) {
      const lat = Number(z.centerLat), lng = Number(z.centerLng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const el = document.createElement("div");
      const color = z.isAllowed ? "#10b981" : "#f43f5e";
      el.style.cssText = `background:${color}33;border:2px solid ${color};width:24px;height:24px;border-radius:50%;cursor:pointer;`;
      const m = new maplibregl.Marker({ element: el }).setLngLat([lng, lat])
        .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(
          `<div style="font-family:system-ui;font-size:12px;direction:rtl"><strong>${z.name}</strong><br/>${z.isAllowed ? "مسموحة" : "ممنوعة"} · نصف القطر ${z.radiusMeters} م</small></div>`,
        ))
        .addTo(map);
      markers.push(m);
    }
    if (pts.length > 0) {
      const lngs = pts.map(p => p[0]), lats = pts.map(p => p[1]);
      const bounds = new maplibregl.LngLatBounds([Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]);
      map.fitBounds(bounds, { padding: 60, maxZoom: 13 });
    }
    return () => { markers.forEach(m => m.remove()); };
  }, [visits, zones]);

  return <div ref={ref} className="w-full h-[500px] rounded-md overflow-hidden" />;
}

function ZonesTab({ zones, onChanged, cid }: { zones: TrackingZone[]; onChanged: () => void; cid?: number }) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [assigning, setAssigning] = useState<TrackingZone | null>(null);
  const EMPTY_FORM = { name: "", centerLat: 24.7136, centerLng: 46.6753, radiusMeters: 500, isAllowed: true, notes: "" };
  const [form, setForm] = useState(EMPTY_FORM);
  const [err, setErr] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => userTrackingApi.createZone({ ...form }, cid),
    onSuccess: () => { setOpen(false); onChanged(); setForm(EMPTY_FORM); setEditingId(null); },
    onError: (e: any) => setErr(e?.message || "فشل الإنشاء"),
  });
  const update = useMutation({
    mutationFn: () => userTrackingApi.updateZone(editingId!, { ...form }, cid),
    onSuccess: () => { setOpen(false); onChanged(); setForm(EMPTY_FORM); setEditingId(null); },
    onError: (e: any) => setErr(e?.message || "فشل التعديل"),
  });
  const del = useMutation({
    mutationFn: (id: number) => userTrackingApi.deleteZone(id, cid),
    onSuccess: () => onChanged(),
  });
  function openEdit(z: TrackingZone) {
    setErr(null);
    setEditingId(z.id);
    setForm({
      name: z.name,
      centerLat: Number(z.centerLat),
      centerLng: Number(z.centerLng),
      radiusMeters: Number(z.radiusMeters),
      isAllowed: !!z.isAllowed,
      notes: (z as any).notes ?? "",
    });
    setOpen(true);
  }
  function openCreate() {
    setErr(null);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setOpen(true);
  }
  const isEditing = editingId !== null;
  const submitting = create.isPending || update.isPending;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>المناطق المحددة (Geofences)</CardTitle>
        <Button size="sm" onClick={openCreate} data-testid="btn-new-zone"><Plus className="h-4 w-4 me-1" /> منطقة جديدة</Button>
      </CardHeader>
      <CardContent>
        <table className="min-w-full text-sm">
          <thead><tr className="text-muted-foreground">
            <th className="py-2 px-2 text-start">الاسم</th>
            <th className="py-2 px-2">الإحداثيات</th>
            <th className="py-2 px-2">نصف القطر (م)</th>
            <th className="py-2 px-2">النوع</th>
            <th className="py-2 px-2">المستخدمون</th>
            <th className="py-2 px-2">إجراءات</th>
          </tr></thead>
          <tbody>
            {zones.map(z => (
              <tr key={z.id} className="border-t">
                <td className="py-2 px-2 font-medium">{z.name}</td>
                <td className="py-2 px-2 text-center tabular-nums text-xs">{z.centerLat}, {z.centerLng}</td>
                <td className="py-2 px-2 text-center tabular-nums">{z.radiusMeters}</td>
                <td className="py-2 px-2 text-center">
                  {z.isAllowed
                    ? <Badge className="bg-emerald-100 text-emerald-800">مسموحة</Badge>
                    : <Badge variant="destructive">ممنوعة</Badge>}
                </td>
                <td className="py-2 px-2">
                  <ZoneUserChips zoneId={z.id} cid={cid} onManage={() => setAssigning(z)} />
                </td>
                <td className="py-2 px-2 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Button size="icon" variant="ghost" onClick={() => openEdit(z)} data-testid={`btn-edit-zone-${z.id}`} title="تعديل">
                      <Pencil className="h-4 w-4 text-indigo-600" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => { if (confirm(`حذف "${z.name}"؟`)) del.mutate(z.id); }} data-testid={`btn-delete-zone-${z.id}`} title="حذف">
                      <Trash2 className="h-4 w-4 text-rose-600" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {zones.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-muted-foreground">لا توجد مناطق</td></tr>}
          </tbody>
        </table>
        <div className="mt-3 text-xs text-muted-foreground rounded-md bg-muted/40 p-2">
          💡 المنطقة بدون مستخدمين معيّنين تُطبَّق على <strong>كل</strong> موظفي الشركة. عند تعيين مستخدم أو أكثر، تُطبَّق المنطقة فقط على هؤلاء.
        </div>
      </CardContent>
      {assigning && <ZoneAssignDialog zone={assigning} cid={cid} onClose={() => setAssigning(null)} />}

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setEditingId(null); setForm(EMPTY_FORM); setErr(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{isEditing ? `تعديل المنطقة — ${form.name || ""}` : "منطقة جديدة"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>اسم المنطقة</Label><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>

            <PlaceSearch
              cid={cid}
              onPick={(p) => setForm(f => ({
                ...f,
                centerLat: p.lat,
                centerLng: p.lng,
                name: f.name || p.displayName.split(",")[0]?.trim() || f.name,
              }))}
            />

            <div className="grid grid-cols-2 gap-3">
              <div><Label>خط العرض (Lat)</Label><Input type="number" step="0.0000001" value={form.centerLat} onChange={e => setForm({ ...form, centerLat: Number(e.target.value) })} /></div>
              <div><Label>خط الطول (Lng)</Label><Input type="number" step="0.0000001" value={form.centerLng} onChange={e => setForm({ ...form, centerLng: Number(e.target.value) })} /></div>
            </div>
            <UseMyLocationButton
              onPick={(lat, lng) => setForm(f => ({ ...f, centerLat: lat, centerLng: lng }))}
              onError={(msg) => setErr(msg)}
            />
            <div><Label>نصف القطر (متر)</Label><Input type="number" value={form.radiusMeters} onChange={e => setForm({ ...form, radiusMeters: Number(e.target.value) })} /></div>
            <div className="flex items-center justify-between rounded-md border p-2">
              <Label>منطقة مسموح بها</Label>
              <Switch checked={form.isAllowed} onCheckedChange={v => setForm({ ...form, isAllowed: v })} />
            </div>
            <div><Label>ملاحظات</Label><Input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></div>
            {err && <div className="rounded-md bg-rose-50 p-2 text-sm text-rose-700">{err}</div>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button
              onClick={() => (isEditing ? update.mutate() : create.mutate())}
              disabled={!form.name || submitting}
              data-testid="btn-save-zone"
            >
              {submitting ? <Loader2 className="h-4 w-4 me-1 animate-spin" /> : null}
              {isEditing ? "حفظ التعديلات" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function UseMyLocationButton({
  onPick,
  onError,
}: {
  onPick: (lat: number, lng: number) => void;
  onError: (msg: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [accuracy, setAccuracy] = useState<number | null>(null);

  function fetchLocation() {
    if (!("geolocation" in navigator)) {
      onError("المتصفح لا يدعم تحديد الموقع الجغرافي");
      return;
    }
    setLoading(true);
    onError("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(7));
        const lng = Number(pos.coords.longitude.toFixed(7));
        setAccuracy(Math.round(pos.coords.accuracy));
        onPick(lat, lng);
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        const msg =
          err.code === err.PERMISSION_DENIED
            ? "تم رفض إذن الموقع. فعّل الإذن من إعدادات المتصفح."
            : err.code === err.POSITION_UNAVAILABLE
            ? "تعذّر تحديد الموقع حالياً. تأكد من تشغيل GPS."
            : err.code === err.TIMEOUT
            ? "انتهت مهلة تحديد الموقع. أعد المحاولة."
            : `فشل تحديد الموقع: ${err.message}`;
        onError(msg);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50/50 p-2">
      <div className="text-sm text-emerald-800">
        <div className="font-medium flex items-center gap-1">
          <LocateFixed className="h-4 w-4" /> استخدام موقعي الحالي
        </div>
        {accuracy !== null && (
          <div className="text-xs text-emerald-700 mt-0.5">تم تعبئة الإحداثيات (دقة ≈ {accuracy} م)</div>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={fetchLocation}
        disabled={loading}
        data-testid="btn-use-my-location"
      >
        {loading ? <Loader2 className="h-4 w-4 me-1 animate-spin" /> : <LocateFixed className="h-4 w-4 me-1" />}
        {loading ? "جارٍ التحديد..." : "جلب موقعي"}
      </Button>
    </div>
  );
}

function PlaceSearch({ cid, onPick }: { cid?: number; onPick: (p: { lat: number; lng: number; displayName: string }) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ displayName: string; lat: number; lng: number }>>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search: wait 500 ms after typing stops, then query.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      setLoading(true); setErr(null);
      try {
        const r = await userTrackingApi.geocode(q.trim(), cid);
        setResults(r);
        setOpen(true);
      } catch (e: any) {
        setErr(e?.message || "فشل البحث");
      } finally {
        setLoading(false);
      }
    }, 500);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q, cid]);

  return (
    <div className="rounded-md border border-indigo-200 bg-indigo-50/50 p-2 space-y-2 relative">
      <Label className="flex items-center gap-1 text-indigo-700">
        <Search className="h-4 w-4" /> ابحث عن المكان بالاسم (يعبّأ الإحداثيات تلقائياً)
      </Label>
      <div className="relative">
        <Input
          placeholder="مثال: حي الديرة الرياض، أو: مكة المكرمة"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
        />
        {loading && <Loader2 className="h-4 w-4 absolute left-2 top-3 animate-spin text-indigo-600" />}
      </div>
      {open && results.length > 0 && (
        <ul className="absolute z-50 left-2 right-2 max-h-60 overflow-y-auto bg-background border rounded-md shadow-lg mt-1">
          {results.map((r, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => { onPick(r); setOpen(false); setQ(r.displayName.split(",")[0] || ""); }}
                className="block w-full text-start px-3 py-2 hover:bg-muted text-sm"
              >
                <div className="font-medium">{r.displayName.split(",")[0]}</div>
                <div className="text-xs text-muted-foreground truncate">{r.displayName}</div>
                <div className="text-[10px] tabular-nums text-muted-foreground">{r.lat.toFixed(5)}, {r.lng.toFixed(5)}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && !loading && q.trim().length >= 2 && results.length === 0 && (
        <div className="text-xs text-muted-foreground px-1">لا توجد نتائج لـ "{q}"</div>
      )}
      {err && <div className="text-xs text-rose-600 px-1">{err}</div>}
    </div>
  );
}

// Color palette for user-initial chips — picked deterministically by userId
const CHIP_COLORS = [
  "bg-rose-100 text-rose-700 ring-rose-200",
  "bg-amber-100 text-amber-700 ring-amber-200",
  "bg-emerald-100 text-emerald-700 ring-emerald-200",
  "bg-sky-100 text-sky-700 ring-sky-200",
  "bg-violet-100 text-violet-700 ring-violet-200",
  "bg-fuchsia-100 text-fuchsia-700 ring-fuchsia-200",
  "bg-teal-100 text-teal-700 ring-teal-200",
  "bg-indigo-100 text-indigo-700 ring-indigo-200",
];
function initials(name: string): string {
  const parts = (name || "؟").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "؟";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] ?? "") + (parts[1][0] ?? "");
}

function ZoneUserChips({ zoneId, cid, onManage }: { zoneId: number; cid?: number; onManage: () => void }) {
  const q = useQuery({
    queryKey: ["zone-users", zoneId, cid],
    queryFn: () => userTrackingApi.zoneUsers(zoneId, cid),
    staleTime: 30_000,
  });
  const users = q.data ?? [];
  const MAX = 3;
  const shown = users.slice(0, MAX);
  const extra = Math.max(0, users.length - MAX);

  if (q.isLoading) {
    return <div className="flex justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="flex items-center justify-center gap-2 flex-wrap">
      {users.length === 0 ? (
        <button
          type="button"
          onClick={onManage}
          className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-l from-emerald-50 to-teal-50 border border-emerald-200 text-emerald-700 px-2.5 py-1 text-[11px] font-medium hover:shadow-sm hover:border-emerald-300 transition"
          title="عام — مطبَّقة على كل الموظفين. اضغط لتقييدها بمستخدمين."
        >
          <Globe2 className="h-3.5 w-3.5" />
          كل الموظفين
        </button>
      ) : (
        <div className="flex -space-x-2 space-x-reverse">
          {shown.map((u, i) => (
            <span
              key={u.userId}
              title={`${u.userName} (@${u.username})`}
              className={`inline-flex items-center justify-center h-7 w-7 rounded-full ring-2 ring-white text-[11px] font-bold ${CHIP_COLORS[u.userId % CHIP_COLORS.length]}`}
              style={{ zIndex: MAX - i }}
            >
              {initials(u.userName)}
            </span>
          ))}
          {extra > 0 && (
            <span
              className="inline-flex items-center justify-center h-7 w-7 rounded-full ring-2 ring-white bg-slate-200 text-slate-700 text-[11px] font-bold"
              title={users.slice(MAX).map(u => u.userName).join("، ")}
            >
              +{extra}
            </span>
          )}
        </div>
      )}

      {users.length > 0 && (
        <span className="text-[11px] text-muted-foreground">
          {users.length} مستخدم
        </span>
      )}

      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-[11px] text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50"
        onClick={onManage}
      >
        <UserPlus className="h-3.5 w-3.5 me-1" /> إدارة
      </Button>
    </div>
  );
}

function ZoneAssignDialog({ zone, cid, onClose }: { zone: TrackingZone; cid?: number; onClose: () => void }) {
  const qc = useQueryClient();
  const assignedQ = useQuery({
    queryKey: ["zone-users", zone.id, cid],
    queryFn: () => userTrackingApi.zoneUsers(zone.id, cid),
  });
  const usersQ = useQuery({
    queryKey: ["company-users-picker", cid],
    queryFn: () => userTrackingApi.companyUsers(cid),
  });
  const [pickUserId, setPickUserId] = useState<number | "">("");

  const assigned = assignedQ.data ?? [];
  const assignedIds = new Set(assigned.map(a => a.userId));
  const candidates = (usersQ.data ?? []).filter(u => !assignedIds.has(u.id));

  const add = useMutation({
    mutationFn: (userId: number) => userTrackingApi.assignUserToZone(zone.id, userId, cid),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["zone-users", zone.id, cid] }); setPickUserId(""); },
  });
  const remove = useMutation({
    mutationFn: (userId: number) => userTrackingApi.unassignUserFromZone(zone.id, userId, cid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["zone-users", zone.id, cid] }),
  });

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>المستخدمون المعيَّنون للمنطقة: {zone.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {assigned.length === 0 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              لا يوجد مستخدمون معيَّنون. حالياً هذه المنطقة تُطبَّق على <strong>كل</strong> موظفي الشركة (عام).
            </div>
          ) : (
            <ul className="border rounded-md divide-y">
              {assigned.map(u => (
                <li key={u.userId} className="flex items-center justify-between px-3 py-2">
                  <div>
                    <div className="font-medium">{u.userName}</div>
                    <div className="text-xs text-muted-foreground">@{u.username}</div>
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => remove.mutate(u.userId)} disabled={remove.isPending}>
                    <X className="h-4 w-4 text-rose-600" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2 items-end pt-2 border-t">
            <div className="flex-1">
              <Label>إضافة مستخدم</Label>
              <select
                className="w-full mt-1 h-10 rounded-md border px-2 bg-background"
                value={pickUserId}
                onChange={(e) => setPickUserId(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">— اختر مستخدماً —</option>
                {candidates.map(u => (
                  <option key={u.id} value={u.id}>{u.name} (@{u.username})</option>
                ))}
              </select>
            </div>
            <Button onClick={() => pickUserId && add.mutate(Number(pickUserId))} disabled={!pickUserId || add.isPending}>
              <UserPlus className="h-4 w-4 me-1" /> إضافة
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>إغلاق</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
