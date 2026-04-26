import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { faceApi, type FaceLog } from "@/lib/faceAttendanceApi";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollText, CheckCircle2, XCircle, AlertTriangle, Clock } from "lucide-react";

const STATUS_BADGE: Record<string, { label: string; cls: string; icon: any }> = {
  ok: { label: "ناجح", cls: "bg-emerald-100 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
  unknown: { label: "غير معروف", cls: "bg-rose-100 text-rose-700 border-rose-200", icon: XCircle },
  low_confidence: { label: "ثقة منخفضة", cls: "bg-amber-100 text-amber-700 border-amber-200", icon: Clock },
  spoof: { label: "محاولة تزوير", cls: "bg-red-100 text-red-700 border-red-200", icon: AlertTriangle },
};

const ACTION_LABEL: Record<string, string> = {
  check_in: "حضور",
  check_out: "انصراف",
  auto: "تلقائي",
  skipped_cooldown: "تخطّي (انتظار)",
};

export default function FaceAttendanceLogs() {
  const [status, setStatus] = useState<string>("");

  const { data: logs = [], isLoading } = useQuery<FaceLog[]>({
    queryKey: ["face-logs", status],
    queryFn: () => faceApi.logs(status || undefined),
  });

  const fmt = (s: string) => new Date(s).toLocaleString("ar-SA-u-nu-latn", { dateStyle: "short", timeStyle: "medium" });

  return (
    <div className="p-6 space-y-6" data-testid="page-face-logs">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ScrollText className="h-6 w-6 text-primary" /> سجل تعرّف الوجوه
          </h1>
          <p className="text-sm text-muted-foreground mt-1">سجل تدقيق كامل لكل عمليات التعرف الذكي</p>
        </div>
        <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">جميع الحالات</SelectItem>
            <SelectItem value="ok">ناجح فقط</SelectItem>
            <SelectItem value="unknown">غير معروف</SelectItem>
            <SelectItem value="low_confidence">ثقة منخفضة</SelectItem>
            <SelectItem value="spoof">تزوير</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="p-0 overflow-hidden">
        {isLoading ? (
          <p className="text-center text-sm text-muted-foreground py-12">جاري التحميل...</p>
        ) : logs.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-12">لا توجد سجلات</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-right p-3">الوقت</th>
                  <th className="text-right p-3">الموظف</th>
                  <th className="text-right p-3">الكاميرا</th>
                  <th className="text-right p-3">العملية</th>
                  <th className="text-right p-3">الحالة</th>
                  <th className="text-right p-3">الثقة</th>
                  <th className="text-right p-3">الكشف الحي</th>
                  <th className="text-right p-3">سبب</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => {
                  const sb = STATUS_BADGE[l.status] ?? { label: l.status, cls: "", icon: ScrollText };
                  const Icon = sb.icon;
                  return (
                    <tr key={l.id} className="border-t hover:bg-muted/30">
                      <td className="p-3 font-mono text-xs">{fmt(l.createdAt)}</td>
                      <td className="p-3">
                        {l.employeeName ? (
                          <div>
                            <div className="font-medium">{l.employeeName}</div>
                            <div className="text-xs text-muted-foreground">{l.employeeCode}</div>
                          </div>
                        ) : <span className="text-muted-foreground">غير معروف</span>}
                      </td>
                      <td className="p-3">{l.cameraName ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="p-3"><Badge variant="outline">{ACTION_LABEL[l.action ?? ""] ?? l.action ?? "—"}</Badge></td>
                      <td className="p-3">
                        <Badge className={sb.cls} variant="outline">
                          <Icon className="h-3 w-3 mr-1" /> {sb.label}
                        </Badge>
                      </td>
                      <td className="p-3 font-mono">{l.matchedConfidence ? `${(Number(l.matchedConfidence) * 100).toFixed(1)}%` : "—"}</td>
                      <td className="p-3">{l.livenessPassed ? <Badge variant="secondary">✓</Badge> : <Badge variant="outline">—</Badge>}</td>
                      <td className="p-3 text-xs text-muted-foreground">{l.spoofReason ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
