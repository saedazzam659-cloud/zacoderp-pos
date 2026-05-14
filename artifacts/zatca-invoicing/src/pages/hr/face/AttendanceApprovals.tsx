import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { faceApi, type ApprovalRow } from "@/lib/faceAttendanceApi";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Loader2, ShieldCheck, ShieldX, MapPin, ExternalLink, AlertTriangle, Clock,
} from "lucide-react";

const STATUS_BADGE: Record<string, { ar: string; cls: string }> = {
  ok:               { ar: "داخل النطاق", cls: "bg-emerald-100 text-emerald-700 border-emerald-300" },
  out_of_geofence:  { ar: "خارج النطاق", cls: "bg-amber-100 text-amber-700 border-amber-300" },
  low_accuracy:     { ar: "دقة GPS منخفضة", cls: "bg-amber-100 text-amber-700 border-amber-300" },
  mock_suspected:   { ar: "موقع مزيّف", cls: "bg-rose-100 text-rose-700 border-rose-300" },
  denied:           { ar: "إذن GPS مرفوض", cls: "bg-rose-100 text-rose-700 border-rose-300" },
  no_gps:           { ar: "بدون موقع عمل", cls: "bg-slate-100 text-slate-700 border-slate-300" },
};

export default function AttendanceApprovals() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"pending" | "approved" | "rejected">("pending");
  const { data: rows = [], isLoading } = useQuery<ApprovalRow[]>({
    queryKey: ["face-approvals", tab],
    queryFn: () => faceApi.approvals(tab),
  });

  // Reject dialog (we collect a note for the audit trail).
  const [rejectTarget, setRejectTarget] = useState<ApprovalRow | null>(null);
  const [note, setNote] = useState("");

  const decide = useMutation({
    mutationFn: ({ id, decision, note }: { id: number; decision: "approved" | "rejected"; note?: string }) =>
      faceApi.decideApproval(id, decision, note),
    onSuccess: (_d, v) => {
      toast({ title: v.decision === "approved" ? "تمت الموافقة" : "تم الرفض" });
      qc.invalidateQueries({ queryKey: ["face-approvals"] });
      setRejectTarget(null);
      setNote("");
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message ?? "", variant: "destructive" }),
  });

  const renderLocCell = (
    label: string,
    time: string | null,
    lat: string | null,
    lng: string | null,
    distance: string | null,
    status: string | null,
  ) => {
    if (!time) return null;
    const badge = status ? STATUS_BADGE[status] : null;
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" /> {label} — {time.slice(0, 5)}
        </div>
        <div className="flex items-center flex-wrap gap-2">
          {badge && <Badge variant="outline" className={badge.cls}>{badge.ar}</Badge>}
          {distance && (
            <Badge variant="outline" className="text-xs">
              {Math.round(Number(distance))} م من الموقع
            </Badge>
          )}
          {lat && lng && (
            <a
              href={`https://www.google.com/maps?q=${lat},${lng}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary hover:underline inline-flex items-center gap-1"
            >
              <MapPin className="h-3 w-3" /> عرض على الخريطة <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="p-6 space-y-5" data-testid="page-approvals">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-amber-600" /> موافقات الحضور
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          سجلات الحضور التي تم تسجيلها خارج النطاق المسموح أو دون موقع GPS صالح، تحتاج لمراجعة المدير.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="pending" data-testid="tab-pending">قيد الانتظار</TabsTrigger>
          <TabsTrigger value="approved" data-testid="tab-approved">مقبولة</TabsTrigger>
          <TabsTrigger value="rejected" data-testid="tab-rejected">مرفوضة</TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : rows.length === 0 ? (
        <Card className="p-12 text-center">
          <ShieldCheck className="h-12 w-12 mx-auto text-emerald-500 mb-3" />
          <h3 className="font-semibold">لا توجد سجلات {tab === "pending" ? "بانتظار الموافقة" : tab === "approved" ? "مقبولة" : "مرفوضة"}</h3>
          <p className="text-sm text-muted-foreground mt-1">كل شيء على ما يرام 🎉</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <Card key={r.id} className="p-4" data-testid={`approval-row-${r.id}`}>
              <div className="grid lg:grid-cols-[260px,1fr,auto] gap-4">
                <div className="flex items-start gap-3">
                  {r.employeePhotoUrl ? (
                    <img src={r.employeePhotoUrl} alt="" className="h-12 w-12 rounded-full object-cover" />
                  ) : (
                    <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center font-bold">
                      {(r.employeeName ?? "؟").slice(0, 1)}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{r.employeeName ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{r.employeeCode}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{r.date}</div>
                    {r.workLat && r.workLng ? (
                      <div className="text-[11px] text-muted-foreground mt-1">
                        موقع العمل: نطاق {r.workRadiusM ?? 200} م
                      </div>
                    ) : (
                      <div className="text-[11px] text-amber-600 mt-1 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" /> لا يوجد موقع عمل مُهيّأ
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-3 text-sm">
                  {renderLocCell("حضور", r.checkIn, r.checkInLat, r.checkInLng, r.checkInDistanceM, r.checkInLocStatus)}
                  {renderLocCell("انصراف", r.checkOut, r.checkOutLat, r.checkOutLng, r.checkOutDistanceM, r.checkOutLocStatus)}
                  {r.approvalNote && (
                    <div className="text-xs bg-muted/50 rounded p-2 border">
                      <span className="text-muted-foreground">ملاحظة:</span> {r.approvalNote}
                    </div>
                  )}
                </div>

                <div className="flex lg:flex-col gap-2 items-stretch justify-end">
                  {tab === "pending" ? (
                    <>
                      <Button
                        size="sm"
                        className="gap-1 bg-emerald-600 hover:bg-emerald-700"
                        onClick={() => decide.mutate({ id: r.id, decision: "approved" })}
                        disabled={decide.isPending}
                        data-testid={`button-approve-${r.id}`}
                      >
                        <ShieldCheck className="h-4 w-4" /> اعتماد
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1 border-rose-300 text-rose-600 hover:bg-rose-50"
                        onClick={() => { setRejectTarget(r); setNote(""); }}
                        disabled={decide.isPending}
                        data-testid={`button-reject-${r.id}`}
                      >
                        <ShieldX className="h-4 w-4" /> رفض
                      </Button>
                    </>
                  ) : (
                    <Badge variant="outline" className={
                      tab === "approved"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                        : "bg-rose-50 text-rose-700 border-rose-300"
                    }>
                      {tab === "approved" ? "تم الاعتماد" : "تم الرفض"}
                    </Badge>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!rejectTarget} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>رفض السجل</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-sm">
              {rejectTarget?.employeeName} — {rejectTarget?.date}
            </div>
            <div>
              <label className="text-sm text-muted-foreground mb-1 block">سبب الرفض (اختياري)</label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="اذكر سبب رفض السجل ليطّلع عليه الموظف لاحقاً..."
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>إلغاء</Button>
            <Button
              variant="destructive"
              onClick={() => rejectTarget && decide.mutate({ id: rejectTarget.id, decision: "rejected", note })}
              disabled={decide.isPending}
            >
              تأكيد الرفض
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
