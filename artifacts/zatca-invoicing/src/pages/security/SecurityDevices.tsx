import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Pencil, Server, RefreshCw } from "lucide-react";
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

// DEVICES = DVR / NVR / hybrid recorders. Cameras live on a separate page.
// Rule: deviceType ∈ { "dvr","nvr","hybrid" } here.
const DEVICE_TYPES = ["dvr", "nvr", "hybrid"] as const;
const STATUS = ["active", "inactive", "maintenance"] as const;

const STATUS_TONE: Record<string, string> = {
  active:      "bg-emerald-100 text-emerald-900 border-emerald-200",
  inactive:    "bg-slate-100 text-slate-700 border-slate-200",
  maintenance: "bg-amber-100 text-amber-900 border-amber-200",
};

type FormState = Partial<SurveillanceDevice>;

export default function SecurityDevices() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<SurveillanceDevice | null>(null);
  const [creating, setCreating] = useState(false);

  const listQ = useQuery({
    queryKey: ["surveillance-devices", "recorders"],
    queryFn: async () => {
      const all = await surveillanceDevicesApi.list();
      return all.filter(d => d.deviceType === "dvr" || d.deviceType === "nvr" || d.deviceType === "hybrid");
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
            <Server className="w-5 h-5 text-rose-600" />
            {t("security.devices.title")}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Input
              placeholder={t("security.devices.searchPh") as string}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-64"
            />
            <Button variant="outline" size="sm" onClick={() => listQ.refetch()}>
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="w-4 h-4 me-1" />
              {t("security.devices.add")}
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
                <th className="p-2 text-start">{t("security.devices.col.brand")}</th>
                <th className="p-2 text-start">{t("security.devices.col.channels")}</th>
                <th className="p-2 text-start">{t("security.devices.col.ip")}</th>
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
                  <td className="p-2">{d.brand ?? "—"}</td>
                  <td className="p-2">{d.channelsCount ?? "—"}</td>
                  <td className="p-2 font-mono text-xs">{d.ipAddress ?? "—"}</td>
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
                    {t("security.devices.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {(creating || editing) && (
        <DeviceDialog
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

function DeviceDialog({
  initial, onClose, onSaved,
}: { initial?: SurveillanceDevice; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const isEdit = !!initial;
  const [form, setForm] = useState<FormState>(initial ?? {
    deviceType: "nvr", status: "active", channelsCount: 16,
  });

  const saveM = useMutation({
    mutationFn: () => isEdit
      ? surveillanceDevicesApi.update(initial!.id, form)
      : surveillanceDevicesApi.create(form),
    onSuccess: () => { toast({ title: t("common.saved") }); onSaved(); },
    onError: (e: any) => toast({ title: t("common.error"), description: e?.message, variant: "destructive" }),
  });

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(s => ({ ...s, [k]: v }));

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("security.devices.edit") : t("security.devices.add")}
          </DialogTitle>
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
            <Select value={form.deviceType ?? "nvr"} onValueChange={v => set("deviceType", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {DEVICE_TYPES.map(t0 => (
                  <SelectItem key={t0} value={t0}>{t(`security.deviceType.${t0}`)}</SelectItem>
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
            <Label>{t("security.devices.col.brand")}</Label>
            <Input value={form.brand ?? ""} onChange={e => set("brand", e.target.value)} />
          </div>
          <div>
            <Label>{t("security.devices.col.model")}</Label>
            <Input value={form.model ?? ""} onChange={e => set("model", e.target.value)} />
          </div>
          <div>
            <Label>{t("security.devices.col.channels")}</Label>
            <Input type="number" value={form.channelsCount ?? ""} onChange={e => set("channelsCount", Number(e.target.value) || null)} />
          </div>
          <div>
            <Label>{t("security.devices.col.ip")}</Label>
            <Input value={form.ipAddress ?? ""} onChange={e => set("ipAddress", e.target.value)} placeholder="192.168.1.10" />
          </div>
          <div>
            <Label>{t("security.devices.col.port")}</Label>
            <Input type="number" value={form.port ?? ""} onChange={e => set("port", Number(e.target.value) || null)} />
          </div>
          <div>
            <Label>{t("security.devices.col.serial")}</Label>
            <Input value={form.serialNumber ?? ""} onChange={e => set("serialNumber", e.target.value)} />
          </div>
          <div className="col-span-2">
            <Label>{t("security.devices.col.location")}</Label>
            <Input value={form.location ?? ""} onChange={e => set("location", e.target.value)} />
          </div>
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
