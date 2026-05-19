import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { userTrackingApi, getCurrentPosition } from "@/lib/userTrackingApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { MapPin, LogIn, LogOut, Loader2 } from "lucide-react";

function hasPerm(user: any, key: string): boolean {
  if (!user) return false;
  if (user.role === "admin" || user.role === "superadmin") return true;
  const mp = user.menuPermissions || user.menu_permissions || {};
  return !!mp[key];
}

function fmtElapsed(startIso: string): string {
  const ms = Date.now() - new Date(startIso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} د`;
  const h = Math.floor(mins / 60);
  return `${h} س ${mins % 60} د`;
}

export default function CheckInWidget() {
  const { user } = useAuth();
  const cid = user?.companyId ?? undefined;
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The "تسجيل زيارة" button is now gated by the field-service visits
  // permission (الخدمة الميدانية ← الزيارات) per the user's request — this
  // matches the menu label the admin sees in the permission grid and removes
  // the confusion with the separate `user_tracking` (live GPS) module.
  const canUse = hasPerm(user, "field_service_visits");

  const { data: active } = useQuery({
    queryKey: ["user-tracking-active", cid],
    queryFn: () => userTrackingApi.active(cid),
    enabled: canUse && !!cid,
    refetchInterval: 60000,
  });

  const checkinMut = useMutation({
    mutationFn: async () => {
      const pos = await getCurrentPosition();
      return userTrackingApi.checkin({ lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, purpose: purpose || undefined, notes: notes || undefined }, cid);
    },
    onSuccess: () => {
      setOpen(false); setPurpose(""); setNotes(""); setError(null);
      qc.invalidateQueries({ queryKey: ["user-tracking-active"] });
      qc.invalidateQueries({ queryKey: ["user-tracking-visits"] });
    },
    onError: (e: any) => setError(e?.message || "فشل تسجيل الدخول"),
  });

  const checkoutMut = useMutation({
    mutationFn: async () => {
      if (!active) throw new Error("لا توجد زيارة نشطة");
      const pos = await getCurrentPosition();
      return userTrackingApi.checkout(active.id, { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy }, cid);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-tracking-active"] });
      qc.invalidateQueries({ queryKey: ["user-tracking-visits"] });
      qc.invalidateQueries({ queryKey: ["user-tracking-dashboard"] });
    },
    onError: (e: any) => setError(e?.message || "فشل تسجيل الخروج"),
  });

  if (!canUse || !cid) return null;

  if (active) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="gap-2 border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
        onClick={() => { setError(null); setBusy(true); checkoutMut.mutate(undefined, { onSettled: () => setBusy(false) }); }}
        disabled={busy || checkoutMut.isPending}
        title={active.checkinPlace || active.checkinAddress || "زيارة نشطة"}
      >
        {checkoutMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
        <span className="hidden sm:inline">إنهاء الزيارة</span>
        <span className="text-xs opacity-70">({fmtElapsed(active.checkinAt)})</span>
      </Button>
    );
  }

  return (
    <>
      <Button size="sm" variant="outline" className="gap-2 border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100" onClick={() => { setError(null); setOpen(true); }}>
        <MapPin className="h-4 w-4" />
        <span className="hidden sm:inline">تسجيل زيارة</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><MapPin className="h-5 w-5" /> تسجيل زيارة جديدة</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>سبب الزيارة / اسم المكان</Label>
              <Input value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="زيارة عميل، اجتماع، صيانة ..." />
            </div>
            <div>
              <Label>ملاحظات (اختياري)</Label>
              <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="ملاحظات إضافية" />
            </div>
            <p className="text-xs text-muted-foreground">سيُطلب منك الإذن بمشاركة موقعك الحالي.</p>
            {error && <div className="rounded-md bg-rose-50 p-2 text-sm text-rose-700">{error}</div>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={checkinMut.isPending}>إلغاء</Button>
            <Button
              onClick={() => checkinMut.mutate()}
              disabled={checkinMut.isPending}
              className="gap-2"
            >
              {checkinMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              تسجيل الدخول
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
