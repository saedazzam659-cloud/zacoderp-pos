import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { faceApi, type Camera } from "@/lib/faceAttendanceApi";
import { branchesApi } from "@/lib/branchesApi";
import { useToast } from "@/hooks/use-toast";
import { parseError } from "@/lib/parseError";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Camera as CameraIcon, Plus, Wifi, Trash2, Pencil } from "lucide-react";

const KIND_LABELS: Record<string, string> = {
  webcam: "متصفح (Webcam)",
  rtsp: "RTSP مباشر",
  dvr: "DVR / NVR",
  ip: "كاميرا IP",
};

export default function AttendanceCameras() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Camera | null>(null);

  const { data: cameras = [], isLoading } = useQuery<Camera[]>({ queryKey: ["face-cameras"], queryFn: () => faceApi.cameras() });
  const { data: branches = [] } = useQuery<any[]>({ queryKey: ["branches"], queryFn: () => branchesApi.getBranches() });

  const [form, setForm] = useState({
    name: "", location: "", kind: "webcam", branchId: "", dvrIp: "", port: "", channel: "",
    protocol: "rtsp", username: "", password: "", streamUrl: "", aiEnabled: true, status: "active", notes: "",
  });

  function openNew() {
    setEditing(null);
    setForm({ name: "", location: "", kind: "webcam", branchId: "", dvrIp: "", port: "", channel: "",
      protocol: "rtsp", username: "", password: "", streamUrl: "", aiEnabled: true, status: "active", notes: "" });
    setOpen(true);
  }

  function openEdit(c: Camera) {
    setEditing(c);
    setForm({
      name: c.name, location: c.location ?? "", kind: c.kind, branchId: c.branchId ? String(c.branchId) : "",
      dvrIp: c.dvrIp ?? "", port: c.port ? String(c.port) : "", channel: c.channel ? String(c.channel) : "",
      protocol: c.protocol ?? "rtsp", username: "", password: "", streamUrl: c.streamUrl ?? "",
      aiEnabled: c.aiEnabled, status: c.status, notes: c.notes ?? "",
    });
    setOpen(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const payload: any = {
        name: form.name,
        location: form.location || null,
        kind: form.kind,
        branchId: form.branchId ? Number(form.branchId) : null,
        dvrIp: form.dvrIp || null,
        port: form.port || null,
        channel: form.channel || null,
        protocol: form.protocol || null,
        username: form.username || null,
        password: form.password || null,
        streamUrl: form.streamUrl || null,
        aiEnabled: form.aiEnabled,
        status: form.status,
        notes: form.notes || null,
      };
      return editing ? faceApi.updateCamera(editing.id, payload) : faceApi.createCamera(payload);
    },
    onSuccess: () => {
      toast({ title: editing ? "تم التحديث" : "تمت الإضافة" });
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["face-cameras"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: parseError(e), variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: (id: number) => faceApi.deleteCamera(id),
    onSuccess: () => { toast({ title: "تم الحذف" }); qc.invalidateQueries({ queryKey: ["face-cameras"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: parseError(e), variant: "destructive" }),
  });

  const pingMut = useMutation({
    mutationFn: (id: number) => faceApi.pingCamera(id),
    onSuccess: (r) => toast({ title: r.ok ? "نجح" : "فشل", description: r.message }),
    onError: (e: any) => toast({ title: "خطأ", description: parseError(e), variant: "destructive" }),
  });

  return (
    <div className="p-6 space-y-6" data-testid="page-attendance-cameras">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CameraIcon className="h-6 w-6 text-primary" /> كاميرات الحضور
          </h1>
          <p className="text-sm text-muted-foreground mt-1">إدارة الكاميرات وأجهزة DVR للتعرف الذكي على الوجوه</p>
        </div>
        <Button onClick={openNew} data-testid="btn-add-camera">
          <Plus className="h-4 w-4 mr-2" /> إضافة كاميرا
        </Button>
      </div>

      <Card className="p-4">
        {isLoading ? (
          <p className="text-center text-sm text-muted-foreground py-8">جاري التحميل...</p>
        ) : cameras.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <CameraIcon className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p>لا توجد كاميرات بعد</p>
            <Button variant="outline" className="mt-3" onClick={openNew}>إضافة أول كاميرا</Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-right p-3">الاسم</th>
                  <th className="text-right p-3">النوع</th>
                  <th className="text-right p-3">الفرع</th>
                  <th className="text-right p-3">الموقع</th>
                  <th className="text-right p-3">العنوان</th>
                  <th className="text-right p-3">AI</th>
                  <th className="text-right p-3">الحالة</th>
                  <th className="text-right p-3"></th>
                </tr>
              </thead>
              <tbody>
                {cameras.map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="p-3 font-medium">{c.name}</td>
                    <td className="p-3"><Badge variant="outline">{KIND_LABELS[c.kind] ?? c.kind}</Badge></td>
                    <td className="p-3">{c.branchName ?? "—"}</td>
                    <td className="p-3 text-muted-foreground">{c.location ?? "—"}</td>
                    <td className="p-3 font-mono text-xs">
                      {c.kind === "webcam" ? "—" : c.streamUrl ?? `${c.dvrIp ?? ""}${c.port ? `:${c.port}` : ""}${c.channel ? `/ch${c.channel}` : ""}`}
                    </td>
                    <td className="p-3">{c.aiEnabled ? <Badge>مفعّل</Badge> : <Badge variant="secondary">معطّل</Badge>}</td>
                    <td className="p-3">
                      <Badge variant={c.status === "active" ? "default" : "secondary"}>{c.status === "active" ? "نشط" : c.status}</Badge>
                    </td>
                    <td className="p-3 flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => pingMut.mutate(c.id)} title="فحص الاتصال" data-testid={`btn-ping-${c.id}`}>
                        <Wifi className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(c)} data-testid={`btn-edit-camera-${c.id}`}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => delMut.mutate(c.id)} data-testid={`btn-delete-camera-${c.id}`}>
                        <Trash2 className="h-4 w-4 text-rose-500" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "تعديل كاميرا" : "إضافة كاميرا جديدة"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>الاسم *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="input-camera-name" />
            </div>
            <div>
              <Label>الموقع</Label>
              <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="البوابة الرئيسية" />
            </div>
            <div>
              <Label>النوع</Label>
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v })}>
                <SelectTrigger data-testid="select-camera-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="webcam">{KIND_LABELS.webcam}</SelectItem>
                  <SelectItem value="rtsp">{KIND_LABELS.rtsp}</SelectItem>
                  <SelectItem value="dvr">{KIND_LABELS.dvr}</SelectItem>
                  <SelectItem value="ip">{KIND_LABELS.ip}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>الفرع</Label>
              <Select value={form.branchId} onValueChange={(v) => setForm({ ...form, branchId: v })}>
                <SelectTrigger><SelectValue placeholder="غير محدد" /></SelectTrigger>
                <SelectContent>
                  {branches.map((b: any) => <SelectItem key={b.id} value={String(b.id)}>{b.nameAr}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {form.kind !== "webcam" && (
              <>
                <div>
                  <Label>عنوان IP / DVR</Label>
                  <Input value={form.dvrIp} onChange={(e) => setForm({ ...form, dvrIp: e.target.value })} placeholder="192.168.1.10" />
                </div>
                <div>
                  <Label>المنفذ</Label>
                  <Input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} placeholder="554" />
                </div>
                <div>
                  <Label>القناة</Label>
                  <Input value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} placeholder="1" />
                </div>
                <div>
                  <Label>البروتوكول</Label>
                  <Select value={form.protocol} onValueChange={(v) => setForm({ ...form, protocol: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rtsp">RTSP</SelectItem>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="onvif">ONVIF</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>المستخدم</Label>
                  <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                </div>
                <div>
                  <Label>كلمة المرور</Label>
                  <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                </div>
                <div className="col-span-2">
                  <Label>عنوان البث الكامل (اختياري)</Label>
                  <Input value={form.streamUrl} onChange={(e) => setForm({ ...form, streamUrl: e.target.value })}
                    placeholder="rtsp://user:pass@192.168.1.10:554/Streaming/Channels/101" />
                </div>
              </>
            )}
            <div className="col-span-2 flex items-center gap-3 pt-2">
              <Switch checked={form.aiEnabled} onCheckedChange={(v) => setForm({ ...form, aiEnabled: v })} />
              <Label>تفعيل التعرف الذكي على الوجوه</Label>
            </div>
            <div className="col-span-2">
              <Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button onClick={() => saveMut.mutate()} disabled={!form.name || saveMut.isPending} data-testid="btn-save-camera">
              {saveMut.isPending ? "جاري الحفظ..." : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
