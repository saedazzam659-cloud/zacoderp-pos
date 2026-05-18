import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { userTrackingApi, type LiveUser, type TrackingZone } from "@/lib/userTrackingApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { MapPin, Users, Clock, AlertTriangle, RefreshCw, Activity, CircleOff, ArrowRight } from "lucide-react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// FREE OpenStreetMap raster tile style — same one used in the main tracking
// page. No API key required.
const OSM_STYLE: any = {
  version: 8,
  sources: { osm: {
    type: "raster",
    tiles: ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png", "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png", "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"],
    tileSize: 256,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  } },
  layers: [{ id: "osm-tiles", type: "raster", source: "osm" }],
};

function fmtMin(min: number | null | undefined): string {
  if (min === null || min === undefined || min < 0) return "—";
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 0) return `${m} د`;
  return `${h} س ${m} د`;
}
function fmtTime(s: string | null | undefined): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" }); }
  catch { return s; }
}

export default function UserTrackingLive() {
  const { user } = useAuth();
  const cid = user?.companyId ?? undefined;

  // Auto-refresh toggle (default ON). Polls /live every 10 seconds while on.
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);

  const liveQ = useQuery({
    queryKey: ["user-tracking-live", cid],
    queryFn: () => userTrackingApi.live(cid),
    enabled: !!cid,
    refetchInterval: autoRefresh ? 10000 : false,
    refetchIntervalInBackground: false,
  });

  const zonesQ = useQuery({
    queryKey: ["user-tracking-zones-live", cid],
    queryFn: () => userTrackingApi.zones(cid),
    enabled: !!cid,
    staleTime: 60000,
  });

  const users = liveQ.data?.users ?? [];
  const zones = zonesQ.data ?? [];
  const activeUsers = users.filter(u => u.isActive);
  const offlineUsers = users.filter(u => !u.isActive);
  const usersWithAlerts = activeUsers.filter(u => u.visit?.alertFlags);

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Activity className="h-6 w-6 text-emerald-600" />
          التتبع المباشر للمستخدمين
          {liveQ.isFetching && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
        </h1>
        <div className="flex items-center gap-3">
          <Link href="/user-tracking">
            <Button variant="outline" size="sm"><ArrowRight className="h-4 w-4 me-1" /> لوحة التتبع</Button>
          </Link>
          <div className="flex items-center gap-2 text-sm">
            <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} id="auto-refresh" />
            <label htmlFor="auto-refresh" className="cursor-pointer">تحديث تلقائي (10ث)</label>
          </div>
          <Button size="sm" variant="outline" onClick={() => liveQ.refetch()} disabled={liveQ.isFetching}>
            <RefreshCw className={`h-4 w-4 me-1 ${liveQ.isFetching ? "animate-spin" : ""}`} /> تحديث
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiTile icon={Users}          label="المتابَعون"        value={users.length}            color="indigo" />
        <KpiTile icon={Activity}       label="نشط الآن"          value={activeUsers.length}      color="emerald" />
        <KpiTile icon={CircleOff}      label="غير متصل"           value={offlineUsers.length}     color="slate" />
        <KpiTile icon={AlertTriangle}  label="خارج النطاق"        value={usersWithAlerts.length}  color="rose" />
      </div>

      {/* Empty state */}
      {!liveQ.isLoading && users.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-3 opacity-40" />
            <p className="font-medium mb-1">لا يوجد مستخدمون مربوطون بأي منطقة تتبع</p>
            <p className="text-sm">
              لتفعيل التتبع التلقائي للمندوبين، اربطهم بمنطقة من{" "}
              <Link href="/user-tracking" className="text-indigo-600 underline">لوحة إدارة المناطق</Link>.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Map + side list */}
      {users.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Map */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <MapPin className="h-4 w-4" /> خريطة المواقع الحالية
                {liveQ.data?.serverTime && (
                  <span className="text-xs font-normal text-muted-foreground ms-auto">
                    آخر تحديث: {fmtTime(liveQ.data.serverTime)}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <LiveMap
                users={activeUsers}
                zones={zones}
                selectedUserId={selectedUserId}
                onSelectUser={setSelectedUserId}
              />
            </CardContent>
          </Card>

          {/* Side list */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">المستخدمون المتابَعون</CardTitle>
            </CardHeader>
            <CardContent className="p-0 max-h-[600px] overflow-y-auto">
              <ul className="divide-y">
                {[...activeUsers, ...offlineUsers].map(u => (
                  <UserCard
                    key={u.userId}
                    u={u}
                    isSelected={selectedUserId === u.userId}
                    onClick={() => setSelectedUserId(u.userId === selectedUserId ? null : u.userId)}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
function KpiTile({ icon: Icon, label, value, color }: { icon: any; label: string; value: number; color: string }) {
  const cls: Record<string, string> = {
    indigo:  "bg-indigo-50 text-indigo-700 border-indigo-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    slate:   "bg-slate-50 text-slate-700 border-slate-200",
    rose:    "bg-rose-50 text-rose-700 border-rose-200",
  };
  return (
    <div className={`rounded-md border p-3 flex items-center gap-3 ${cls[color] ?? cls.indigo}`}>
      <Icon className="h-7 w-7 opacity-80" />
      <div>
        <div className="text-xs">{label}</div>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
      </div>
    </div>
  );
}

function UserCard({ u, isSelected, onClick }: { u: LiveUser; isSelected: boolean; onClick: () => void }) {
  const hasAlert = !!u.visit?.alertFlags;
  return (
    <li
      onClick={onClick}
      className={`p-3 cursor-pointer transition-colors ${isSelected ? "bg-indigo-50" : "hover:bg-muted/50"}`}
    >
      <div className="flex items-start gap-2">
        <div className={`mt-1 w-3 h-3 rounded-full flex-shrink-0 ${
          u.isActive
            ? (hasAlert ? "bg-rose-500 animate-pulse" : "bg-emerald-500 animate-pulse")
            : "bg-slate-300"
        }`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{u.userName}</span>
            {u.isActive
              ? <Badge variant="secondary" className="bg-emerald-100 text-emerald-800 text-xs">نشط</Badge>
              : <Badge variant="outline" className="text-xs">غير متصل</Badge>}
            {hasAlert && <Badge variant="destructive" className="text-xs">{u.visit?.alertFlags === "out_of_allowed_zone" ? "خارج النطاق" : "تنبيه"}</Badge>}
          </div>
          {u.visit ? (
            <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-1"><MapPin className="h-3 w-3" /> {u.visit.place || u.visit.address || "موقع غير محدد"}</div>
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3" /> منذ {fmtMin(u.visit.elapsedMinutes)}
                {u.visit.zoneName && <span className="ms-2">· {u.visit.zoneName}</span>}
              </div>
            </div>
          ) : (
            <div className="mt-1 text-xs text-muted-foreground">
              {u.assignedZones.length > 0 ? (
                <>المناطق: {u.assignedZones.map(z => z.name).join("، ")}</>
              ) : "غير مربوط بأي منطقة"}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────
// Map component: shows active visit markers + zone circles. Re-renders when
// the visit list changes; uses maplibre's `setData` semantics indirectly by
// recreating markers + a circles GeoJSON source on each update.
function LiveMap({ users, zones, selectedUserId, onSelectUser }: {
  users: LiveUser[];
  zones: TrackingZone[];
  selectedUserId: number | null;
  onSelectUser: (id: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  // Initialize map once.
  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    mapRef.current = new maplibregl.Map({
      container: ref.current,
      style: OSM_STYLE,
      center: [46.6753, 24.7136], // Riyadh
      zoom: 5,
    });
    mapRef.current.addControl(new maplibregl.NavigationControl(), "top-left");

    // Draw zone circles as a GeoJSON source (drawn once, never invalidated
    // while the page is mounted — zones change rarely).
    mapRef.current.on("load", () => {
      const m = mapRef.current!;
      if (!m.getSource("zones")) {
        m.addSource("zones", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addLayer({
          id: "zones-fill", type: "circle", source: "zones",
          paint: {
            "circle-radius": ["get", "pxRadius"],
            "circle-color": ["case", ["get", "isAllowed"], "#10b981", "#f43f5e"],
            "circle-opacity": 0.12,
            "circle-stroke-color": ["case", ["get", "isAllowed"], "#10b981", "#f43f5e"],
            "circle-stroke-width": 2,
          },
        });
      }
    });

    return () => { mapRef.current?.remove(); mapRef.current = null; markersRef.current = []; };
  }, []);

  // Refresh zones overlay when zones change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("zones") as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      // Approximate px radius at current zoom; this isn't perfect geographic
      // accuracy but is good enough for at-a-glance display.
      const zoom = map.getZoom();
      const features = zones
        .filter(z => z.isActive)
        .map(z => {
          const lat = Number(z.centerLat), lng = Number(z.centerLng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          // metersPerPixel at this lat & zoom (web mercator):
          const mpp = (40075016.686 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, zoom + 8);
          const pxRadius = Math.max(6, Math.min(80, z.radiusMeters / mpp));
          return {
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: [lng, lat] },
            properties: { id: z.id, isAllowed: z.isAllowed, pxRadius },
          };
        })
        .filter(Boolean) as any[];
      src.setData({ type: "FeatureCollection", features });
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
    // Re-apply on zoom so the px-radius scales sensibly.
    const onZoom = () => apply();
    map.on("zoom", onZoom);
    return () => { map.off("zoom", onZoom); };
  }, [zones]);

  // Refresh user markers when the active user list changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Clear old markers.
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    const pts: [number, number][] = [];
    for (const u of users) {
      const v = u.visit;
      if (!v?.lat || !v?.lng) continue;
      const lat = Number(v.lat), lng = Number(v.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const isAlert = !!v.alertFlags;
      const isSelected = u.userId === selectedUserId;
      const el = document.createElement("div");
      const size = isSelected ? 22 : 16;
      const bg = isAlert ? "#f43f5e" : "#10b981";
      el.style.cssText = `
        background:${bg};width:${size}px;height:${size}px;border-radius:50%;
        border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,.35);
        cursor:pointer;display:flex;align-items:center;justify-content:center;
        color:white;font-size:10px;font-weight:bold;
      `;
      el.title = u.userName;
      el.onclick = (e) => { e.stopPropagation(); onSelectUser(u.userId); };

      const popup = new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(`
        <div style="font-family:system-ui;font-size:12px;direction:rtl;min-width:160px">
          <div style="font-weight:bold;margin-bottom:4px">${escapeHtml(u.userName)}</div>
          <div style="color:#555">${escapeHtml(v.place || v.address || "موقع غير محدد")}</div>
          <div style="color:#888;margin-top:4px">
            منذ ${fmtMin(v.elapsedMinutes)}${v.zoneName ? ` · ${escapeHtml(v.zoneName)}` : ""}
          </div>
          ${isAlert ? `<div style="color:#e11d48;margin-top:4px;font-weight:600">⚠ ${v.alertFlags === "out_of_allowed_zone" ? "خارج النطاق المسموح" : "تنبيه"}</div>` : ""}
        </div>
      `);

      const marker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).setPopup(popup).addTo(map);
      if (isSelected) marker.togglePopup();
      markersRef.current.push(marker);
      pts.push([lng, lat]);
    }

    // Fit bounds the first time we get points, but don't re-zoom on every poll
    // — that would be jarring while the user is panning around.
    if (pts.length > 0 && !fittedRef.current) {
      const lngs = pts.map(p => p[0]), lats = pts.map(p => p[1]);
      const bounds = new maplibregl.LngLatBounds([Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]);
      map.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 600 });
      fittedRef.current = true;
    }
  }, [users, selectedUserId, onSelectUser]);

  // Pan to selected user.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || selectedUserId === null) return;
    const u = users.find(x => x.userId === selectedUserId);
    if (!u?.visit?.lat || !u?.visit?.lng) return;
    map.flyTo({ center: [Number(u.visit.lng), Number(u.visit.lat)], zoom: Math.max(map.getZoom(), 13), duration: 500 });
  }, [selectedUserId, users]);

  const fittedRef = useRef(false);

  return <div ref={ref} className="w-full h-[600px] rounded-b-md overflow-hidden" />;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
