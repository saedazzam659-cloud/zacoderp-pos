// Stock import — bulk upload opening balances + reorder points from CSV.
//
// Two modes:
//   • "update_only"  : match by barcode/code, update qty + reorderPoint only.
//                      Rows with no matching item are reported as skipped.
//   • "upsert"       : same as update, PLUS create new items for any row
//                      whose barcode/code doesn't exist yet (uses
//                      bulkImportLocalItems then writes the stock row).
//
// CSV header (case-insensitive):
//   barcode,code,nameAr,nameEn,salePrice,vatRate,quantity,reorderPoint
//
// `barcode` OR `code` is required for matching. `quantity` and `reorderPoint`
// are both optional — absent fields preserve previous values (update mode)
// or default to 0 (upsert + new item).

import { useMemo, useRef, useState } from "react";
import { listItems, bulkImportLocalItems, type LocalItem } from "../lib/items";
import { getAllStockShared, bulkSetStockShared } from "../lib/stock";

type Mode = "update_only" | "upsert";

type PreviewRow = {
  rowNum: number;
  barcode: string;
  code: string;
  nameAr: string;
  nameEn: string;
  salePrice: number | null;
  vatRate: number | null;
  quantity: number | null;
  reorderPoint: number | null;
  matchedItemId: number | null;
  prevQty: number | null;
  prevReorder: number | null;
  status: "match" | "new" | "skip";
  reason?: string;
};

/** Tiny CSV parser — same flavor as ItemsAdmin's: BOM, quotes, escapes, \r\n. */
function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(cell); cell = ""; i++; continue; }
    if (c === '\n' || c === '\r') {
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") out.push(row);
      row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++; continue;
    }
    cell += c; i++;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out;
}

const SAMPLE_CSV = `barcode,code,nameAr,nameEn,salePrice,vatRate,quantity,reorderPoint
6281007123456,A001,ماء معدني 500مل,Mineral Water 500ml,1.50,15,100,20
6281007123457,A002,شيبس صغير,Small Chips,3.00,15,50,10
,A003,قلم جاف أزرق,Blue Pen,2.50,15,200,30
`;

export default function StockImport({ onDone }: { onDone?: () => void }) {
  const [mode, setMode] = useState<Mode>("update_only");
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const summary = useMemo(() => {
    if (!preview) return null;
    const match = preview.filter((r) => r.status === "match").length;
    const nw = preview.filter((r) => r.status === "new").length;
    const skip = preview.filter((r) => r.status === "skip").length;
    return { match, nw, skip, total: preview.length };
  }, [preview]);

  async function buildPreview() {
    setToast(null);
    if (!csvText.trim()) {
      setToast({ kind: "err", text: "الصق محتوى CSV أو ارفع ملف أولاً" });
      return;
    }
    const grid = parseCsv(csvText);
    if (grid.length < 2) {
      setToast({ kind: "err", text: "الملف فارغ أو لا يحتوي على صف بيانات" });
      return;
    }
    const header = grid[0].map((h) => h.trim().toLowerCase());
    const idx = (n: string) => header.indexOf(n.toLowerCase());
    const cBc = idx("barcode");
    const cCode = idx("code");
    const cAr = idx("namear");
    const cEn = idx("nameen");
    const cPrice = idx("saleprice");
    const cVat = idx("vatrate");
    const cQty = idx("quantity");
    const cRp = idx("reorderpoint");
    if (cBc < 0 && cCode < 0) {
      setToast({ kind: "err", text: "العمود barcode أو code مطلوب — أحدهما على الأقل" });
      return;
    }
    if (cQty < 0 && cRp < 0) {
      setToast({ kind: "err", text: "العمود quantity أو reorderPoint مطلوب — أحدهما على الأقل" });
      return;
    }

    const items: LocalItem[] = await listItems();
    const stockMap = await getAllStockShared();
    const byBc = new Map<string, LocalItem>();
    const byCode = new Map<string, LocalItem>();
    for (const it of items) {
      if (it.barcode) byBc.set(it.barcode, it);
      if (it.code) byCode.set(it.code, it);
    }

    const rows: PreviewRow[] = [];
    for (let r = 1; r < grid.length; r++) {
      const row = grid[r];
      if (row.every((c) => !c.trim())) continue;
      const get = (i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
      const barcode = get(cBc);
      const code = get(cCode);
      const nameAr = get(cAr);
      const nameEn = get(cEn);
      const priceStr = get(cPrice);
      const vatStr = get(cVat);
      const qtyStr = get(cQty);
      const rpStr = get(cRp);

      const num = (s: string): number | null => {
        if (!s) return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      };
      const salePrice = num(priceStr);
      const vatRate = num(vatStr);
      const quantity = num(qtyStr);
      const reorderPoint = num(rpStr);

      // Match
      const matched: LocalItem | null =
        (barcode ? byBc.get(barcode) ?? null : null) ??
        (code ? byCode.get(code) ?? null : null);

      let status: PreviewRow["status"] = "skip";
      let reason: string | undefined;
      if (matched) {
        status = "match";
      } else if (mode === "upsert") {
        if (!nameAr) {
          status = "skip";
          reason = "اسم الصنف مفقود — مطلوب لإنشاء صنف جديد";
        } else if (!salePrice || !Number.isFinite(salePrice) || salePrice <= 0) {
          status = "skip";
          reason = "سعر البيع مفقود أو غير صالح — مطلوب لإنشاء صنف جديد";
        } else {
          status = "new";
        }
      } else {
        status = "skip";
        reason = "لم يتم العثور على الصنف في الكتالوج (وضع التحديث فقط)";
      }

      const prev = matched ? stockMap[matched.id] ?? null : null;

      rows.push({
        rowNum: r + 1,
        barcode, code, nameAr, nameEn,
        salePrice, vatRate, quantity, reorderPoint,
        matchedItemId: matched?.id ?? null,
        prevQty: prev?.qty ?? null,
        prevReorder: prev?.reorderPoint ?? null,
        status, reason,
      });
    }
    setPreview(rows);
  }

  async function applyImport() {
    if (!preview) return;
    setImporting(true);
    setToast(null);
    try {
      // 1) Create new items if upsert mode.
      const newRows = preview.filter((r) => r.status === "new");
      let createdMap = new Map<string, number>();
      if (newRows.length > 0) {
        await bulkImportLocalItems(
          newRows.map((r) => ({
            code: r.code || null,
            nameAr: r.nameAr,
            nameEn: r.nameEn || null,
            barcode: r.barcode || null,
            salePrice: r.salePrice ?? 0,
            vatRate: r.vatRate ?? 15,
          })),
          { dedupBy: "barcode" },
        );
        // Re-fetch to learn the new ids.
        const after = await listItems();
        for (const it of after) {
          if (it.barcode) createdMap.set(`b:${it.barcode}`, it.id);
          if (it.code) createdMap.set(`c:${it.code}`, it.id);
        }
      }

      // 2) Set stock for all matched + newly-created rows.
      const stockRows: Array<{ itemId: number; qty?: number | null; reorderPoint?: number | null }> = [];
      for (const r of preview) {
        let id: number | null = r.matchedItemId;
        if (!id && r.status === "new") {
          id =
            (r.barcode ? createdMap.get(`b:${r.barcode}`) ?? null : null) ??
            (r.code ? createdMap.get(`c:${r.code}`) ?? null : null);
        }
        if (id) {
          stockRows.push({ itemId: id, qty: r.quantity, reorderPoint: r.reorderPoint });
        }
      }
      const written = await bulkSetStockShared(stockRows);
      setToast({
        kind: "ok",
        text: `تم: ${written} رصيد محفوظ${newRows.length ? ` — ${newRows.length} صنف جديد` : ""}${summary?.skip ? ` — ${summary.skip} تم تجاهلها` : ""}`,
      });
      setPreview(null);
      setCsvText("");
      if (fileRef.current) fileRef.current.value = "";
      onDone?.();
    } catch (e: any) {
      setToast({ kind: "err", text: e?.message ?? "فشل تطبيق الاستيراد" });
    } finally {
      setImporting(false);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ""));
    reader.readAsText(f, "utf-8");
  }

  async function downloadSample() {
    // UTF-8 BOM so Excel opens the Arabic columns correctly.
    const withBom = "\uFEFF" + SAMPLE_CSV;
    const isTauri =
      typeof window !== "undefined" &&
      ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

    // Inside Tauri: open the native Windows "Save As" dialog so the
    // cashier can pick where to save (and actually sees something happen).
    // WebView2 silently drops anchor-based downloads, so this path is the
    // only reliable one on the desktop build.
    if (isTauri) {
      try {
        const { invoke } = await import("../lib/tauri-shim");
        const saved = await invoke<string | null>("save_text_file", {
          content: withBom,
          suggestedName: "stock_template.csv",
          filterName: "CSV",
          filterExt: "csv",
        });
        if (saved) {
          setToast({ kind: "ok", text: `✅ تم حفظ النموذج: ${saved}` });
        }
        // null = user cancelled — silent, no toast.
        return;
      } catch (e: any) {
        // Fall through to browser path on any IPC error.
        // eslint-disable-next-line no-console
        console.warn("save_text_file failed, falling back to anchor", e);
      }
    }

    // Browser/Vite preview fallback — anchor must be DOM-attached to fire
    // in any Chromium-based WebView too.
    const blob = new Blob([withBom], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "stock_template.csv";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.header}>
        <div>
          <h2 style={S.h2}>استيراد الأرصدة الافتتاحية</h2>
          <div style={S.sub}>رفع كميات المخزون وحد الطلب من ملف CSV</div>
        </div>
        <button onClick={downloadSample} style={S.btnGhost}>📥 تحميل نموذج CSV</button>
      </div>

      <div style={S.section}>
        <div style={S.label}>وضع الاستيراد</div>
        <div style={S.modeRow}>
          <label style={mode === "update_only" ? S.modePickActive : S.modePick}>
            <input
              type="radio"
              checked={mode === "update_only"}
              onChange={() => { setMode("update_only"); setPreview(null); }}
            />
            <div>
              <div style={S.modeName}>تحديث الأرصدة فقط</div>
              <div style={S.modeHint}>يحدّث الكميات والحد الأدنى للأصناف الموجودة فقط — يتجاهل الجديد</div>
            </div>
          </label>
          <label style={mode === "upsert" ? S.modePickActive : S.modePick}>
            <input
              type="radio"
              checked={mode === "upsert"}
              onChange={() => { setMode("upsert"); setPreview(null); }}
            />
            <div>
              <div style={S.modeName}>تحديث + إنشاء الجديد</div>
              <div style={S.modeHint}>ينشئ الأصناف الجديدة (يتطلب اسم وسعر) ثم يحدّث رصيد الكل</div>
            </div>
          </label>
        </div>
      </div>

      <div style={S.section}>
        <div style={S.label}>الملف</div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={S.file} />
          <span style={S.muted}>أو الصق محتوى الملف بالأسفل</span>
        </div>
      </div>

      <textarea
        value={csvText}
        onChange={(e) => { setCsvText(e.target.value); setPreview(null); }}
        placeholder={SAMPLE_CSV}
        rows={8}
        style={S.textarea}
      />

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={buildPreview} disabled={!csvText.trim() || importing} style={S.btnPrimary}>
          👁️ معاينة قبل التطبيق
        </button>
        {preview && (
          <button onClick={applyImport} disabled={importing} style={S.btnApply}>
            {importing ? "... جاري التطبيق" : `✅ تطبيق (${(summary?.match ?? 0) + (summary?.nw ?? 0)} صف)`}
          </button>
        )}
      </div>

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      {preview && summary && (
        <div style={S.previewBox}>
          <div style={S.summary}>
            <span style={S.chipOk}>✅ {summary.match} تحديث</span>
            {mode === "upsert" && <span style={S.chipNew}>🆕 {summary.nw} جديد</span>}
            <span style={S.chipSkip}>⏭️ {summary.skip} تم تجاهله</span>
            <span style={S.chipTotal}>الإجمالي {summary.total}</span>
          </div>
          <div style={{ overflowX: "auto", maxHeight: 400 }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>#</th>
                  <th style={S.th}>الحالة</th>
                  <th style={S.th}>الباركود</th>
                  <th style={S.th}>الكود</th>
                  <th style={S.th}>الاسم</th>
                  <th style={S.th}>الرصيد القديم</th>
                  <th style={S.th}>الرصيد الجديد</th>
                  <th style={S.th}>حد الطلب القديم</th>
                  <th style={S.th}>حد الطلب الجديد</th>
                  <th style={S.th}>ملاحظات</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r) => (
                  <tr key={r.rowNum} style={
                    r.status === "match" ? S.rowOk
                    : r.status === "new" ? S.rowNew
                    : S.rowSkip
                  }>
                    <td style={S.td}>{r.rowNum}</td>
                    <td style={S.td}>
                      {r.status === "match" ? "تحديث" : r.status === "new" ? "جديد" : "تجاهل"}
                    </td>
                    <td style={S.tdMono}>{r.barcode || "—"}</td>
                    <td style={S.tdMono}>{r.code || "—"}</td>
                    <td style={S.td}>{r.nameAr || "—"}</td>
                    <td style={S.tdNum}>{r.prevQty ?? "—"}</td>
                    <td style={S.tdNumBold}>{r.quantity ?? "—"}</td>
                    <td style={S.tdNum}>{r.prevReorder ?? "—"}</td>
                    <td style={S.tdNumBold}>{r.reorderPoint ?? "—"}</td>
                    <td style={S.tdMuted}>{r.reason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  wrap: { padding: 24, maxWidth: 1280, margin: "0 auto", display: "flex", flexDirection: "column" as const, gap: 16 } as const,
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end" } as const,
  h2: { fontSize: 22, fontWeight: 700, color: "#0f172a", margin: 0 } as const,
  sub: { fontSize: 13, color: "#64748b", marginTop: 4 } as const,
  section: { display: "flex", flexDirection: "column" as const, gap: 8 } as const,
  label: { fontSize: 13, fontWeight: 600, color: "#334155" } as const,
  modeRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } as const,
  modePick: {
    display: "flex", gap: 12, padding: 16, border: "2px solid #e2e8f0",
    borderRadius: 12, cursor: "pointer", background: "#fff",
  } as const,
  modePickActive: {
    display: "flex", gap: 12, padding: 16, border: "2px solid #2563eb",
    borderRadius: 12, cursor: "pointer", background: "#eff6ff",
  } as const,
  modeName: { fontWeight: 700, color: "#0f172a", fontSize: 14 } as const,
  modeHint: { fontSize: 12, color: "#64748b", marginTop: 4, lineHeight: 1.5 } as const,
  file: { padding: 8, border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "inherit" } as const,
  textarea: {
    width: "100%", padding: 12, fontFamily: "ui-monospace, monospace",
    fontSize: 12, border: "1px solid #cbd5e1", borderRadius: 8, direction: "ltr" as const,
    resize: "vertical" as const, boxSizing: "border-box" as const,
  } as const,
  muted: { fontSize: 12, color: "#94a3b8" } as const,
  btnPrimary: {
    padding: "10px 20px", background: "#0ea5e9", color: "#fff",
    border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 14,
    fontFamily: "inherit",
  } as const,
  btnApply: {
    padding: "10px 20px", background: "#16a34a", color: "#fff",
    border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 14,
    fontFamily: "inherit",
  } as const,
  btnGhost: {
    padding: "8px 14px", background: "#fff", color: "#0ea5e9",
    border: "1px solid #bae6fd", borderRadius: 8, cursor: "pointer",
    fontFamily: "inherit", fontSize: 13, fontWeight: 600,
  } as const,
  ok: { padding: 10, background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", borderRadius: 8, fontSize: 13 } as const,
  err: { padding: 10, background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 8, fontSize: 13 } as const,
  previewBox: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 12 } as const,
  summary: { display: "flex", gap: 8, padding: "8px 4px", flexWrap: "wrap" as const } as const,
  chipOk: { padding: "4px 12px", background: "#dcfce7", color: "#166534", borderRadius: 999, fontSize: 12, fontWeight: 700 } as const,
  chipNew: { padding: "4px 12px", background: "#dbeafe", color: "#1e40af", borderRadius: 999, fontSize: 12, fontWeight: 700 } as const,
  chipSkip: { padding: "4px 12px", background: "#fef3c7", color: "#92400e", borderRadius: 999, fontSize: 12, fontWeight: 700 } as const,
  chipTotal: { padding: "4px 12px", background: "#f1f5f9", color: "#334155", borderRadius: 999, fontSize: 12, fontWeight: 700 } as const,
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 12 } as const,
  th: { padding: "8px 10px", background: "#f8fafc", textAlign: "right" as const, borderBottom: "1px solid #e2e8f0", fontWeight: 700, color: "#475569" } as const,
  td: { padding: "8px 10px", borderBottom: "1px solid #f1f5f9" } as const,
  tdMono: { padding: "8px 10px", borderBottom: "1px solid #f1f5f9", fontFamily: "ui-monospace, monospace", fontSize: 11 } as const,
  tdNum: { padding: "8px 10px", borderBottom: "1px solid #f1f5f9", textAlign: "left" as const, color: "#64748b" } as const,
  tdNumBold: { padding: "8px 10px", borderBottom: "1px solid #f1f5f9", textAlign: "left" as const, fontWeight: 700, color: "#0f172a" } as const,
  tdMuted: { padding: "8px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 11, color: "#94a3b8" } as const,
  rowOk: { background: "transparent" } as const,
  rowNew: { background: "#eff6ff" } as const,
  rowSkip: { background: "#fffbeb" } as const,
};
