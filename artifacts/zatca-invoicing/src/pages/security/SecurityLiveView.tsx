import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Camera as CamIcon, Wifi, WifiOff, Grid3x3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select, SelectTrigger, SelectContent, SelectItem, SelectValue,
} from "@/components/ui/select";
import { surveillanceDevicesApi, type SurveillanceDevice } from "@/lib/securityAiApi";

// Live View — multi-camera mosaic. We don't actually proxy RTSP in the
// browser (no codec); we render a placeholder tile per camera that links
// to its stream URL when available, plus a status indicator. Operators
// can use this screen to spot dead cameras quickly.

const LAYOUTS = [4, 9, 16] as const;

export default function SecurityLiveView() {
  const { t } = useTranslation();
  const [grid, setGrid] = useState<typeof LAYOUTS[number]>(9);

  const camsQ = useQuery({
    queryKey: ["surveillance-devices", "live"],
    queryFn: async () => {
      const all = await surveillanceDevicesApi.list();
      return all.filter(d => d.deviceType === "camera_ip" || d.deviceType === "camera_analog");
    },
    refetchInterval: 30_000,
  });

  const cams = useMemo(() => (camsQ.data ?? []).slice(0, grid), [camsQ.data, grid]);
  // pad to grid
  const tiles = useMemo(() => {
    const arr: (SurveillanceDevice | null)[] = [...cams];
    while (arr.length < grid) arr.push(null);
    return arr;
  }, [cams, grid]);

  const cols = grid === 4 ? 2 : grid === 9 ? 3 : 4;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <CamIcon className="w-5 h-5 text-rose-600" />
            {t("security.liveView.title")}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Grid3x3 className="w-4 h-4 text-muted-foreground" />
            <Select value={String(grid)} onValueChange={v => setGrid(Number(v) as any)}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LAYOUTS.map(n => (
                  <SelectItem key={n} value={String(n)}>{n} {t("security.liveView.tiles")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => camsQ.refetch()}>
              {t("common.refresh")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className={`grid gap-2`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {tiles.map((cam, idx) => (
              <LiveTile key={cam?.id ?? `empty-${idx}`} cam={cam} />
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {t("security.liveView.note")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function LiveTile({ cam }: { cam: SurveillanceDevice | null }) {
  const { t } = useTranslation();
  if (!cam) {
    return (
      <div className="aspect-video bg-slate-900/90 rounded-md grid place-items-center text-slate-400 text-xs">
        {t("security.liveView.empty")}
      </div>
    );
  }
  const ok = cam.status === "active";
  return (
    <div className="aspect-video bg-slate-900 rounded-md relative overflow-hidden group">
      {/* mosaic placeholder */}
      <div className="absolute inset-0 grid place-items-center text-slate-500">
        <CamIcon className="w-10 h-10" />
      </div>
      {/* overlay */}
      <div className="absolute top-1 start-1 right-1 flex items-center justify-between text-[11px]">
        <span className="bg-black/60 text-white px-2 py-0.5 rounded font-mono">{cam.code}</span>
        <span className={`px-1.5 py-0.5 rounded flex items-center gap-1 ${ok ? "bg-emerald-600 text-white" : "bg-rose-600 text-white"}`}>
          {ok ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
          {ok ? t("security.liveView.online") : t("security.liveView.offline")}
        </span>
      </div>
      <div className="absolute bottom-1 start-1 right-1 text-[11px] bg-black/60 text-white px-2 py-1 rounded">
        <div className="font-medium truncate">{cam.nameAr}</div>
        {cam.location && <div className="opacity-70 truncate">{cam.location}</div>}
      </div>
    </div>
  );
}
