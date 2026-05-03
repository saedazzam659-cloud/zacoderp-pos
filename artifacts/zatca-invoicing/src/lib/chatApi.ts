// Thin REST client for the internal chat module + AI features.
// Mirrors the patterns used by posOperationsApi.ts: localStorage Bearer
// token, JSON in/out, throws on non-2xx with a friendly message.
const API = (import.meta.env.VITE_API_URL ?? "") as string;

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function req<T>(method: string, url: string, body?: any): Promise<T> {
  const r = await fetch(`${API}${url}`, {
    method,
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = "حدث خطأ";
    try { const j = await r.json(); msg = j?.error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (r.status === 204) return undefined as any;
  return r.json() as Promise<T>;
}

export type ChatUser = {
  id: number;
  username: string;
  nameAr: string | null;
  nameEn: string | null;
  role?: string;
};

export type ChatParticipantRow = {
  conversationId: number;
  userId: number;
  role: string;
  username: string | null;
  nameAr: string | null;
  nameEn: string | null;
};

export type ChatConversation = {
  id: number;
  kind: "direct" | "group";
  title: string | null;
  createdByUserId: number | null;
  createdAt: string;
  lastMessageAt: string;
  lastMessageBody: string | null;
  lastMessageKind: string | null;
  lastMessageCreatedAt: string | null;
  lastMessageSenderUserId: number | null;
  unreadCount: number;
  participants: ChatParticipantRow[];
};

export type ChatMessage = {
  id: number;
  conversationId: number;
  companyId: number;
  senderUserId: number | null;
  kind: "text" | "image" | "file";
  body: string;
  attachmentUrl: string | null;
  attachmentName: string | null;
  attachmentMime: string | null;
  attachmentSize: number | null;
  replyToId: number | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  sender: ChatUser | null;
};

export const chatApi = {
  // Directory
  listUsers: () => req<ChatUser[]>("GET", "/api/chat/users"),

  // Conversations
  listConversations: () => req<ChatConversation[]>("GET", "/api/chat/conversations"),
  createConversation: (body: { kind: "direct" | "group"; title?: string | null; participantUserIds: number[] }) =>
    req<{ id: number; existed: boolean }>("POST", "/api/chat/conversations", body),

  // Messages
  listMessages: (conversationId: number, opts?: { since?: number; before?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.since)  qs.set("since",  String(opts.since));
    if (opts?.before) qs.set("before", String(opts.before));
    if (opts?.limit)  qs.set("limit",  String(opts.limit));
    const q = qs.toString();
    return req<ChatMessage[]>("GET", `/api/chat/conversations/${conversationId}/messages${q ? `?${q}` : ""}`);
  },
  sendMessage: (conversationId: number, body: {
    body?: string;
    kind?: "text" | "image" | "file";
    attachmentUrl?: string | null;
    attachmentName?: string | null;
    attachmentMime?: string | null;
    attachmentSize?: number | null;
    replyToId?: number | null;
  }) => req<ChatMessage>("POST", `/api/chat/conversations/${conversationId}/messages`, body),

  markRead: (conversationId: number, messageId: number) =>
    req<{ ok: true }>("POST", `/api/chat/conversations/${conversationId}/read`, { messageId }),

  deleteMessage: (messageId: number) =>
    req<{ ok: true }>("DELETE", `/api/chat/messages/${messageId}`),

  unreadCount: () => req<{ count: number }>("GET", "/api/chat/unread-count"),

  // ── AI features ───────────────────────────────────────────────────────
  summarize: (conversationId: number) =>
    req<{ summary: string; source: "ai" | "rule" }>("POST", "/api/chat-ai/summarize", { conversationId }),
  suggestReplies: (conversationId: number) =>
    req<{ suggestions: string[]; source: "ai" | "rule" }>("POST", "/api/chat-ai/suggest-replies", { conversationId }),
  translate: (text: string, to: "ar" | "en") =>
    req<{ translation: string; source: "ai" }>("POST", "/api/chat-ai/translate", { text, to }),
  extractTasks: (conversationId: number) =>
    req<{ tasks: { text: string; owner: string | null; due: string | null }[]; decisions: string[]; source: "ai" | "rule" }>(
      "POST", "/api/chat-ai/extract-tasks", { conversationId }),
  search: (q: string) =>
    req<{ results: Array<{
      id: number; conversationId: number; body: string; createdAt: string;
      senderUserId: number | null; senderUsername: string | null;
      conversationTitle: string | null; conversationKind: string;
    }> }>("GET", `/api/chat-ai/search?q=${encodeURIComponent(q)}`),

  // ── Attachments: request a presigned upload URL, then PUT directly. ──
  requestUploadUrl: (file: { name: string; size: number; contentType: string }) =>
    req<{ uploadURL: string; objectPath: string; metadata: any }>("POST", "/api/storage/uploads/request-url", file),
};

// Convenience helper: upload a File via the presigned URL flow and return
// the internal object path (suitable for storing in attachmentUrl).
export async function uploadFile(file: File): Promise<{
  objectPath: string; name: string; size: number; contentType: string;
}> {
  const { uploadURL, objectPath } = await chatApi.requestUploadUrl({
    name: file.name, size: file.size, contentType: file.type || "application/octet-stream",
  });
  const r = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!r.ok) throw new Error("فشل رفع الملف");
  return { objectPath, name: file.name, size: file.size, contentType: file.type || "application/octet-stream" };
}

export function displayName(u: { nameAr?: string | null; nameEn?: string | null; username?: string | null } | null | undefined): string {
  if (!u) return "—";
  return u.nameAr || u.nameEn || u.username || "—";
}

// For a direct conversation, find the "other" participant (not the current user).
export function otherParticipant(conv: ChatConversation, currentUserId: number): ChatParticipantRow | null {
  if (conv.kind !== "direct") return null;
  return conv.participants.find(p => p.userId !== currentUserId) ?? null;
}

export function conversationLabel(conv: ChatConversation, currentUserId: number): string {
  if (conv.title) return conv.title;
  if (conv.kind === "direct") {
    const other = otherParticipant(conv, currentUserId);
    return displayName(other);
  }
  // Group without title — list first 3 names.
  const names = conv.participants
    .filter(p => p.userId !== currentUserId)
    .slice(0, 3)
    .map(p => displayName(p));
  return names.length ? names.join("، ") : "مجموعة";
}
