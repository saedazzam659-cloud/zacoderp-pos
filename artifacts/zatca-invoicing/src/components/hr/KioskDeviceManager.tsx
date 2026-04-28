import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { faceApi, type KioskTokenSummary, type KioskTokenCreated } from "@/lib/faceAttendanceApi";
import {
  Smartphone, Plus, Trash2, Copy, Check, AlertTriangle, Link as LinkIcon, Loader2,
} from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Admin-only UI for managing kiosk pairing tokens.
 *
 * Each token represents one paired tablet/device that calls the
 * face-attendance APIs without a user session. The full plaintext
 * token is shown ONCE at creation time — afterwards we only have its
 * hash, so the admin must save the pairing URL or revoke and re-issue.
 */
export function KioskDeviceManager({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<KioskTokenCreated | null>(null);
  const [copied, setCopied] = useState<"url" | "token" | null>(null);

  const { data: tokens = [], isLoading } = useQuery<KioskTokenSummary[]>({
    queryKey: ["kiosk-tokens"],
    queryFn: () => faceApi.listKioskTokens(),
    enabled: open,
  });

  const createMut = useMutation({
    mutationFn: (lbl: string) => faceApi.createKioskToken(lbl),
    onSuccess: (res) => {
      setCreated(res);
      setLabel("");
      qc.invalidateQueries({ queryKey: ["kiosk-tokens"] });
    },
    onError: (e: any) =>
      toast({ title: "تعذّر إنشاء الرمز", description: e?.message ?? "", variant: "destructive" }),
  });

  const revokeMut = useMutation({
    mutationFn: (id: number) => faceApi.revokeKioskToken(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kiosk-tokens"] });
      toast({ title: "تم إلغاء ربط الجهاز" });
    },
    onError: (e: any) =>
      toast({ title: "تعذّر الإلغاء", description: e?.message ?? "", variant: "destructive" }),
  });

  const copyText = async (text: string, kind: "url" | "token") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast({ title: "تعذّر النسخ", variant: "destructive" });
    }
  };

  // The pairing URL from the API is path-only; turn it into a full URL
  // using the current origin so the admin can text/email it to the device.
  const fullPairUrl = (path: string) => `${window.location.origin}${path}`;

  const fmtDate = (s: string | null) => {
    if (!s) return "—";
    const d = new Date(s);
    return `${d.toLocaleDateString("ar-SA")} ${d.toTimeString().slice(0, 5)}`;
  };

  const active = tokens.filter((t) => !t.revokedAt);
  const revoked = tokens.filter((t) => t.revokedAt);

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setCreated(null); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="dialog-kiosk-devices">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5" /> أجهزة الكشك المربوطة
          </DialogTitle>
          <DialogDescription>
            أجهزة التابلت/الكشك التي تعمل في مدخل المكتب وتستخدم التعرف على الوجه دون الحاجة لتسجيل دخول مستخدم.
          </DialogDescription>
        </DialogHeader>

        {/* CREATE */}
        {!created && (
          <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
            <div className="font-medium flex items-center gap-2">
              <Plus className="h-4 w-4" /> ربط جهاز جديد
            </div>
            <div className="grid sm:grid-cols-[1fr_auto] gap-2 items-end">
              <div>
                <Label htmlFor="kiosk-label">اسم الجهاز</Label>
                <Input
                  id="kiosk-label"
                  placeholder="مثال: تابلت المدخل الرئيسي"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  data-testid="input-kiosk-label"
                />
              </div>
              <Button
                onClick={() => createMut.mutate(label.trim())}
                disabled={!label.trim() || createMut.isPending}
                data-testid="button-create-kiosk-token"
              >
                {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                إنشاء رمز ربط
              </Button>
            </div>
          </div>
        )}

        {/* CREATED — show once */}
        {created && (
          <div className="rounded-lg border-2 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 p-4 space-y-3" data-testid="kiosk-created-box">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm">
                <div className="font-bold mb-1">احفظ هذا الرابط الآن — لن يظهر مرة أخرى!</div>
                <p className="text-muted-foreground">
                  افتح الرابط التالي على جهاز التابلت/الكشك لربطه. بعد فتحه ستعمل صفحة الكشك تلقائياً دون الحاجة لتسجيل دخول.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">رابط الربط (افتحه على الجهاز)</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={fullPairUrl(created.pairUrl)}
                  className="font-mono text-xs"
                  data-testid="input-pair-url"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button variant="outline" onClick={() => copyText(fullPairUrl(created.pairUrl), "url")} data-testid="button-copy-pair-url">
                  {copied === "url" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
                <Button variant="outline" asChild>
                  <a href={fullPairUrl(created.pairUrl)} target="_blank" rel="noopener noreferrer">
                    <LinkIcon className="h-4 w-4" />
                  </a>
                </Button>
              </div>
            </div>

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">أو انسخ الرمز يدوياً</summary>
              <div className="flex gap-2 mt-2">
                <Input
                  readOnly
                  value={created.token}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button variant="outline" onClick={() => copyText(created.token, "token")}>
                  {copied === "token" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </details>

            <Button variant="secondary" className="w-full" onClick={() => setCreated(null)} data-testid="button-dismiss-created">
              تم الحفظ — إغلاق
            </Button>
          </div>
        )}

        <Separator />

        {/* LIST */}
        <div className="space-y-2">
          <div className="font-medium flex items-center justify-between">
            <span>الأجهزة النشطة ({active.length})</span>
          </div>
          {isLoading ? (
            <div className="text-center py-6 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline" /></div>
          ) : active.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">لا توجد أجهزة مربوطة. أنشئ رمز ربط أعلاه.</p>
          ) : (
            <div className="space-y-2">
              {active.map((t) => (
                <div key={t.id} className="rounded-lg border p-3 flex items-center justify-between gap-3" data-testid={`kiosk-row-${t.id}`}>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium flex items-center gap-2">
                      <Smartphone className="h-4 w-4 text-emerald-600" />
                      {t.label}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-1">
                      <span>أُنشئ: {fmtDate(t.createdAt)}</span>
                      {t.createdByName && <span>بواسطة: {t.createdByName}</span>}
                      <span>
                        آخر استخدام: {t.lastUsedAt ? fmtDate(t.lastUsedAt) : "لم يُستخدم بعد"}
                        {t.lastUsedIp ? ` (${t.lastUsedIp})` : ""}
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => {
                      if (confirm(`هل تريد إلغاء ربط "${t.label}"؟ سيتوقف الجهاز عن العمل فوراً.`)) {
                        revokeMut.mutate(t.id);
                      }
                    }}
                    disabled={revokeMut.isPending}
                    data-testid={`button-revoke-${t.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {revoked.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground py-1">الأجهزة المُلغاة ({revoked.length})</summary>
            <div className="space-y-2 mt-2">
              {revoked.map((t) => (
                <div key={t.id} className="rounded-lg border bg-muted/30 p-2 flex items-center justify-between text-xs">
                  <div>
                    <span className="font-medium">{t.label}</span>
                    <Badge variant="outline" className="ms-2">مُلغى</Badge>
                  </div>
                  <span className="text-muted-foreground">{fmtDate(t.revokedAt)}</span>
                </div>
              ))}
            </div>
          </details>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>إغلاق</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
