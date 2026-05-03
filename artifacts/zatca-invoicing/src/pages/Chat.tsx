import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  chatApi, uploadFile,
  type ChatConversation, type ChatMessage, type ChatUser,
  conversationLabel, displayName, otherParticipant,
} from "@/lib/chatApi";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  MessageSquare, Plus, Send, Paperclip, Trash2, Search, Sparkles,
  Languages, ListChecks, Image as ImageIcon, FileText, Loader2, X, Users as UsersIcon,
} from "lucide-react";

const POLL_LIST_MS = 10_000;
const POLL_MSGS_MS =  3_000;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0] || "").join("").toUpperCase() || "?";
}
function formatTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short" });
}
function lastMessagePreview(m: { kind: string | null; body: string | null }): string {
  if (!m || !m.kind) return "";
  if (m.kind === "image") return "📷 صورة";
  if (m.kind === "file")  return "📎 ملف";
  return (m.body || "").slice(0, 80);
}

// ─────────────────────────────────────────────────────────────────────────
// New-conversation dialog
// ─────────────────────────────────────────────────────────────────────────
function NewConversationDialog({ onCreated }: { onCreated: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"direct" | "group">("direct");
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const { data: users = [] } = useQuery({
    queryKey: ["chat", "users"],
    queryFn: () => chatApi.listUsers(),
    enabled: open,
  });
  const filtered = users.filter(u =>
    !search || displayName(u).toLowerCase().includes(search.toLowerCase()) ||
    u.username.toLowerCase().includes(search.toLowerCase())
  );
  const createMu = useMutation({
    mutationFn: () => chatApi.createConversation({
      kind,
      title: kind === "group" ? (title.trim() || null) : null,
      participantUserIds: Array.from(picked),
    }),
    onSuccess: ({ id }) => {
      setOpen(false); setPicked(new Set()); setTitle(""); setSearch("");
      onCreated(id);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });
  // Direct chats lock to a single pick. Toggle accordingly.
  function toggle(id: number) {
    const next = new Set(picked);
    if (kind === "direct") { next.clear(); next.add(id); }
    else { next.has(id) ? next.delete(id) : next.add(id); }
    setPicked(next);
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button data-testid="button-new-chat" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 ms-1" /> محادثة جديدة
      </Button>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>محادثة جديدة</DialogTitle></DialogHeader>
        <Tabs value={kind} onValueChange={(v) => { setKind(v as any); setPicked(new Set()); }}>
          <TabsList className="w-full">
            <TabsTrigger value="direct" className="flex-1">فردية</TabsTrigger>
            <TabsTrigger value="group" className="flex-1">جماعية</TabsTrigger>
          </TabsList>
          <TabsContent value="group" className="mt-3">
            <Input placeholder="اسم المجموعة (اختياري)" value={title} onChange={e => setTitle(e.target.value)} />
          </TabsContent>
        </Tabs>
        <Input placeholder="ابحث عن زميل…" value={search} onChange={e => setSearch(e.target.value)} className="mt-3" />
        <ScrollArea className="h-72 border rounded-md p-2">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">لا يوجد مستخدمون</p>
          ) : filtered.map(u => (
            <label key={u.id}
              data-testid={`user-row-${u.id}`}
              className="flex items-center gap-2 p-2 rounded hover:bg-accent cursor-pointer">
              <Checkbox checked={picked.has(u.id)} onCheckedChange={() => toggle(u.id)} />
              <Avatar className="h-8 w-8"><AvatarFallback>{initials(displayName(u))}</AvatarFallback></Avatar>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{displayName(u)}</div>
                <div className="text-xs text-muted-foreground truncate">{u.username}</div>
              </div>
            </label>
          ))}
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
          <Button
            data-testid="button-create-conversation"
            disabled={picked.size === 0 || createMu.isPending}
            onClick={() => createMu.mutate()}>
            {createMu.isPending && <Loader2 className="h-4 w-4 animate-spin ms-1" />}
            إنشاء
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// AI tools panel — summarize / replies / translate / extract tasks / search
// ─────────────────────────────────────────────────────────────────────────
function AiToolsPanel({ conversationId, onPickReply }: { conversationId: number | null; onPickReply: (s: string) => void }) {
  const [summary, setSummary] = useState<string>("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [tasksOut, setTasksOut] = useState<{ tasks: any[]; decisions: string[] } | null>(null);
  const [translateText, setTranslateText] = useState("");
  const [translateTo, setTranslateTo] = useState<"ar" | "en">("en");
  const [translation, setTranslation] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);

  const summarizeMu = useMutation({
    mutationFn: () => chatApi.summarize(conversationId!),
    onSuccess: (r) => setSummary(r.summary),
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });
  const suggestMu = useMutation({
    mutationFn: () => chatApi.suggestReplies(conversationId!),
    onSuccess: (r) => setSuggestions(r.suggestions),
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });
  const tasksMu = useMutation({
    mutationFn: () => chatApi.extractTasks(conversationId!),
    onSuccess: (r) => setTasksOut({ tasks: r.tasks, decisions: r.decisions }),
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });
  const translateMu = useMutation({
    mutationFn: () => chatApi.translate(translateText, translateTo),
    onSuccess: (r) => setTranslation(r.translation),
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });
  const searchMu = useMutation({
    mutationFn: () => chatApi.search(searchQ),
    onSuccess: (r) => setSearchResults(r.results),
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4 p-4">
      {/* Summarize */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold flex items-center gap-1"><Sparkles className="h-4 w-4" /> تلخيص المحادثة</h3>
          <Button data-testid="button-summarize" size="sm" variant="outline"
            disabled={!conversationId || summarizeMu.isPending}
            onClick={() => summarizeMu.mutate()}>
            {summarizeMu.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "تلخيص"}
          </Button>
        </div>
        {summary && <pre data-testid="text-summary" className="text-xs bg-muted p-2 rounded whitespace-pre-wrap">{summary}</pre>}
      </section>

      {/* Smart replies */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold flex items-center gap-1"><MessageSquare className="h-4 w-4" /> ردود مقترحة</h3>
          <Button data-testid="button-suggest" size="sm" variant="outline"
            disabled={!conversationId || suggestMu.isPending}
            onClick={() => suggestMu.mutate()}>
            {suggestMu.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "اقتراح"}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s, i) => (
            <Button key={i} data-testid={`chip-reply-${i}`} variant="secondary" size="sm" className="h-auto py-1 text-xs"
              onClick={() => onPickReply(s)}>{s}</Button>
          ))}
        </div>
      </section>

      {/* Extract tasks/decisions */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold flex items-center gap-1"><ListChecks className="h-4 w-4" /> المهام والقرارات</h3>
          <Button data-testid="button-extract" size="sm" variant="outline"
            disabled={!conversationId || tasksMu.isPending}
            onClick={() => tasksMu.mutate()}>
            {tasksMu.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "استخراج"}
          </Button>
        </div>
        {tasksOut && (
          <div className="space-y-2 text-xs">
            {tasksOut.tasks.length > 0 && <div>
              <div className="font-semibold mb-1">مهام:</div>
              <ul className="list-disc ms-4 space-y-1">
                {tasksOut.tasks.map((t, i) => (
                  <li key={i}>{t.text} {t.owner ? <span className="text-muted-foreground">— {t.owner}</span> : null} {t.due ? <span className="text-muted-foreground">({t.due})</span> : null}</li>
                ))}
              </ul>
            </div>}
            {tasksOut.decisions.length > 0 && <div>
              <div className="font-semibold mb-1">قرارات:</div>
              <ul className="list-disc ms-4 space-y-1">{tasksOut.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </div>}
            {tasksOut.tasks.length === 0 && tasksOut.decisions.length === 0 &&
              <p className="text-muted-foreground">لم يُعثر على مهام أو قرارات.</p>}
          </div>
        )}
      </section>

      {/* Translate */}
      <section>
        <h3 className="text-sm font-semibold flex items-center gap-1 mb-2"><Languages className="h-4 w-4" /> ترجمة</h3>
        <Textarea data-testid="input-translate-text" rows={2} value={translateText} onChange={e => setTranslateText(e.target.value)} placeholder="نص للترجمة…" />
        <div className="flex items-center gap-2 mt-2">
          <select className="border rounded px-2 py-1 text-xs" value={translateTo} onChange={e => setTranslateTo(e.target.value as any)}>
            <option value="en">→ English</option>
            <option value="ar">→ العربية</option>
          </select>
          <Button data-testid="button-translate" size="sm" variant="outline"
            disabled={!translateText.trim() || translateMu.isPending}
            onClick={() => translateMu.mutate()}>
            {translateMu.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "ترجمة"}
          </Button>
        </div>
        {translation && <pre data-testid="text-translation" className="text-xs bg-muted p-2 rounded mt-2 whitespace-pre-wrap">{translation}</pre>}
      </section>

      {/* Smart search */}
      <section>
        <h3 className="text-sm font-semibold flex items-center gap-1 mb-2"><Search className="h-4 w-4" /> بحث ذكي في المحادثات</h3>
        <div className="flex gap-2">
          <Input data-testid="input-search" value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="كلمة مفتاحية…" />
          <Button data-testid="button-search" size="sm" variant="outline" disabled={searchQ.trim().length < 2 || searchMu.isPending} onClick={() => searchMu.mutate()}>
            {searchMu.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "بحث"}
          </Button>
        </div>
        <div className="mt-2 space-y-1 max-h-48 overflow-auto">
          {searchResults.map((r) => (
            <div key={r.id} data-testid={`search-result-${r.id}`} className="text-xs bg-muted p-2 rounded">
              <div className="text-muted-foreground">{r.senderUsername || "?"} • {formatTime(r.createdAt)}</div>
              <div>{r.body}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────
export default function ChatPage() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const userId = user?.id ?? 0;

  const [activeId, setActiveId] = useState<number | null>(null);
  const [composer, setComposer] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Conversation list (poll every 10s) ────────────────────────────────
  const { data: conversations = [] } = useQuery({
    queryKey: ["chat", "conversations"],
    queryFn: () => chatApi.listConversations(),
    refetchInterval: POLL_LIST_MS,
  });

  // Auto-pick first conversation when none selected.
  useEffect(() => {
    if (activeId === null && conversations.length > 0) setActiveId(conversations[0].id);
  }, [conversations, activeId]);

  // ── Messages of active conversation (poll every 3s) ───────────────────
  const { data: messages = [] } = useQuery({
    queryKey: ["chat", "messages", activeId],
    queryFn: () => activeId ? chatApi.listMessages(activeId, { limit: 100 }) : Promise.resolve([]),
    enabled: !!activeId,
    refetchInterval: activeId ? POLL_MSGS_MS : false,
  });

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, activeId]);

  // Auto-mark-read when messages arrive in the active conversation.
  useEffect(() => {
    if (!activeId || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!last) return;
    chatApi.markRead(activeId, last.id).then(() => {
      qc.invalidateQueries({ queryKey: ["chat", "conversations"] });
      qc.invalidateQueries({ queryKey: ["chat", "unread"] });
    }).catch(() => { /* ignore */ });
  }, [activeId, messages.length, qc]);

  // ── Send message ──────────────────────────────────────────────────────
  const sendMu = useMutation({
    mutationFn: async () => {
      if (!activeId) throw new Error("لا توجد محادثة محددة");
      let payload: any = { body: composer.trim() };
      if (pendingFile) {
        const up = await uploadFile(pendingFile);
        const isImage = (up.contentType || "").startsWith("image/");
        payload = {
          body: composer.trim(),
          kind: isImage ? "image" : "file",
          attachmentUrl: up.objectPath,
          attachmentName: up.name,
          attachmentMime: up.contentType,
          attachmentSize: up.size,
        };
      }
      return chatApi.sendMessage(activeId, payload);
    },
    onSuccess: () => {
      setComposer(""); setPendingFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["chat", "messages", activeId] });
      qc.invalidateQueries({ queryKey: ["chat", "conversations"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const deleteMu = useMutation({
    mutationFn: (id: number) => chatApi.deleteMessage(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chat", "messages", activeId] }),
  });

  const activeConv = conversations.find(c => c.id === activeId) ?? null;
  const activeLabel = activeConv ? conversationLabel(activeConv, userId) : "";

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]" dir="rtl">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <MessageSquare className="h-5 w-5" /> الاتصال الداخلي
        </h1>
        <NewConversationDialog onCreated={(id) => {
          setActiveId(id);
          qc.invalidateQueries({ queryKey: ["chat", "conversations"] });
        }} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[20rem_1fr] gap-3 flex-1 min-h-0">
        {/* Sidebar */}
        <aside className="border rounded-md flex flex-col min-h-0 bg-card">
          <div className="p-2 border-b text-xs text-muted-foreground">
            {conversations.length} محادثة
          </div>
          <ScrollArea className="flex-1">
            {conversations.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                لا توجد محادثات بعد. ابدأ محادثة جديدة.
              </div>
            )}
            {conversations.map(c => {
              const label = conversationLabel(c, userId);
              const active = c.id === activeId;
              return (
                <button key={c.id}
                  data-testid={`conv-row-${c.id}`}
                  onClick={() => setActiveId(c.id)}
                  className={cn("w-full text-start p-3 border-b hover-elevate flex gap-2",
                    active && "bg-accent")}>
                  <Avatar className="h-9 w-9 shrink-0">
                    <AvatarFallback>{c.kind === "group" ? <UsersIcon className="h-4 w-4" /> : initials(label)}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{label}</span>
                      {c.unreadCount > 0 && (
                        <Badge data-testid={`conv-unread-${c.id}`} className="text-[10px] h-5 px-1.5">{c.unreadCount}</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {lastMessagePreview({ kind: c.lastMessageKind, body: c.lastMessageBody }) || "لا توجد رسائل"}
                    </div>
                  </div>
                </button>
              );
            })}
          </ScrollArea>
        </aside>

        {/* Conversation panel */}
        <section className="border rounded-md flex flex-col min-h-0 bg-card">
          {activeConv ? (
            <>
              <header className="p-3 border-b flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback>{activeConv.kind === "group" ? <UsersIcon className="h-4 w-4" /> : initials(activeLabel)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="font-semibold truncate" data-testid="text-conv-label">{activeLabel}</div>
                    <div className="text-xs text-muted-foreground">
                      {activeConv.kind === "group"
                        ? `${activeConv.participants.length} عضو`
                        : "محادثة فردية"}
                    </div>
                  </div>
                </div>
                <Sheet open={aiOpen} onOpenChange={setAiOpen}>
                  <SheetTrigger asChild>
                    <Button data-testid="button-open-ai" size="sm" variant="outline">
                      <Sparkles className="h-4 w-4 ms-1" /> أدوات الذكاء
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left" className="w-96 overflow-y-auto">
                    <SheetHeader><SheetTitle>أدوات الذكاء الاصطناعي</SheetTitle></SheetHeader>
                    <AiToolsPanel conversationId={activeConv.id} onPickReply={(s) => { setComposer(s); setAiOpen(false); }} />
                  </SheetContent>
                </Sheet>
              </header>

              {/* Messages */}
              <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
                {messages.length === 0 && (
                  <div className="text-center text-sm text-muted-foreground py-12">
                    لا توجد رسائل. ابدأ المحادثة!
                  </div>
                )}
                {messages.map(m => (
                  <MessageRow key={m.id} m={m} mine={m.senderUserId === userId}
                    onDelete={() => deleteMu.mutate(m.id)} />
                ))}
              </div>

              {/* Composer */}
              <div className="p-3 border-t flex flex-col gap-2">
                {pendingFile && (
                  <div className="flex items-center gap-2 text-xs bg-muted p-2 rounded">
                    {pendingFile.type.startsWith("image/") ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                    <span className="truncate flex-1">{pendingFile.name}</span>
                    <button onClick={() => { setPendingFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}>
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}
                <div className="flex gap-2 items-end">
                  <input ref={fileInputRef} type="file" className="hidden"
                    onChange={(e) => setPendingFile(e.target.files?.[0] ?? null)} />
                  <Button data-testid="button-attach" type="button" size="icon" variant="outline"
                    onClick={() => fileInputRef.current?.click()}>
                    <Paperclip className="h-4 w-4" />
                  </Button>
                  <Textarea
                    data-testid="input-composer"
                    rows={1}
                    value={composer}
                    onChange={e => setComposer(e.target.value)}
                    placeholder="اكتب رسالتك…"
                    className="resize-none min-h-10"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if ((composer.trim() || pendingFile) && !sendMu.isPending) sendMu.mutate();
                      }
                    }}
                  />
                  <Button
                    data-testid="button-send"
                    type="button"
                    onClick={() => sendMu.mutate()}
                    disabled={(!composer.trim() && !pendingFile) || sendMu.isPending}>
                    {sendMu.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              اختر محادثة أو ابدأ محادثة جديدة
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function MessageRow({ m, mine, onDelete }: { m: ChatMessage; mine: boolean; onDelete: () => void }) {
  const senderLabel = displayName(m.sender);
  const isImg = m.kind === "image" && m.attachmentUrl;
  const isFile = m.kind === "file" && m.attachmentUrl;
  return (
    <div data-testid={`msg-row-${m.id}`} className={cn("flex gap-2", mine && "justify-end")}>
      {!mine && (
        <Avatar className="h-7 w-7 mt-1"><AvatarFallback>{initials(senderLabel)}</AvatarFallback></Avatar>
      )}
      <div className={cn(
        "group max-w-[70%] rounded-lg px-3 py-2 text-sm relative",
        mine ? "bg-primary text-primary-foreground" : "bg-muted",
        m.deletedAt && "italic opacity-60",
      )}>
        {!mine && <div className="text-[10px] font-semibold mb-0.5 opacity-70">{senderLabel}</div>}
        {m.deletedAt ? (
          <div>(تم حذف هذه الرسالة)</div>
        ) : (
          <>
            {isImg && (
              <img src={`/api${m.attachmentUrl}`} alt={m.attachmentName ?? ""}
                className="max-w-full max-h-64 rounded mb-1" />
            )}
            {isFile && (
              <a href={`/api${m.attachmentUrl}`} target="_blank" rel="noreferrer"
                className="flex items-center gap-1 underline mb-1">
                <FileText className="h-4 w-4" /> {m.attachmentName ?? "ملف"}
              </a>
            )}
            {m.body && <div className="whitespace-pre-wrap break-words">{m.body}</div>}
          </>
        )}
        <div className={cn("text-[10px] mt-1 opacity-70", mine ? "text-end" : "text-start")}>
          {formatTime(m.createdAt)}
        </div>
        {mine && !m.deletedAt && (
          <button
            data-testid={`button-delete-msg-${m.id}`}
            onClick={onDelete}
            className="absolute top-1 left-1 opacity-0 group-hover:opacity-100 transition">
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}
