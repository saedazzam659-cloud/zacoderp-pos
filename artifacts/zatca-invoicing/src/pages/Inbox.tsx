import { useEffect, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "wouter";
import { Inbox as InboxIcon, Paperclip, MailOpen, Mail, Trash2, RefreshCcw, Sparkles, FileText } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type ListItem = {
  id: number;
  kind: string;
  subject: string;
  attachmentFilename: string | null;
  attachmentMime: string | null;
  hasAttachment: boolean;
  createdAt: string;
  readAt: string | null;
  isRead: boolean;
};
type FullMessage = ListItem & {
  body: string;
  attachmentUrl: string | null;
  recipientUserId: number | null;
  notificationId: number | null;
};

export default function Inbox() {
  const { token } = useAuth();
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const headers = { Authorization: `Bearer ${token}` };

  // Open ?id=NN if provided (e.g. from notification link).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const idStr = params.get("id");
    if (idStr) {
      const n = Number(idStr);
      if (Number.isFinite(n) && n > 0) setSelectedId(n);
    }
  }, []);

  const { data: listData, isLoading: listLoading, refetch } = useQuery({
    queryKey: ["inbox-list"],
    queryFn: async () => (await fetch(`${API}/api/inbox`, { headers })).json(),
    enabled: !!token,
    refetchInterval: 60_000,
  });
  const items: ListItem[] = listData?.messages ?? [];

  const { data: detailData } = useQuery({
    queryKey: ["inbox-message", selectedId],
    queryFn: async () => (await fetch(`${API}/api/inbox/${selectedId}`, { headers })).json(),
    enabled: !!token && !!selectedId,
  });
  const message: FullMessage | undefined = detailData?.message;

  const markRead = useMutation({
    mutationFn: async (id: number) =>
      fetch(`${API}/api/inbox/${id}/read`, { method: "POST", headers }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inbox-list"] });
      qc.invalidateQueries({ queryKey: ["notif-unread"] });
    },
  });
  const markAllRead = useMutation({
    mutationFn: async () =>
      fetch(`${API}/api/inbox/read-all`, { method: "POST", headers }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inbox-list"] });
      qc.invalidateQueries({ queryKey: ["notif-unread"] });
    },
  });
  const remove = useMutation({
    mutationFn: async (id: number) =>
      fetch(`${API}/api/inbox/${id}`, { method: "DELETE", headers }),
    onSuccess: () => {
      setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["inbox-list"] });
    },
  });

  // When message is opened, mark it read once.
  useEffect(() => {
    if (message && !message.isRead) markRead.mutate(message.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message?.id, message?.isRead]);

  const isRtl = i18n.language === "ar";
  const dir = isRtl ? "rtl" : "ltr";

  const downloadHref = message?.attachmentUrl
    ? `${API}/api/inbox/${message.id}/attachment`
    : null;

  return (
    <div dir={dir} className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <InboxIcon className="h-5 w-5 text-violet-600" />
          <h1 className="text-xl md:text-2xl font-bold">{t("inbox.title", "صندوق الوارد")}</h1>
          <Badge variant="secondary" className="text-xs">{items.length}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} title={t("inbox.refresh", "تحديث")}>
            <RefreshCcw className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => markAllRead.mutate()} disabled={markAllRead.isPending}>
            <MailOpen className="h-4 w-4 me-1" />
            {t("inbox.markAllRead", "اعتبر الكل مقروءاً")}
          </Button>
          <Link href="/ai-reports">
            <Button size="sm" className="bg-violet-600 hover:bg-violet-700">
              <Sparkles className="h-4 w-4 me-1" />
              {t("nav.aiReports", "تقارير بالذكاء الاصطناعي")}
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        {/* List */}
        <Card className="md:col-span-5 lg:col-span-4">
          <CardContent className="p-0">
            <div className="max-h-[70vh] overflow-y-auto divide-y">
              {listLoading ? (
                <div className="p-6 text-center text-muted-foreground text-sm">{t("common.loading", "جارٍ التحميل...")}</div>
              ) : items.length === 0 ? (
                <div className="p-10 text-center text-muted-foreground text-sm">
                  <InboxIcon className="h-10 w-10 mx-auto mb-2 opacity-30" />
                  {t("inbox.empty", "لا توجد رسائل في صندوق الوارد")}
                </div>
              ) : items.map(it => {
                const sel = selectedId === it.id;
                return (
                  <button
                    key={it.id}
                    onClick={() => setSelectedId(it.id)}
                    className={`w-full text-start px-3 py-3 hover:bg-accent transition-colors flex items-start gap-2 ${
                      sel ? "bg-violet-50" : ""
                    } ${!it.isRead ? "bg-violet-50/50" : ""}`}
                  >
                    {it.isRead ? (
                      <MailOpen className="h-4 w-4 text-muted-foreground mt-1 shrink-0" />
                    ) : (
                      <Mail className="h-4 w-4 text-violet-600 mt-1 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className={`text-sm leading-snug truncate ${!it.isRead ? "font-bold" : ""}`}>{it.subject}</p>
                        {it.hasAttachment && <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {new Date(it.createdAt).toLocaleString(isRtl ? "ar-SA" : "en-US")}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Detail */}
        <Card className="md:col-span-7 lg:col-span-8">
          <CardContent className="p-4 md:p-6">
            {!selectedId ? (
              <div className="py-16 text-center text-muted-foreground">
                <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>{t("inbox.selectToRead", "اختر رسالة لقراءتها")}</p>
              </div>
            ) : !message ? (
              <div className="py-16 text-center text-muted-foreground">{t("common.loading", "جارٍ التحميل...")}</div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <h2 className="text-lg md:text-xl font-semibold leading-tight">{message.subject}</h2>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(message.createdAt).toLocaleString(isRtl ? "ar-SA" : "en-US")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {downloadHref && (
                      <a href={downloadHref} target="_blank" rel="noreferrer" download={message.attachmentFilename ?? undefined}>
                        <Button size="sm">
                          <Paperclip className="h-4 w-4 me-1" />
                          {t("inbox.download", "تحميل المرفق")}
                          {message.attachmentFilename ? <span className="ms-1 opacity-80">({message.attachmentFilename})</span> : null}
                        </Button>
                      </a>
                    )}
                    <Button variant="outline" size="sm" onClick={() => remove.mutate(message.id)} disabled={remove.isPending}>
                      <Trash2 className="h-4 w-4 me-1 text-red-600" />
                      {t("inbox.delete", "حذف")}
                    </Button>
                  </div>
                </div>
                <div className="prose prose-sm max-w-none border rounded-md p-4 bg-muted/20"
                  dangerouslySetInnerHTML={{ __html: message.body || "" }} />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
