// Typed client for the POS AI endpoints (/api/pos/ai/*).

import { getToken, clearAuth } from "./api";

const API = (import.meta.env.VITE_API_URL ?? "") as string;

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = getToken(); if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(`${API}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    if (r.status === 401) clearAuth();
    let msg = "حدث خطأ في الاتصال";
    try { const d = await r.json(); msg = d?.error || msg; } catch {}
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export type Suggestion = { itemId: number | null; itemName: string; score: number; reason: string };
export type DiscountAdvice = { suggestedPercent: number; maxPercent: number; reasons: string[] };
export type FraudFlag = { severity: "low" | "medium" | "high"; message: string };
export type FraudResult = { ok: boolean; severity: "low" | "medium" | "high"; flags: FraudFlag[]; block: boolean };
export type ChatResponse = { answer: string; data?: any; suggestions?: string[] };

export const posAi = {
  suggest: (opts: { itemIds?: number[]; customerId?: number | null; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts.itemIds?.length) qs.set("itemIds", opts.itemIds.join(","));
    if (opts.customerId) qs.set("customerId", String(opts.customerId));
    if (opts.limit) qs.set("limit", String(opts.limit));
    return req<{ suggestions: Suggestion[] }>("GET", `/api/pos/ai/suggest?${qs.toString()}`);
  },
  discount: (body: { customerId?: number | null; totalAmount: number; qty: number; hour?: number }) =>
    req<DiscountAdvice>("POST", "/api/pos/ai/discount", body),
  fraudCheck: (body: {
    discountPct: number; totalAmount: number; qty: number;
    lines: Array<{ itemName: string; qty: number; discount: number; lineTotal: number }>;
    paymentType: string;
  }) => req<FraudResult>("POST", "/api/pos/ai/fraud-check", body),
  chat: (question: string) => req<ChatResponse>("POST", "/api/pos/ai/chat", { question }),
};
