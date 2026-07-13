// Send tools for a CLOUD-archived document file:
//   • Email  — the SERVER attaches the file bytes and mails them
//              (POST /api/document-archives/:id/email).
//   • WhatsApp — wa.me cannot attach files, so we mint a signed short-lived
//                share link (POST /:id/share-link) and prefill a tidy Arabic
//                message containing it.
// Used from the archive dialog rows AND the split-screen preview panel.

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Mail, MessageCircle, Loader2, Send } from "lucide-react";
import { openWhatsApp, buildDocWhatsAppText } from "@/lib/whatsapp";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Props {
  fileId: number;
  filename: string;
  token: string | null;
  companyName?: string | null;
  /** "row" = compact 7×7 ghost icons (dialog list); "toolbar" = labelled buttons (panel). */
  variant?: "row" | "toolbar";
}

export function ArchiveSendButtons({ fileId, filename, token, companyName, variant = "row" }: Props) {
  const { toast } = useToast();

  // ─── Email state ──────────────────────────────────────────────────────────
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailMsg, setEmailMsg] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);

  // ─── WhatsApp state ───────────────────────────────────────────────────────
  const [waOpen, setWaOpen] = useState(false);
  const [waPhone, setWaPhone] = useState("");
  const [waNote, setWaNote] = useState("");
  const [preparingWa, setPreparingWa] = useState(false);

  async function sendEmail() {
    const to = emailTo.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      toast({ title: "أدخل بريداً إلكترونياً صحيحاً", variant: "destructive" });
      return;
    }
    if (!token) { toast({ title: "الجلسة منتهية", variant: "destructive" }); return; }
    setSendingEmail(true);
    try {
      const r = await fetch(`${API}/api/document-archives/${fileId}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to, message: waTrim(emailMsg) || undefined }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error ?? "تعذّر إرسال البريد");
      toast({ title: "تم الإرسال", description: `أُرسل «${filename}» إلى ${to}` });
      setEmailOpen(false);
      setEmailTo("");
      setEmailMsg("");
    } catch (e: any) {
      toast({ title: "تعذّر إرسال البريد", description: e?.message ?? String(e), variant: "destructive" });
    } finally { setSendingEmail(false); }
  }

  async function shareWhatsApp() {
    if (!token) { toast({ title: "الجلسة منتهية", variant: "destructive" }); return; }
    setPreparingWa(true);
    try {
      const r = await fetch(`${API}/api/document-archives/${fileId}/share-link`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error ?? "تعذّر إنشاء رابط المشاركة");
      // Build the absolute URL from OUR origin — works on dev preview and on
      // the production domain alike (never guessed server-side).
      const link = `${window.location.origin}${API}${body.path}`;
      const msg = buildDocWhatsAppText({
        companyName,
        title: "مستند مؤرشف",
        docNo: filename,
        note: waTrim(waNote) || null,
        link,
      });
      openWhatsApp(msg, waTrim(waPhone) || null);
      setWaOpen(false);
      setWaNote("");
    } catch (e: any) {
      toast({ title: "تعذّر المشاركة عبر واتساب", description: e?.message ?? String(e), variant: "destructive" });
    } finally { setPreparingWa(false); }
  }

  const compact = variant === "row";

  return (
    <>
      {/* ── Email ──────────────────────────────────────────────────────── */}
      <Popover open={emailOpen} onOpenChange={setEmailOpen}>
        <PopoverTrigger asChild>
          {compact ? (
            <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" title="إرسال بالبريد الإلكتروني">
              <Mail className="h-3.5 w-3.5 text-sky-600" />
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
              <Mail className="h-3.5 w-3.5 text-sky-600" />بريد
            </Button>
          )}
        </PopoverTrigger>
        <PopoverContent dir="rtl" className="w-80 space-y-2" align="end">
          <div className="text-sm font-semibold flex items-center gap-1.5">
            <Mail className="h-4 w-4 text-sky-600" />إرسال «{filename}» بالبريد
          </div>
          <div className="space-y-1">
            <Label className="text-xs">البريد الإلكتروني للمستلم *</Label>
            <Input
              dir="ltr"
              type="email"
              placeholder="name@example.com"
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">رسالة (اختياري)</Label>
            <Textarea
              rows={2}
              value={emailMsg}
              onChange={(e) => setEmailMsg(e.target.value)}
              className="text-sm"
              placeholder="نص يظهر في متن الرسالة…"
            />
          </div>
          <Button type="button" size="sm" className="w-full gap-1.5" onClick={sendEmail} disabled={sendingEmail}>
            {sendingEmail ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {sendingEmail ? "جاري الإرسال…" : "إرسال — الملف يُرفق تلقائياً"}
          </Button>
        </PopoverContent>
      </Popover>

      {/* ── WhatsApp ───────────────────────────────────────────────────── */}
      <Popover open={waOpen} onOpenChange={setWaOpen}>
        <PopoverTrigger asChild>
          {compact ? (
            <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" title="مشاركة عبر واتساب">
              <MessageCircle className="h-3.5 w-3.5 text-emerald-600" />
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
              <MessageCircle className="h-3.5 w-3.5 text-emerald-600" />واتساب
            </Button>
          )}
        </PopoverTrigger>
        <PopoverContent dir="rtl" className="w-80 space-y-2" align="end">
          <div className="text-sm font-semibold flex items-center gap-1.5">
            <MessageCircle className="h-4 w-4 text-emerald-600" />مشاركة «{filename}» عبر واتساب
          </div>
          <div className="space-y-1">
            <Label className="text-xs">رقم الجوال (اختياري — اتركه فارغاً لاختيار جهة الاتصال)</Label>
            <Input
              dir="ltr"
              inputMode="tel"
              placeholder="9665xxxxxxxx"
              value={waPhone}
              onChange={(e) => setWaPhone(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">ملاحظة (اختياري)</Label>
            <Textarea
              rows={2}
              value={waNote}
              onChange={(e) => setWaNote(e.target.value)}
              className="text-sm"
              placeholder="نص إضافي يظهر في الرسالة…"
            />
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            سيُرسَل رابط تنزيل آمن صالح لمدة 7 أيام (واتساب لا يسمح بإرفاق الملف مباشرة من المتصفح).
          </p>
          <Button type="button" size="sm" className="w-full gap-1.5 bg-emerald-600 hover:bg-emerald-700" onClick={shareWhatsApp} disabled={preparingWa}>
            {preparingWa ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
            {preparingWa ? "جاري تجهيز الرابط…" : "فتح واتساب"}
          </Button>
        </PopoverContent>
      </Popover>
    </>
  );
}

function waTrim(s: string): string {
  return s.trim();
}
