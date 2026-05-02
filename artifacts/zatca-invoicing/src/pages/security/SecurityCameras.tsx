import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Pencil, Camera as CamIcon, RefreshCw, Link2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectTrigger, SelectContent, SelectItem, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { surveillanceDevicesApi, type SurveillanceDevice } from "@/lib/securityAiApi";

// CAMERAS = camera_ip / camera_analog. ERP-linked: dept / prod-line /
// warehouse / employee. The linkage drives the AI rule engine.
const CAM_TYPES = ["camera_ip", "camera_analog"] as const;
const STATUS = ["active", "inactive", "maintenance"] as const;
const LOC_TYPES = [
  "generic", "department", "production_line", "warehouse",
  "employee_workstation", "entrance", "parking",
] as const;
const PROTOS = ["rtsp", "onvif", "http", "hls"] as const;

const STATUS_TONE: Record<string, string> = {
  active:      "bg-emerald-100 text-emerald-900 border-emerald-200",
  inactive:    "bg-slate-100 text-slate-700 border-slate-200",
  maintenance: "bg-amber-100 text-amber-900 border-amber-200",
};
const LOC_TONE: Record<string, string> = {
  department:           "bg-sky-100 text-sky-900 border-sky-200",
  production_line:      "bg-violet-100 text-violet-900 border-violet-200",
  warehouse:            "bg-amber-100 text-amber-900 border-amber-200",
  employee_workstation: "bg-emerald-100 text-emerald-900 border-emerald-200",
  entrance:             "bg-rose-100 text-rose-900 border-rose-200",
  parking:              "bg-slate-100 text-slate-800 border-slate-200",
  generic:              "bg-slate-50 text-slate-700 border-slate-200",
};

type FormState = Partial<SurveillanceDevice>;

export default function SecurityCameras() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<SurveillanceDevice | null>(null);
  const [creating, setCreating] = useState(false);

  const listQ = useQuery({
    queryKey: ["surveillance-devices", "cameras"],
    queryFn: async () => {
      const all = await surveillanceDevicesApi.list();
      return all.filter(d => d.deviceType === "camera_ip" || d.deviceType === "camera_analog");
    },
  });

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (listQ.data ?? []).filter(d =>
      !s ||
      d.code.toLowerCase().includes(s) ||
      d.nameAr.toLowerCase().includes(s) ||
      (d.location ?? "").toLowerCase().includes(s)
    );
  }, [listQ.data, search]);

  const removeM = useMutation({
    mutationFn: (id: number) => surveillanceDevicesApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["surveillance-devices"] });
      toast({ title: t("common.deleted") });
    },
    onError: (e: any) => toast({ title: t("common.error"), description: e?.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <CamIcon className="w-5 h-5 text-rose-600" />
            {t("security.cameras.title")}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Input
              placeholder={t("security.cameras.searchPh") as string}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-64"
            />
            <Button variant="outline" size="sm" onClick={() => listQ.refetch()}>
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="w-4 h-4 me-1" />
              {t("security.cameras.add")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-muted-foreground">
                <th className="p-2 text-start">{t("security.devices.col.code")}</th>
                <th className="p-2 text-start">{t("security.devices.col.name")}</th>
                <th className="p-2 text-start">{t("security.devices.col.type")}</th>
                <th className="p-2 text-start">{t("security.cameras.locType")}</th>
                <th className="p-2 text-start">{t("security.cameras.linkRef")}</th>
                <th className="p-2 text-start">{t("security.devices.col.location")}</th>
                <th className="p-2 text-start">{t("security.devices.col.status")}</th>
                <th className="p-2 text-end">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(d => (
                <tr key={d.id} className="border-t hover:bg-muted/40">
                  <td className="p-2 font-mono">{d.code}</td>
                  <td className="p-2 font-medium">{d.nameAr}</td>
                  <td className="p-2">{t(`security.deviceType.${d.deviceType}`)}</td>
                  <td className="p-2">
                    <Badge className={LOC_TONE[d.locationType ?? "generic"] ?? ""} variant="outline">
                      {t(`security.cameras.loc.${d.locationType ?? "generic"}`)}
                    </Badge>
                  </td>
                  <td className="p-2 text-xs">
                    {d.departmentId      && <span className="me-1">قسم #{d.departmentId}</span>}
                    {d.productionLineId  && <span className="me-1">خط #{d.productionLineId}</span>}
                    {d.warehouseId       && <span className="me-1">مخزن #{d.warehouseId}</span>}
                    {d.employeeId        && <span className="me-1">موظف #{d.employeeId}</span>}
                    {!d.departmentId && !d.productionLineId && !d.warehouseId && !d.employeeId && "—"}
                  </td>
                  <td className="p-2">{d.location ?? "—"}</td>
                  <td className="p-2">
                    <Badge className={STATUS_TONE[d.status] ?? ""} variant="outline">
                      {t(`security.deviceStatus.${d.status}`)}
                    </Badge>
                  </td>
                  <td className="p-2 text-end">
                    <Button size="icon" variant="ghost" onClick={() => setEditing(d)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon" variant="ghost"
                      onClick={() => {
                        if (confirm(t("security.devices.confirmDelete") as string)) removeM.mutate(d.id);
                      }}
                    >
                      <Trash2 className="w-4 h-4 text-rose-600" />
                    </Button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-muted-foreground">
                    {t("security.cameras.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {(creating || editing) && (
        <CameraDialog
          initial={editing ?? undefined}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["surveillance-devices"] });
            setCreating(false); setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function CameraDialog({
  initial, onClose, onSaved,
}: { initial?: SurveillanceDevice; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const isEdit = !!initial;
  const [form, setForm] = useState<FormState>(initial ?? {
    deviceType: "camera_ip", status: "active", locationType: "generic",
    streamProtocol: "rtsp",
  });

  const saveM = useMutation({
    mutationFn: () => isEdit
      ? surveillanceDevicesApi.update(initial!.id, form)
      : surveillanceDevicesApi.create(form),
    onSuccess: () => { toast({ title: t("common.saved") }); onSaved(); },
    onError: (e: any) => toast({ title: t("common.error"), description: e?.message, variant: "destructive" }),
  });

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(s => ({ ...s, [k]: v }));
  const lt = form.locationType ?? "generic";

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("security.cameras.edit") : t("security.cameras.add")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t("security.devices.col.code")}</Label>
            <Input value={form.code ?? ""} onChange={e => set("code", e.target.value)} placeholder="auto" />
          </div>
          <div>
            <Label>{t("security.devices.col.name")} *</Label>
            <Input value={form.nameAr ?? ""} onChange={e => set("nameAr", e.target.value)} required />
          </div>
          <div>
            <Label>{t("security.devices.col.type")}</Label>
            <Select value={form.deviceType ?? "camera_ip"} onValueChange={v => set("deviceType", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CAM_TYPES.map(c => (
                  <SelectItem key={c} value={c}>{t(`security.deviceType.${c}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("security.devices.col.status")}</Label>
            <Select value={form.status ?? "active"} onValueChange={v => set("status", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUS.map(s => (
                  <SelectItem key={s} value={s}>{t(`security.deviceStatus.${s}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>{t("security.devices.col.ip")}</Label>
            <Input value={form.ipAddress ?? ""} onChange={e => set("ipAddress", e.target.value)} placeholder="192.168.1.20" />
          </div>
          <div>
            <Label>{t("security.devices.col.port")}</Label>
            <Input type="number" value={form.port ?? ""} onChange={e => set("port", Number(e.target.value) || null)} />
          </div>
          <div>
            <Label>{t("security.cameras.proto")}</Label>
            <Select value={form.streamProtocol ?? "rtsp"} onValueChange={v => set("streamProtocol", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PROTOS.map(p => <SelectItem key={p} value={p}>{p.toUpperCase()}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("security.cameras.streamUrl")}</Label>
            <Input value={form.streamUrl ?? ""} onChange={e => set("streamUrl", e.target.value)} placeholder="rtsp://…" />
          </div>

          <div className="col-span-2 mt-2 border-t pt-3">
            <div className="flex items-center gap-2 text-sm font-semibold mb-2">
              <Link2 className="w-4 h-4 text-violet-600" />
              {t("security.cameras.linkSection")}
            </div>
          </div>
          <div>
            <Label>{t("security.cameras.locType")}</Label>
            <Select value={lt} onValueChange={v => set("locationType", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LOC_TYPES.map(l => (
                  <SelectItem key={l} value={l}>{t(`security.cameras.loc.${l}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("security.devices.col.location")}</Label>
            <Input value={form.location ?? ""} onChange={e => set("location", e.target.value)} />
          </div>
          {(lt === "department") && (
            <div>
              <Label>{t("security.cameras.departmentId")}</Label>
              <Input type="number" value={form.departmentId ?? ""} onChange={e => set("departmentId", Number(e.target.value) || null)} />
            </div>
          )}
          {(lt === "production_line") && (
            <div>
              <Label>{t("security.cameras.productionLineId")}</Label>
              <Input type="number" value={form.productionLineId ?? ""} onChange={e => set("productionLineId", Number(e.target.value) || null)} />
            </div>
          )}
          {(lt === "warehouse") && (
            <div>
              <Label>{t("security.cameras.warehouseId")}</Label>
              <Input type="number" value={form.warehouseId ?? ""} onChange={e => set("warehouseId", Number(e.target.value) || null)} />
            </div>
          )}
          {(lt === "employee_workstation") && (
            <div>
              <Label>{t("security.cameras.employeeId")}</Label>
              <Input type="number" value={form.employeeId ?? ""} onChange={e => set("employeeId", Number(e.target.value) || null)} />
            </div>
          )}

          <div className="col-span-2">
            <Label>{t("common.notes")}</Label>
            <Textarea value={form.notes ?? ""} onChange={e => set("notes", e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button onClick={() => saveM.mutate()} disabled={saveM.isPending}>
            {saveM.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
