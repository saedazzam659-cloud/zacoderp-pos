import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MessageSquare, Send, Loader2, CheckCircle2, Clock, Inbox } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const STATUS_LABEL: Record<string, { label: string; cls: string; icon: any }> = {
  open:        { label: "مفتوح",       cls: "bg-blue-50 text-blue-700 border-blue-200",     icon: Inbox },
  in_progress: { label: "قيد المعالجة", cls: "bg-amber-50 text-amber-800 border-amber-200",  icon: Clock },
  resolved:    { label: "تم الحل",      cls: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
  closed:      { label: "مغلق",         cls: "bg-gray-50 text-gray-700 border-gray-200",     icon: CheckCircle2 },
};

export default function SupportMessageCard() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [subject, setSubject]   = useState("");
  const [body, setBody]         = useState("");
  const [priority, setPriority] = useState("normal");

  const { data: mineData } = useQuery({
    queryKey: ["support-mine"],
    queryFn: async () => (await fetch(`${API}/api/support-messages/mine`, { headers })).json(),
  });
  const mine: any[] = mineData?.messages ?? [];

  const sendMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/support-messages`, {
        method: "POST", headers,
        body: JSON.stringify({ subject, body, priority }),
      });
      if (!r.ok) throw new Error((await r.json())?.error || "فشل الإرسال");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "تم إرسال رسالتك", description: "سيتواصل معك فريق الدعم قريباً." });
      setSubject(""); setBody(""); setPriority("normal");
      qc.invalidateQueries({ queryKey: ["support-mine"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message || "تعذر الإرسال", variant: "destructive" }),
  });

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <MessageSquare className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-base">إرسال رسالة للدعم الفني</CardTitle>
            <CardDescription className="text-xs">اكتب مشكلتك أو اقتراحك وسيصل مباشرة إلى السوبر أدمن</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Input
            placeholder="موضوع الرسالة"
            value={subject}
            maxLength={200}
            onChange={e => setSubject(e.target.value)}
            className="sm:col-span-2"
            data-testid="input-support-subject"
          />
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger data-testid="select-support-priority"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="low">عادية</SelectItem>
              <SelectItem value="normal">متوسطة</SelectItem>
              <SelectItem value="high">عالية</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Textarea
          placeholder="اشرح المشكلة أو الاقتراح بالتفصيل…"
          value={body}
          maxLength={5000}
          onChange={e => setBody(e.target.value)}
          rows={4}
          data-testid="input-support-body"
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">{body.length}/5000</span>
          <Button
            onClick={() => sendMut.mutate()}
            disabled={sendMut.isPending || !subject.trim() || !body.trim()}
            data-testid="button-support-send"
          >
            {sendMut.isPending
              ? <><Loader2 className="h-4 w-4 ml-2 animate-spin" /> جارٍ الإرسال…</>
              : <><Send className="h-4 w-4 ml-2" /> إرسال</>}
          </Button>
        </div>

        {mine.length > 0 && (
          <div className="pt-3 border-t">
            <p className="text-xs font-semibold text-muted-foreground mb-2">رسائلك السابقة</p>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {mine.slice(0, 10).map(m => {
                const s = STATUS_LABEL[m.status] || STATUS_LABEL.open;
                const Icon = s.icon;
                return (
                  <div key={m.id} className="border rounded-lg p-3 bg-muted/30" data-testid={`support-msg-${m.id}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold truncate">{m.subject}</p>
                        <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{m.body}</p>
                      </div>
                      <span className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-medium border px-2 py-0.5 rounded-full ${s.cls}`}>
                        <Icon className="h-3 w-3" />{s.label}
                      </span>
                    </div>
                    {m.adminReply && (
                      <div className="mt-2 p-2 rounded-md bg-emerald-50 border border-emerald-200">
                        <p className="text-[10px] font-bold text-emerald-700 mb-0.5">رد الإدارة:</p>
                        <p className="text-xs text-emerald-900 whitespace-pre-wrap">{m.adminReply}</p>
                      </div>
                    )}
                    <p className="text-[10px] text-muted-foreground mt-1.5">
                      {new Date(m.createdAt).toLocaleString("ar-SA")}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
