import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { faceApi } from "@/lib/faceAttendanceApi";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, MapPin, Save, Crosshair, ExternalLink, Search, Users, AlertTriangle,
} from "lucide-react";

type EmpRow = Awaited<ReturnType<typeof faceApi.workLocations>>[number];

interface Draft {
  lat: string;
  lng: string;
  radiusM: string;
}

const DEFAULT_RADIUS = "200";

export default function WorkLocations() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: rows = [], isLoading } = useQuery<EmpRow[]>({
    queryKey: ["face-work-locations"],
    queryFn: () => faceApi.workLocations(),
  });

  const [filter, setFilter] = useState("");
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [busyId, setBusyId] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: async ({ id, d }: { id: number; d: Draft }) => {
      // Empty inputs clear the geofence (NULL on server) — useful for
      // back-office staff who shouldn't be subject to GPS checks.
      const lat = d.lat.trim() ? Number(d.lat) : null;
      const lng = d.lng.trim() ? Number(d.lng) : null;
      const radiusM = d.radiusM.trim() ? Number(d.radiusM) : null;
      return faceApi.setWorkLocation(id, { lat, lng, radiusM });
    },
    onSuccess: () => {
      toast({ title: "تم الحفظ" });
      qc.invalidateQueries({ queryKey: ["face-work-locations"] });
    },
    onError: (e: any) => toast({ title: "تعذر الحفظ", description: e?.message ?? "", variant: "destructive" }),
    onSettled: () => setBusyId(null),
  });

  const draftFor = (r: EmpRow): Draft => drafts[r.id] ?? {
    lat: r.workLat ?? "",
    lng: r.workLng ?? "",
    radiusM: r.workRadiusM != null ? String(r.workRadiusM) : "",
  };

  const setDraft = (id: number, patch: Partial<Draft>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...draftFor(rows.find((r) => r.id === id)!), ...patch } }));
  };

  const useMyLocation = (id: number) => {
    if (!("geolocation" in navigator)) {
      toast({ title: "المتصفح لا يدعم الموقع", variant: "destructive" }); return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setDraft(id, {
          lat: pos.coords.latitude.toFixed(6),
          lng: pos.coords.longitude.toFixed(6),
        });
        toast({ title: "تم استخدام موقعك الحالي", description: `دقة ±${Math.round(pos.coords.accuracy)} م` });
      },
      (e) => toast({ title: "تعذر تحديد موقعك", description: e.message, variant: "destructive" }),
      { enableHighAccuracy: true, timeout: 12000 },
    );
  };

  const filtered = rows.filter((r) =>
    !filter ||
    r.nameAr.includes(filter) ||
    (r.code ?? "").includes(filter) ||
    (r.department ?? "").includes(filter),
  );
  const configured = rows.filter((r) => r.workLat && r.workLng).length;

  return (
    <div className="p-6 space-y-5" data-testid="page-work-locations">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MapPin className="h-6 w-6 text-emerald-600" /> مواقع عمل الموظفين
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            حدّد إحداثيات GPS ونصف القطر المسموح لكل موظف. عند تسجيل الحضور من تطبيق الجوال، يتم التحقق من
            وجود الموظف داخل النطاق المسموح.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            <Users className="h-3 w-3 me-1" /> {configured} / {rows.length} موظف مُهيّأ
          </Badge>
        </div>
      </div>

      <Card className="p-4 bg-amber-50 border-amber-200">
        <div className="flex gap-2 text-sm text-amber-900">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            الموظف بدون إحداثيات يستطيع التسجيل من أي مكان — مفيد للموظفين المكتبيين.
            لتطبيق نطاق صارم اضبط الإحداثيات + نصف القطر، ثم اطلب من الموظفين استخدام
            <span className="font-mono mx-1">/hr/check-in</span> من جوّالاتهم.
          </div>
        </div>
      </Card>

      <div className="relative max-w-sm">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="بحث بالاسم أو الكود أو القسم..."
          className="pr-9"
          data-testid="input-search"
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : (
        <div className="space-y-3">
          {filtered.map((r) => {
            const d = draftFor(r);
            const dirty = (drafts[r.id] && (
              d.lat !== (r.workLat ?? "") ||
              d.lng !== (r.workLng ?? "") ||
              d.radiusM !== (r.workRadiusM != null ? String(r.workRadiusM) : "")
            )) || false;
            const hasCoords = !!(d.lat.trim() && d.lng.trim());
            return (
              <Card key={r.id} className="p-4" data-testid={`row-emp-${r.id}`}>
                <div className="grid md:grid-cols-[1fr,2fr] gap-4">
                  <div className="flex items-start gap-3">
                    {r.photoUrl ? (
                      <img src={r.photoUrl} alt="" className="h-12 w-12 rounded-full object-cover" />
                    ) : (
                      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-sm font-bold">
                        {r.nameAr.slice(0, 1)}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="font-semibold truncate">{r.nameAr}</div>
                      <div className="text-xs text-muted-foreground">{r.code} · {r.jobTitle ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{r.department ?? "—"}</div>
                      {hasCoords && (
                        <a
                          href={`https://www.google.com/maps?q=${d.lat},${d.lng}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-1"
                        >
                          عرض على الخريطة <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
                    <div>
                      <label className="text-xs text-muted-foreground">خط العرض</label>
                      <Input
                        value={d.lat}
                        onChange={(e) => setDraft(r.id, { lat: e.target.value })}
                        placeholder="24.123456"
                        dir="ltr"
                        className="font-mono text-sm"
                        data-testid={`input-lat-${r.id}`}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">خط الطول</label>
                      <Input
                        value={d.lng}
                        onChange={(e) => setDraft(r.id, { lng: e.target.value })}
                        placeholder="46.123456"
                        dir="ltr"
                        className="font-mono text-sm"
                        data-testid={`input-lng-${r.id}`}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">نصف القطر (م)</label>
                      <Input
                        value={d.radiusM}
                        onChange={(e) => setDraft(r.id, { radiusM: e.target.value })}
                        placeholder={DEFAULT_RADIUS}
                        type="number"
                        min={10}
                        max={5000}
                        data-testid={`input-radius-${r.id}`}
                      />
                    </div>
                    <div className="flex gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => useMyLocation(r.id)}
                        title="استخدم موقعي الحالي"
                        data-testid={`button-mylocation-${r.id}`}
                      >
                        <Crosshair className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!dirty || busyId === r.id}
                        onClick={() => { setBusyId(r.id); save.mutate({ id: r.id, d }); }}
                        className="gap-1"
                        data-testid={`button-save-${r.id}`}
                      >
                        {busyId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        حفظ
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
          {filtered.length === 0 && (
            <Card className="p-8 text-center text-muted-foreground">لا يوجد موظفون يطابقون البحث</Card>
          )}
        </div>
      )}
    </div>
  );
}
