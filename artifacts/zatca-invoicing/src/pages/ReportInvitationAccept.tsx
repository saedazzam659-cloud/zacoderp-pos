import { useEffect, useState } from "react";
import { useRoute, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, AlertTriangle, Mail, ShieldCheck } from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface InvitationView {
  email: string;
  invitedByUsername: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  status: "pending" | "accepted" | "expired" | "revoked" | "already_member";
}

const fmtDateTime = (iso: string | null) => {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("ar-SA"); }
  catch { return iso; }
};

export default function ReportInvitationAccept() {
  const [, params] = useRoute("/reports-invitation/:token");
  const token = params?.token ?? "";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<InvitationView | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/reports-invitations/${encodeURIComponent(token)}`);
        const body = await r.json().catch(() => ({}));
        if (!active) return;
        if (!r.ok) {
          setError(body.error ?? "تعذر جلب الدعوة");
        } else {
          setInvite(body.invitation);
          if (body.invitation?.status === "accepted") setAccepted(true);
        }
      } catch (e: any) {
        if (active) setError(e?.message ?? "تعذر الاتصال");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [token]);

  async function accept() {
    setAccepting(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/reports-invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body.error ?? "تعذر قبول الدعوة");
      } else {
        setInvite(body.invitation);
        setAccepted(true);
      }
    } catch (e: any) {
      setError(e?.message ?? "تعذر الاتصال");
    } finally {
      setAccepting(false);
    }
  }

  return (
    <div dir="rtl" className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-sm border overflow-hidden">
        <div className="p-6 border-b bg-gradient-to-l from-emerald-50 to-white flex items-center gap-3">
          <div className="h-12 w-12 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center">
            <Mail className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-bold">دعوة لاستقبال التقارير الدورية</h1>
            <p className="text-xs text-muted-foreground">نظام الفاتورة الإلكترونية السعودية</p>
          </div>
        </div>

        <div className="p-6 space-y-5">
          {loading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin ml-2" /> جاري التحقق من الدعوة…
            </div>
          )}

          {!loading && error && !invite && (
            <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-sm flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">تعذر فتح الدعوة</div>
                <div className="text-xs mt-1">{error}</div>
              </div>
            </div>
          )}

          {!loading && invite && (
            <>
              <div className="text-sm space-y-2 bg-slate-50 border rounded-lg p-4">
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">البريد:</span>
                  <span className="font-semibold" dir="ltr">{invite.email}</span>
                </div>
                {invite.invitedByUsername && (
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">من:</span>
                    <span className="font-semibold">{invite.invitedByUsername}</span>
                  </div>
                )}
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">صالحة حتى:</span>
                  <span>{fmtDateTime(invite.expiresAt)}</span>
                </div>
              </div>

              {invite.status === "expired" && (
                <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm flex items-start gap-2">
                  <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">انتهت صلاحية الدعوة</div>
                    <div className="text-xs mt-1">اطلب من المشرف إرسال دعوة جديدة.</div>
                  </div>
                </div>
              )}

              {invite.status === "revoked" && (
                <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-sm flex items-start gap-2">
                  <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">تم إلغاء هذه الدعوة</div>
                    <div className="text-xs mt-1">لم يعد الرابط صالحاً للاستخدام.</div>
                  </div>
                </div>
              )}

              {(accepted || invite.status === "accepted" || invite.status === "already_member") && (
                <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm flex items-start gap-2">
                  <CheckCircle2 className="h-5 w-5 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">تمت الإضافة بنجاح</div>
                    <div className="text-xs mt-1">
                      ستصلك التقارير الدورية على هذا البريد حسب جدولة المشرف العام.
                    </div>
                  </div>
                </div>
              )}

              {invite.status === "pending" && !accepted && (
                <>
                  <div className="text-sm text-slate-700 leading-relaxed">
                    بقبول الدعوة، سيُضاف هذا البريد إلى قائمة مستلمي التقارير الدورية،
                    وستصلك خلاصات أسبوعية أو شهرية بصيغة CSV حسب الجدولة الحالية.
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={accept} disabled={accepting} className="flex-1" data-testid="accept-invitation">
                      {accepting
                        ? <><Loader2 className="h-4 w-4 animate-spin ml-2" /> جاري التأكيد…</>
                        : <><ShieldCheck className="h-4 w-4 ml-2" /> قبول الانضمام</>}
                    </Button>
                  </div>
                </>
              )}

              {error && (
                <div className="p-3 rounded bg-rose-50 border border-rose-200 text-rose-800 text-xs">
                  {error}
                </div>
              )}
            </>
          )}

          <div className="pt-3 text-center text-xs text-muted-foreground">
            <Link href="/login" className="hover:underline">العودة إلى الصفحة الرئيسية</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
