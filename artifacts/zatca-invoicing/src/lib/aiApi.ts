const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

export interface ItemFieldsSuggestion {
  nameAr: string;
  nameEn: string;
  description: string;
  tags: string[];
  suggestedSalePrice: number | null;
  suggestedMargin: number | null;
  suggestedVatRate: number | null;
  suggestedGroup: string | null;
  suggestedUnit: string | null;
  suggestedItemType: "stock" | "service" | null;
  reasoning: string;
}

export interface ItemFieldsContext {
  nameAr?: string;
  nameEn?: string;
  code?: string;
  costPrice?: string | number;
  salePrice?: string | number;
  vatRate?: string | number;
  itemType?: string;
  description?: string;
  barcode?: string;
  group?: string;
  unit?: string;
  availableGroups?: string[];
  availableUnits?: string[];
}

export const aiApi = {
  suggestItemFields: async (ctx: ItemFieldsContext): Promise<ItemFieldsSuggestion> => {
    const r = await fetch(`${API}/api/ai/suggest-item-fields`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(ctx),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(txt || `فشل طلب الذكاء الاصطناعي (${r.status})`);
    }
    return r.json();
  },
};
