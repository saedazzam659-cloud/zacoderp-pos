// Local items catalog shim. Forwards to Rust items::* commands in Tauri,
// falls back to a built-in demo array in browser dev mode so the SalesScreen
// keeps rendering without a backend.

const IS_TAURI =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!_invoke) {
    const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core");
    _invoke = mod.invoke;
  }
  return (await _invoke!(cmd, args)) as T;
}

export interface LocalItem {
  id: number;
  cloudId?: number | null;
  code?: string | null;
  nameAr: string;
  nameEn?: string | null;
  barcode?: string | null;
  salePrice: number;
  vatRate: number;
}

// Rust returns snake_case → normalize once at the boundary
interface RustItem {
  id: number;
  cloud_id: number | null;
  code: string | null;
  name_ar: string;
  name_en: string | null;
  barcode: string | null;
  sale_price: number;
  vat_rate: number;
}

function fromRust(r: RustItem): LocalItem {
  return {
    id: r.id,
    cloudId: r.cloud_id,
    code: r.code,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    barcode: r.barcode,
    salePrice: r.sale_price,
    vatRate: r.vat_rate,
  };
}

// ─── Browser fallback catalog ────────────────────────────────────────
const DEV_DEMO: LocalItem[] = [
  { id: 1, nameAr: "ماء معدني 500مل", barcode: "6281007123456", salePrice: 1.5, vatRate: 15 },
  { id: 2, nameAr: "شيبس صغير",        barcode: "6281007123457", salePrice: 3.0, vatRate: 15 },
  { id: 3, nameAr: "علبة عصير",          barcode: "6281007123458", salePrice: 5.0, vatRate: 15 },
  { id: 4, nameAr: "بسكويت",             barcode: "6281007123459", salePrice: 4.5, vatRate: 15 },
  { id: 5, nameAr: "شوكولاتة",           barcode: "6281007123460", salePrice: 7.0, vatRate: 15 },
  { id: 6, nameAr: "لبن طازج 1لتر",    barcode: "6281007123461", salePrice: 8.5, vatRate: 15 },
];

export async function listItems(search?: string): Promise<LocalItem[]> {
  if (!IS_TAURI) {
    if (!search) return DEV_DEMO;
    const q = search.toLowerCase();
    return DEV_DEMO.filter((i) => i.nameAr.includes(search) || (i.barcode ?? "").includes(q));
  }
  const rows = await invoke<RustItem[]>("list_items", { search: search ?? null });
  return rows.map(fromRust);
}

export async function findItemByBarcode(barcode: string): Promise<LocalItem | null> {
  if (!IS_TAURI) {
    return DEV_DEMO.find((i) => i.barcode === barcode) ?? null;
  }
  const r = await invoke<RustItem | null>("find_item_by_barcode", { barcode });
  return r ? fromRust(r) : null;
}

export async function seedDemoItems(): Promise<number> {
  if (!IS_TAURI) return 0;
  return invoke<number>("seed_demo_items");
}
