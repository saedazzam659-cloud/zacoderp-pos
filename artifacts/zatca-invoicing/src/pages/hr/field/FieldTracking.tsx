import { useQuery } from "@tanstack/react-query";
import { fieldApi } from "@/lib/fieldServiceApi";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, MapPin, ExternalLink, Clock } from "lucide-react";

export default function FieldTracking() {
  const { data, isLoading } = useQuery({
    queryKey: ["fsm-live-track"],
    queryFn: () => fieldApi.liveTracking(),
    refetchInterval: 20_000,
  });

  return (
    <div className="p-6 space-y-4" dir="rtl" data-testid="page-field-tracking">
      <div className="flex items-center gap-2">
        <Activity className="h-6 w-6 text-rose-500" />
        <h1 className="text-2xl font-bold">التتبع المباشر للفريق</h1>
      </div>
      <p className="text-sm text-muted-foreground">آخر موقع معروف لكل موظف ميداني — يتحدث كل ٢٠ ثانية</p>

      {isLoading && <div className="text-center text-muted-foreground py-8">جاري التحميل...</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {(data ?? []).map((r) => {
          const lat = r.departure_lat ?? r.arrival_lat;
          const lng = r.departure_lng ?? r.arrival_lng;
          return (
            <Card key={r.employee_id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge className={r.status === "open" ? "bg-emerald-500" : "bg-zinc-500"}>
                      {r.status === "open" ? "في الميدان" : "أنهى الزيارة"}
                    </Badge>
                  </div>
                  <div className="font-semibold">{r.employee_name}</div>
                  <div className="text-xs text-muted-foreground">{r.employee_code}</div>
                  <div className="flex items-center gap-1 text-sm mt-2">
                    <MapPin className="h-4 w-4 text-blue-500" />
                    <span className="truncate">{r.location_name ?? "—"}</span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                    <Clock className="h-3 w-3" />
                    {new Date(r.arrived_at).toLocaleTimeString("ar-SA")}
                    {r.duration_min ? ` • ${r.duration_min} د` : ""}
                  </div>
                </div>
                {lat && lng && (
                  <a href={`https://www.google.com/maps?q=${lat},${lng}`} target="_blank" rel="noreferrer">
                    <Button size="sm" variant="ghost"><ExternalLink className="h-4 w-4" /></Button>
                  </a>
                )}
              </div>
            </Card>
          );
        })}
        {(data ?? []).length === 0 && !isLoading && (
          <div className="col-span-full text-center text-muted-foreground py-12">
            لا يوجد فريق ميداني نشط اليوم
          </div>
        )}
      </div>
    </div>
  );
}
