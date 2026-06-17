// العروض الترويجية (Promotional Offers) — offline management screen.
//
// LIMITATION (also noted in lib/offers.ts): this is management/CRUD only.
// The sale-time matching engine is NOT wired into the offline register —
// pos-desktop has no SalesScreen yet. Offers created here are stored and
// listed; activation/expiry follow the same lifecycle as the web module.
//
// Layout mirrors the web Offers screen: a list with status filter + per-row
// activate/expire/edit/delete, and an inline form with collapsible scope
// cards (customers / items / sales-reps).

import { useEffect, useMemo, useState } from "react";
import {
  listOffers, getOffer, createOffer, updateOffer, setOfferStatus, deleteOffer,
  type OfferRow, type OfferInput, type OfferDiscountType, type OfferStatus, type OfferScope, type OfferItemRow,
} from "../lib/offers";
import { listCustomers, type LocalCustomer } from "../lib/customers";
import { listSalespersons, type Salesperson } from "../lib/salespersons";
import { listItems, type LocalItem } from "../lib/items";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmt, SearchCombobox,
} from "./_adminUi";

const DISCOUNT_TYPES: { value: OfferDiscountType; label: string }[] = [
  { value: "percentage_total", label: "نسبة من الإجمالي %" },
  { value: "fixed_total", label: "مبلغ ثابت من الإجمالي" },
  { value: "buy_x_get_y", label: "اشترِ X واحصل على Y" },
  { value: "line_pricing", label: "تسعير أصناف محددة" },
];

const STATUS_META: Record<OfferStatus, { l: string; c: string }> = {
  draft: { l: "مسودة", c: "#475569" },
  active: { l: "مفعّل", c: "#15803d" },
  expired: { l: "منتهي", c: "#b91c1c" },
};

type StatusFilter = "all" | OfferStatus;

export default function OffersAdmin() {
  const [rows, setRows] = useState<OfferRow[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [editing, setEditing] = useState<OfferRow | "new" | null>(null);
  const [deps, setDeps] = useState<{ customers: LocalCustomer[]; reps: Salesperson[]; items: LocalItem[] } | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try { setRows(await listOffers()); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [customers, reps, items] = await Promise.all([listCustomers(), listSalespersons(true), listItems()]);
      setDeps({ customers, reps, items });
    })();
  }, []);

  const counts = useMemo(() => {
    const c = { all: rows.length, draft: 0, active: 0, expired: 0 };
    for (const o of rows) c[o.status]++;
    return c;
  }, [rows]);

  const shown = useMemo(
    () => (filter === "all" ? rows : rows.filter((o) => o.status === filter)),
    [rows, filter],
  );

  async function activate(id: number) {
    try { await setOfferStatus(id, "active"); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل التفعيل"); }
  }
  async function expire(id: number) {
    try { await setOfferStatus(id, "expired"); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الإيقاف"); }
  }
  async function remove(id: number) {
    if (!confirm("حذف العرض؟")) return;
    try { await deleteOffer(id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الحذف (قد يكون العرض مفعّلاً)"); }
  }
  async function openEdit(o: OfferRow) {
    try { setEditing(await getOffer(o.id)); }
    catch (e: any) { alert(e?.message ?? "تعذّر فتح العرض"); }
  }

  if (editing && deps) {
    return (
      <OfferEditor
        existing={editing === "new" ? null : editing}
        deps={deps}
        onCancel={() => setEditing(null)}
        onDone={() => { setEditing(null); void refresh(); }}
      />
    );
  }

  const chips: { key: StatusFilter; label: string; n: number }[] = [
    { key: "all", label: "الكل", n: counts.all },
    { key: "draft", label: "مسوّدة", n: counts.draft },
    { key: "active", label: "مفعّل", n: counts.active },
    { key: "expired", label: "منتهي", n: counts.expired },
  ];

  return (
    <Page
      title="العروض الترويجية"
      subtitle="إدارة العروض (إنشاء/تفعيل/إيقاف) — تطبيق العروض على نقطة البيع غير مفعّل بعد"
      right={
        <button onClick={() => setEditing("new")} disabled={!deps}
          style={{ ...btnPrimary, opacity: !deps ? 0.5 : 1, cursor: !deps ? "not-allowed" : "pointer" }}>
          + عرض جديد
        </button>
      }
    >
      <Card style={{ padding: 12, marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {chips.map((c) => (
          <button key={c.key} onClick={() => setFilter(c.key)}
            style={{
              ...(filter === c.key ? btnPrimary : btnSecondary),
              padding: "6px 14px",
            }}>
            {c.label} ({fmt(c.n)})
          </button>
        ))}
        <button onClick={() => void refresh()} disabled={loading} style={{ ...btnLink, marginInlineStart: "auto" }}>
          {loading ? "..." : "تحديث"}
        </button>
      </Card>

      <Card>
        {shown.length === 0 ? <Empty text="لا توجد عروض" /> : (
          <Table>
            <thead><tr>
              <Th>الرقم</Th><Th>الاسم</Th><Th>نوع الخصم</Th>
              <Th style={{ textAlign: "left" }}>القيمة</Th>
              <Th style={{ textAlign: "left" }}>الأولوية</Th>
              <Th>الانتهاء</Th><Th>الحالة</Th><Th style={{ width: 120 }}></Th>
            </tr></thead>
            <tbody>
              {shown.map((o) => {
                const dt = DISCOUNT_TYPES.find((d) => d.value === o.discountType)?.label ?? o.discountType;
                const sm = STATUS_META[o.status];
                return (
                  <tr key={o.id}>
                    <Td mono>{o.offerNumber}</Td>
                    <Td>{o.nameAr}</Td>
                    <Td>{dt}</Td>
                    <Td num>{fmt(o.discountValue)}</Td>
                    <Td num>{o.priority}</Td>
                    <Td>{o.expiryDate ?? "—"}</Td>
                    <Td><span style={{ background: sm.c + "20", color: sm.c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{sm.l}</span></Td>
                    <Td>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                        {o.status !== "active" && (
                          <button onClick={() => void activate(o.id)} style={{ ...btnLink, color: "#15803d" }}>تفعيل</button>
                        )}
                        {o.status === "active" && (
                          <button onClick={() => void expire(o.id)} style={{ ...btnLink, color: "#b45309" }}>إيقاف</button>
                        )}
                        {o.status !== "active" && (
                          <button onClick={() => void openEdit(o)} style={btnLink}>تعديل</button>
                        )}
                        <button onClick={() => void remove(o.id)} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

function ScopeCard({ title, scope, onScope, children }: {
  title: string; scope: OfferScope; onScope: (s: OfferScope) => void; children: React.ReactNode;
}) {
  return (
    <Card style={{ padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <b>{title}</b>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => onScope("all")} style={{ ...(scope === "all" ? btnPrimary : btnSecondary), padding: "4px 12px", fontSize: 13 }}>الكل</button>
          <button onClick={() => onScope("specific")} style={{ ...(scope === "specific" ? btnPrimary : btnSecondary), padding: "4px 12px", fontSize: 13 }}>محدد</button>
        </div>
      </div>
      {scope === "specific" && children}
    </Card>
  );
}

function OfferEditor({ existing, deps, onCancel, onDone }: {
  existing: OfferRow | null;
  deps: { customers: LocalCustomer[]; reps: Salesperson[]; items: LocalItem[] };
  onCancel: () => void; onDone: () => void;
}) {
  const [nameAr, setNameAr] = useState(existing?.nameAr ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [discountType, setDiscountType] = useState<OfferDiscountType>(existing?.discountType ?? "percentage_total");
  const [discountValue, setDiscountValue] = useState(String(existing?.discountValue ?? 0));
  const [buyQty, setBuyQty] = useState(String(existing?.buyQty ?? 0));
  const [getQty, setGetQty] = useState(String(existing?.getQty ?? 0));
  const [getDiscountPercent, setGetDiscountPercent] = useState(String(existing?.getDiscountPercent ?? 100));
  const [priority, setPriority] = useState(String(existing?.priority ?? 5));
  const [startDate, setStartDate] = useState(existing?.startDate ?? "");
  const [expiryDate, setExpiryDate] = useState(existing?.expiryDate ?? "");
  const [minPurchase, setMinPurchase] = useState(String(existing?.minPurchase ?? 0));
  const [maxUses, setMaxUses] = useState(existing?.maxUses != null ? String(existing.maxUses) : "");
  const [maxUsesPerCustomer, setMaxUsesPerCustomer] = useState(existing?.maxUsesPerCustomer != null ? String(existing.maxUsesPerCustomer) : "");
  const [stackable, setStackable] = useState(existing?.stackable ?? false);
  const [couponCode, setCouponCode] = useState(existing?.couponCode ?? "");
  const [applyTo, setApplyTo] = useState(existing?.applyTo ?? "all");

  const [customerScope, setCustomerScope] = useState<OfferScope>(existing?.customerScope ?? "all");
  const [salesRepScope, setSalesRepScope] = useState<OfferScope>(existing?.salesRepScope ?? "all");
  const [itemsScope, setItemsScope] = useState<OfferScope>(existing?.itemsScope ?? "all");
  const [customerIds, setCustomerIds] = useState<Set<number>>(new Set(existing?.customerIds ?? []));
  const [salesRepIds, setSalesRepIds] = useState<Set<number>>(new Set(existing?.salesRepIds ?? []));
  const [items, setItems] = useState<OfferItemRow[]>(existing?.items ?? []);

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggle(set: Set<number>, id: number): Set<number> {
    const n = new Set(set);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  }
  function addItem(itemId: number) {
    if (!itemId || items.some((x) => x.itemId === itemId)) return;
    const it = deps.items.find((x) => x.id === itemId);
    setItems((p) => [...p, { itemId, itemName: it?.nameAr ?? null, price: null, discount: null, qty: null }]);
  }
  function setItemField(itemId: number, patch: Partial<OfferItemRow>) {
    setItems((p) => p.map((x) => (x.itemId === itemId ? { ...x, ...patch } : x)));
  }
  function removeItem(itemId: number) { setItems((p) => p.filter((x) => x.itemId !== itemId)); }

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (!nameAr.trim()) { setErr("اسم العرض مطلوب"); setBusy(false); return; }
      const payload: OfferInput = {
        nameAr: nameAr.trim(),
        description: description.trim() || null,
        discountType,
        discountValue: Number(discountValue) || 0,
        buyQty: Number(buyQty) || 0,
        getQty: Number(getQty) || 0,
        getDiscountPercent: Number(getDiscountPercent) || 0,
        priority: Number(priority) || 0,
        startDate: startDate || null,
        expiryDate: expiryDate || null,
        minPurchase: Number(minPurchase) || 0,
        maxUses: maxUses.trim() ? Number(maxUses) : null,
        maxUsesPerCustomer: maxUsesPerCustomer.trim() ? Number(maxUsesPerCustomer) : null,
        stackable,
        couponCode: couponCode.trim() || null,
        applyTo,
        customerScope,
        itemsScope,
        salesRepScope,
        customerIds: customerScope === "specific" ? [...customerIds] : [],
        salesRepIds: salesRepScope === "specific" ? [...salesRepIds] : [],
        items: itemsScope === "specific" ? items : [],
      };
      if (existing) await updateOffer(existing.id, payload);
      else await createOffer(payload);
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  const isBxgy = discountType === "buy_x_get_y";
  const isLinePricing = discountType === "line_pricing";

  return (
    <Page
      title={existing ? `تعديل العرض ${existing.offerNumber}` : "عرض ترويجي جديد"}
      subtitle="املأ بيانات العرض ثم احفظ كمسودة — فعّله لاحقاً من القائمة"
      right={<button onClick={onCancel} style={btnSecondary}>رجوع</button>}
    >
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <b style={{ display: "block", marginBottom: 10 }}>الأساسي</b>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0 10px" }}>
          <Field label="اسم العرض *"><input value={nameAr} onChange={(e) => setNameAr(e.target.value)} style={input} /></Field>
          <Field label="الأولوية"><input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} style={input} /></Field>
          <Field label="القناة">
            <SearchCombobox value={applyTo} onChange={(v) => setApplyTo(String(v))} style={input}
              options={[{ value: "all", label: "الكل" }, { value: "pos", label: "نقطة البيع" }, { value: "sales", label: "المبيعات" }]} />
          </Field>
          <Field label="تاريخ البداية"><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={input} /></Field>
          <Field label="تاريخ الانتهاء"><input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} style={input} /></Field>
          <Field label="قابل للتجميع">
            <SearchCombobox value={stackable ? "1" : "0"} onChange={(v) => setStackable(String(v) === "1")} style={input}
              options={[{ value: "0", label: "لا" }, { value: "1", label: "نعم" }]} />
          </Field>
        </div>
        <Field label="الوصف" style={{ marginTop: 8 }}>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} style={{ ...input, minHeight: 48 }} />
        </Field>
      </Card>

      <Card style={{ padding: 16, marginBottom: 12 }}>
        <b style={{ display: "block", marginBottom: 10 }}>نوع الخصم</b>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0 10px" }}>
          <Field label="آلية الخصم">
            <SearchCombobox value={discountType} onChange={(v) => setDiscountType(v as OfferDiscountType)} style={input}
              options={DISCOUNT_TYPES} />
          </Field>
          {!isBxgy && (
            <Field label="قيمة الخصم"><input type="number" step="0.01" value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} style={input} /></Field>
          )}
          {isBxgy && (
            <>
              <Field label="اشترِ كمية (X)"><input type="number" value={buyQty} onChange={(e) => setBuyQty(e.target.value)} style={input} /></Field>
              <Field label="احصل على كمية (Y)"><input type="number" value={getQty} onChange={(e) => setGetQty(e.target.value)} style={input} /></Field>
              <Field label="نسبة خصم Y %"><input type="number" value={getDiscountPercent} onChange={(e) => setGetDiscountPercent(e.target.value)} style={input} /></Field>
            </>
          )}
        </div>
      </Card>

      <Card style={{ padding: 16, marginBottom: 12 }}>
        <b style={{ display: "block", marginBottom: 10 }}>الاستخدام والكوبون</b>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0 10px" }}>
          <Field label="كود الكوبون"><input value={couponCode} onChange={(e) => setCouponCode(e.target.value)} style={input} placeholder="اختياري" /></Field>
          <Field label="الحد الأدنى للشراء"><input type="number" step="0.01" value={minPurchase} onChange={(e) => setMinPurchase(e.target.value)} style={input} /></Field>
          <Field label="أقصى عدد استخدامات"><input type="number" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} style={input} placeholder="بدون حد" /></Field>
          <Field label="أقصى استخدام للعميل"><input type="number" value={maxUsesPerCustomer} onChange={(e) => setMaxUsesPerCustomer(e.target.value)} style={input} placeholder="بدون حد" /></Field>
        </div>
      </Card>

      <div style={{ display: "grid", gap: 12, marginBottom: 12 }}>
        <ScopeCard title="العملاء" scope={customerScope} onScope={setCustomerScope}>
          <div style={{ maxHeight: 200, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
            {deps.customers.map((c) => (
              <label key={c.id} style={{ display: "flex", gap: 6, fontSize: 13, alignItems: "center" }}>
                <input type="checkbox" checked={customerIds.has(c.id)} onChange={() => setCustomerIds((s) => toggle(s, c.id))} />
                {c.nameAr}
              </label>
            ))}
          </div>
        </ScopeCard>

        <ScopeCard title="مندوبو المبيعات" scope={salesRepScope} onScope={setSalesRepScope}>
          <div style={{ maxHeight: 200, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
            {deps.reps.map((r) => (
              <label key={r.id} style={{ display: "flex", gap: 6, fontSize: 13, alignItems: "center" }}>
                <input type="checkbox" checked={salesRepIds.has(r.id)} onChange={() => setSalesRepIds((s) => toggle(s, r.id))} />
                {r.nameAr}
              </label>
            ))}
          </div>
        </ScopeCard>

        <ScopeCard title="الأصناف" scope={itemsScope} onScope={setItemsScope}>
          <div style={{ marginBottom: 8 }}>
            <SearchCombobox
              value={0}
              onChange={(v) => addItem(Number(v))}
              style={input}
              options={[
                { value: 0, label: "— أضف صنفاً —" },
                ...deps.items.filter((it) => !items.some((x) => x.itemId === it.id)).map((it) => ({ value: it.id, label: it.nameAr })),
              ]}
            />
          </div>
          {items.length > 0 && (
            <Table>
              <thead><tr><Th>الصنف</Th><Th>السعر</Th><Th>الخصم</Th><Th>الكمية</Th><Th></Th></tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.itemId}>
                    <Td>{it.itemName ?? deps.items.find((x) => x.id === it.itemId)?.nameAr ?? `#${it.itemId}`}</Td>
                    <Td><input type="number" step="0.01" value={it.price ?? ""} onChange={(e) => setItemField(it.itemId, { price: e.target.value === "" ? null : Number(e.target.value) })} style={{ ...input, width: 110 }} /></Td>
                    <Td><input type="number" step="0.01" value={it.discount ?? ""} onChange={(e) => setItemField(it.itemId, { discount: e.target.value === "" ? null : Number(e.target.value) })} style={{ ...input, width: 110 }} /></Td>
                    <Td><input type="number" value={it.qty ?? ""} onChange={(e) => setItemField(it.itemId, { qty: e.target.value === "" ? null : Number(e.target.value) })} style={{ ...input, width: 90 }} /></Td>
                    <Td><button onClick={() => removeItem(it.itemId)} type="button" style={{ ...btnLink, color: "#dc2626" }}>×</button></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {isLinePricing && items.length === 0 && (
            <div style={{ fontSize: 13, color: "#b45309" }}>تسعير الأصناف يتطلب إضافة صنف واحد على الأقل.</div>
          )}
        </ScopeCard>
      </div>

      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : "حفظ كمسودة"}</button>
      </Actions>
    </Page>
  );
}
