import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Inbox, Clock, CheckCircle2, AlertCircle, Loader2, Send } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const STATUS: Record<string, { label: string; cls: string; icon: any }> = {
  open:        { label: "مفتوح",       cls: "bg-blue-50 text-blue-700 border-blue-200",         icon: Inbox },
  in_progress: { label: "قيد المعالجة", cls: "bg-amber-50 text-amber-800 border-amber-200",      icon: Clock },
  resolved:    { label: "تم الحل",      cls: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
  closed:      { label: "مغلق",         cls: "bg-gray-50 text-gray-700 border-gray-200",         icon: CheckCircle2 },
};
const PRIORITY: Record<string, string> = {
  low: "bg-gray-100 text-gray-700", normal: "bg-blue-100 text-blue-700", high: "bg-rose-100 text-rose-700",
};

export default function SupportInbox() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [filter, setFilter] = useState<string>("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const [reply, setReply]   = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["support-inbox", filter],
    queryFn: async () => {
      const url = filter === "all"
        ? `${API}/api/support-messages`
        : `${API}/api/support-messages?status=${filter}`;
      return (await fetch(url, { headers })).json();
    },
  });
  const messages: any[] = data?.messages ?? [];

  const { data: statsData } = useQuery({
    queryKey: ["support-stats"],
    queryFn: async () => (await fetch(`${API}/api/support-messages/stats`, { headers })).json(),
  });
  const stats = statsData?.stats || {};

  const updateMut = useMutation({
    mutationFn: async (vars: { id: number; status?: string; adminReply?: string }) => {
      const { id, ...rest } = vars;
      const r = await fetch(`${API}/api/support-messages/${id}`, {
        method: "PATCH", headers, body: JSON.stringify(rest),
      });
      if (!r.ok) throw new Error((await r.json())?.error || "فشل التحديث");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "تم التحديث" });
      setReply(""); setOpenId(null);
      qc.invalidateQueries({ queryKey: ["support-inbox"] });
      qc.invalidateQueries({ queryKey: ["support-stats"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const opened = useMemo(() => messages.find(m => m.id === openId), [messages, openId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">صندوق رسائل الدعم</h1>
        <p className="text-sm text-muted-foreground">رسائل واردة من المستخدمين في الشركات</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(["open","in_progress","resolved","closed"] as const).map(k => {
          const S = STATUS[k]; const Icon = S.icon;
          return (
            <Card key={k} className="cursor-pointer hover:border-primary" onClick={() => setFilter(k)}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-lg border ${S.cls}`}><Icon className="h-5 w-5" /></div>
                <div>
                  <p className="text-xs text-muted-foreground">{S.label}</p>
                  <p className="text-2xl font-bold">{stats[k] ?? 0}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">قائمة الرسائل</CardTitle>
            <CardDescription className="text-xs">انقر على رسالة لعرضها والرد عليها</CardDescription>
          </div>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">الكل</SelectItem>
              <SelectItem value="open">مفتوحة</SelectItem>
              <SelectItem value="in_progress">قيد المعالجة</SelectItem>
              <SelectItem value="resolved">تم الحل</SelectItem>
              <SelectItem value="closed">مغلقة</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <div className="p-6 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline ml-2" />جارٍ التحميل…</div>
          ) : messages.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">لا توجد رسائل</div>
          ) : (
            <div className="divide-y">
              {messages.map(m => {
                const S = STATUS[m.status] || STATUS.open;
                const Icon = S.icon;
                return (
                  <button
                    key={m.id}
                    onClick={() => { setOpenId(openId === m.id ? null : m.id); setReply(m.adminReply || ""); }}
                    className="w-full text-right px-5 py-3 hover:bg-muted/40 transition-colors"
                    data-testid={`inbox-row-${m.id}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold truncate">{m.subject}</p>
                          <Badge className={PRIORITY[m.priority] || PRIORITY.normal} variant="outline">{m.priority}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {m.senderName} • {m.companyName} • {new Date(m.createdAt).toLocaleString("ar-SA")}
                        </p>
                      </div>
                      <span className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-medium border px-2 py-0.5 rounded-full ${S.cls}`}>
                        <Icon className="h-3 w-3" />{S.label}
                      </span>
                    </div>

                    {openId === m.id && (
                      <div className="mt-3 space-y-3 bg-muted/30 rounded-lg p-3">
                        <div>
                          <p className="text-[11px] font-bold text-muted-foreground mb-1">نص الرسالة:</p>
                          <p className="text-sm whitespace-pre-wrap">{m.body}</p>
                        </div>
                        <div>
                          <p className="text-[11px] font-bold text-muted-foreground mb-1">الرد:</p>
                          <Textarea
                            value={reply}
                            onChange={e => { e.stopPropagation(); setReply(e.target.value); }}
                            onClick={e => e.stopPropagation()}
                            rows={3}
                            placeholder="اكتب الرد هنا… (سيظهر في إشعارات المستخدم)"
                            data-testid={`reply-input-${m.id}`}
                          />
                        </div>
                        <div className="flex items-center gap-2 flex-wrap" onClick={e => e.stopPropagation()}>
                          <Button size="sm" onClick={() => updateMut.mutate({ id: m.id, adminReply: reply, status: "in_progress" })} data-testid={`btn-reply-${m.id}`}>
                            <Send className="h-3.5 w-3.5 ml-1" /> إرسال الرد
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => updateMut.mutate({ id: m.id, status: "resolved" })}>
                            <CheckCircle2 className="h-3.5 w-3.5 ml-1" /> تم الحل
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => updateMut.mutate({ id: m.id, status: "closed" })}>
                            إغلاق
                          </Button>
                          {m.status !== "open" && (
                            <Button size="sm" variant="ghost" onClick={() => updateMut.mutate({ id: m.id, status: "open" })}>
                              إعادة فتح
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
