import { useEffect, useMemo, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  listBrands, listItemBrandLinks, setManyItemBrands,
  type Brand, type BrandDiscountType, type ItemBrandLink,
} from "../lib/brands";
import {
  calculateBrandSalePrice,
  type PriceChangeBasis,
  type PriceChangeDirection,
} from "../lib/brandPricing";
import { listItems, type LocalItem } from "../lib/items";
import { uiText, useUiLanguage } from "../lib/appSettings";
import { currencySymbol } from "../lib/currency";
import { btnPrimary, btnSecondary, Card, Field, fmt, input, Page, SearchCombobox, Table, Td, Th } from "./_adminUi";

const ALL_BRANDS = "all";
type PriceLink = { item: LocalItem; brand: Brand; link: ItemBrandLink };

export default function BulkItemPriceUpdate() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [items, setItems] = useState<LocalItem[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [brandValue, setBrandValue] = useState<string | number>(ALL_BRANDS);
  const [changePrice, setChangePrice] = useState(true);
  const [direction, setDirection] = useState<PriceChangeDirection>("increase");
  const [basis, setBasis] = useState<PriceChangeBasis>("percent");
  const [priceValue, setPriceValue] = useState("");
  const [changeDiscount, setChangeDiscount] = useState(false);
  const [discountType, setDiscountType] = useState<BrandDiscountType>("percent");
  const [discountValue, setDiscountValue] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  async function refresh() {
    const [nextItems, nextBrands] = await Promise.all([listItems(), Promise.resolve(listBrands())]);
    setItems(nextItems);
    setBrands(nextBrands);
    setLoading(false);
  }
  useEffect(() => { void refresh().catch((e) => { setError(String(e)); setLoading(false); }); }, []);
  useDataRefresh(["items", "brands"], () => { void refresh().catch((e) => setError(String(e))); });

  const brandMap = useMemo(() => new Map(brands.map((brand) => [brand.id, brand])), [brands]);
  const links = useMemo<PriceLink[]>(() => items.flatMap((item) =>
    listItemBrandLinks(item.id).flatMap((link) => {
      const brand = brandMap.get(link.brandId);
      if (!brand || brand.status !== "active" || link.status !== "active") return [];
      if (brandValue !== ALL_BRANDS && link.brandId !== Number(brandValue)) return [];
      return [{ item, brand, link }];
    }),
  ), [items, brandMap, brandValue]);
  const amount = Number(priceValue);
  const discountAmount = Number(discountValue);
  const priceValueValid = !changePrice || (priceValue.trim() !== "" && Number.isFinite(amount) && amount >= 0 &&
    (basis !== "percent" || amount < 100 || direction === "increase"));
  const discountValueValid = !changeDiscount || discountType === "none" ||
    (discountValue.trim() !== "" && Number.isFinite(discountAmount) && discountAmount >= 0 &&
      (discountType !== "percent" || discountAmount <= 100));
  const preview = useMemo(() => links.map(({ item, brand, link }) => {
    const oldPrice = Number(link.salePrice1) > 0 ? Number(link.salePrice1) : Number(item.salePrice) || 0;
    const newPrice = changePrice
      ? calculateBrandSalePrice(oldPrice, direction, basis, amount)
      : oldPrice;
    return { item, brand, link, oldPrice, newPrice };
  }), [links, changePrice, direction, basis, amount]);
  const previewPricesValid = !changePrice || preview.every((row) => row.newPrice > 0);

  async function applyChanges() {
    setError("");
    setNotice("");
    if (!changePrice && !changeDiscount) {
      setError(text("اختر تعديل السعر أو تحديث الخصم.", "Choose a price change or a discount update."));
      return;
    }
    if (!priceValueValid) {
      setError(text("أدخل قيمة صحيحة؛ نسبة التخفيض أقل من 100٪، ويجب ألا يصل سعر البيع إلى صفر.", "Enter a valid value. Percentage reductions must be below 100%, and the resulting sales price must remain above zero."));
      return;
    }
    if (!previewPricesValid) {
      setError(text("بعض الأسعار ستصبح صفرًا أو أقل. عدّل قيمة التخفيض حتى يبقى سعر كل صنف أكبر من صفر.", "Some prices would become zero or less. Reduce the adjustment so every sales price stays above zero."));
      return;
    }
    if (!discountValueValid) {
      setError(text("أدخل خصمًا صحيحًا؛ النسبة يجب أن تكون من 0 إلى 100٪.", "Enter a valid discount. Percentages must be from 0 to 100%."));
      return;
    }
    if (!preview.length) {
      setError(text("لا توجد أصناف مرتبطة بعلامة تجارية نشطة ضمن الاختيار.", "No items are linked to an active brand in this selection."));
      return;
    }
    const selectedLabel = brandValue === ALL_BRANDS
      ? text("كل العلامات النشطة", "All active brands")
      : brandMap.get(Number(brandValue))?.nameAr ?? "";
    const confirmText = text(
      `سيتم تحديث ${preview.length} ربط صنف/علامة (${new Set(preview.map((row) => row.item.id)).size} صنف) ضمن «${selectedLabel}». هل تريد المتابعة؟`,
      `This will update ${preview.length} item-brand links (${new Set(preview.map((row) => row.item.id)).size} items) in "${selectedLabel}". Continue?`,
    );
    if (!confirm(confirmText)) return;

    setSaving(true);
    try {
      const grouped = new Map<number, ItemBrandLink[]>();
      for (const row of preview) {
        let nextLinks = grouped.get(row.item.id);
        if (!nextLinks) {
          nextLinks = listItemBrandLinks(row.item.id);
          grouped.set(row.item.id, nextLinks);
        }
        const index = nextLinks.findIndex((link) => link.id === row.link.id);
        if (index < 0) continue;
        const next = { ...nextLinks[index] };
        if (changePrice) next.salePrice1 = row.newPrice;
        if (changeDiscount) {
          next.discountType = discountType;
          next.discountValue = discountType === "none" ? 0 : discountAmount;
        }
        nextLinks[index] = next;
      }
      setManyItemBrands([...grouped].map(([itemId, nextLinks]) => ({ itemId, links: nextLinks })));
      await refresh();
      setNotice(text(
        `تم تحديث ${preview.length} ربط صنف/علامة بنجاح.`,
        `Updated ${preview.length} item-brand links.`,
      ));
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : text("تعذر حفظ التغييرات.", "Could not save the changes."));
    } finally {
      setSaving(false);
    }
  }

  const brandOptions = [
    { value: ALL_BRANDS, label: text("كل العلامات التجارية النشطة", "All active brands") },
    ...brands.filter((brand) => brand.status === "active").map((brand) => ({
      value: brand.id,
      label: `${language === "en" ? brand.nameEn || brand.nameAr : brand.nameAr}${brand.code ? ` (${brand.code})` : ""}`,
    })),
  ];

  return (
    <Page
      title={text("تحديث أسعار وخصومات العلامات التجارية", "Brand Price & Discount Updates")}
      subtitle={text(
        "عدّل أسعار البيع والخصومات لمجموعة أصناف دفعة واحدة، مع مراجعة التغييرات قبل الحفظ.",
        "Bulk-update brand-linked item prices and discounts, with a preview before saving.",
      )}
    >
      <Card style={{ padding: 20, marginBottom: 16, overflow: "visible", borderColor: "#c8e5dc", boxShadow: "0 8px 24px #0f766e0b" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14, alignItems: "end" }}>
          <Field label={text("العلامة التجارية المستهدفة", "Target brand")}>
            <SearchCombobox value={brandValue} onChange={setBrandValue} options={brandOptions} style={input} />
          </Field>
          <div style={{ display: "flex", alignItems: "center", gap: 9, minHeight: 42, padding: "0 10px", border: "1px solid #dce5eb", borderRadius: 8, background: "#f8fafc" }}>
            <input type="checkbox" checked={changePrice} onChange={(e) => setChangePrice(e.target.checked)} id="bulk-change-price" />
            <label htmlFor="bulk-change-price" style={{ fontWeight: 700 }}>{text("تعديل سعر البيع", "Change sales price")}</label>
          </div>
          <Field label={text("نوع التعديل", "Adjustment")}>
            <select value={direction} onChange={(e) => setDirection(e.target.value as PriceChangeDirection)} style={input} disabled={!changePrice}>
              <option value="increase">{text("زيادة السعر", "Increase price")}</option>
              <option value="decrease">{text("تخفيض السعر", "Decrease price")}</option>
            </select>
          </Field>
          <Field label={text("طريقة التعديل", "Adjustment basis")}>
            <select value={basis} onChange={(e) => setBasis(e.target.value as PriceChangeBasis)} style={input} disabled={!changePrice}>
              <option value="percent">{text("نسبة مئوية", "Percentage")}</option>
              <option value="amount">{text("قيمة ثابتة", "Fixed amount")}</option>
            </select>
          </Field>
          <Field label={text(basis === "percent" ? "نسبة التغيير ٪" : `قيمة التغيير (${currencySymbol()})`, basis === "percent" ? "Change percent" : `Change amount (${currencySymbol()})`)}>
            <input type="number" min="0" step="any" value={priceValue} onChange={(e) => setPriceValue(e.target.value)}
              disabled={!changePrice} placeholder="0" style={input} dir="ltr" />
          </Field>
        </div>

        <div style={{ marginTop: 18, padding: 14, borderRadius: 10, border: "1px solid #dbe7f3", background: "#f8fbff" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 9, fontWeight: 800, color: "#243b53" }}>
            <input type="checkbox" checked={changeDiscount} onChange={(e) => setChangeDiscount(e.target.checked)} />
            {text("تحديث خصم البيع للعلامة أيضًا", "Also update this brand’s sales discount")}
          </label>
          <div style={{ margin: "5px 0 12px", color: "#64748b", fontSize: 12 }}>
            {text("الخصم يُحفظ لكل علامة منفصلًا ويُطبّق عند اختيارها في فاتورة البيع. القيمة الثابتة لكل وحدة.", "Discounts are stored per brand and apply when selected on a sales invoice. Fixed amounts apply per unit.")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
            <Field label={text("نوع الخصم", "Discount type")}>
              <select value={discountType} onChange={(e) => setDiscountType(e.target.value as BrandDiscountType)} style={input} disabled={!changeDiscount}>
                <option value="none">{text("بدون خصم / مسح الخصم", "No discount / clear discount")}</option>
                <option value="percent">{text("نسبة مئوية", "Percentage")}</option>
                <option value="amount">{text("قيمة ثابتة لكل وحدة", "Fixed amount per unit")}</option>
              </select>
            </Field>
            <Field label={text(discountType === "percent" ? "نسبة الخصم ٪" : `قيمة الخصم (${currencySymbol()})`, discountType === "percent" ? "Discount percent" : `Discount amount (${currencySymbol()})`)}>
              <input type="number" min="0" step="any" max={discountType === "percent" ? 100 : undefined}
                value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} disabled={!changeDiscount || discountType === "none"}
                placeholder="0" style={input} dir="ltr" />
            </Field>
          </div>
        </div>
        <div style={{ marginTop: 14, padding: "10px 12px", color: "#46635e", background: "#effaf6", border: "1px solid #d1eee4", borderRadius: 8, fontSize: 12, lineHeight: 1.7 }}>
          {text(
            "التعديل يخص سعر البيع الأول للعلامة المختارة فقط. سعر الصنف الأساسي وأسعار البيع الإضافية لا تتغير. اختيار كل العلامات يشمل روابط العلامات النشطة فقط.",
            "Only the selected brand’s first sales price is changed. The base item price and additional sales prices stay unchanged. “All brands” includes active brand links only.",
          )}
        </div>
      </Card>

      {error && <div role="alert" style={{ padding: 11, marginBottom: 12, borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2", color: "#b91c1c" }}>{error}</div>}
      {notice && <div role="status" style={{ padding: 11, marginBottom: 12, borderRadius: 8, border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#166534" }}>{notice}</div>}

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "13px 16px", borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
          <div>
            <strong>{text("معاينة قبل الحفظ", "Review before saving")}</strong>
            <span style={{ marginInlineStart: 10, color: "#64748b", fontSize: 12 }}>{text(`${preview.length} ربط صنف/علامة`, `${preview.length} item-brand links`)}</span>
          </div>
          <button type="button" onClick={() => void applyChanges()} disabled={saving || loading || !preview.length || !priceValueValid || !previewPricesValid || !discountValueValid}
            style={{ ...btnPrimary, background: "#087f69", opacity: saving || loading || !preview.length || !priceValueValid || !previewPricesValid || !discountValueValid ? 0.55 : 1 }}>
            {saving ? text("جارٍ الحفظ…", "Saving…") : text("تأكيد وتطبيق التعديلات", "Confirm and apply changes")}
          </button>
        </div>
        <div style={{ maxHeight: 450, overflow: "auto" }}>
          <Table>
            <thead><tr>
              <Th>{text("كود الصنف", "Item code")}</Th>
              <Th>{text("اسم الصنف", "Item name")}</Th>
              <Th>{text("العلامة التجارية", "Brand")}</Th>
              <Th style={{ textAlign: "left" }}>{text("السعر الحالي", "Current price")}</Th>
              <Th style={{ textAlign: "left" }}>{text("السعر بعد التعديل", "New price")}</Th>
              <Th style={{ textAlign: "left" }}>{text("الخصم الحالي", "Current discount")}</Th>
            </tr></thead>
            <tbody>
              {loading ? <tr><Td colSpan={6} style={{ textAlign: "center", color: "#64748b" }}>{text("جارٍ تحميل الأصناف…", "Loading items…")}</Td></tr>
                : preview.length === 0 ? <tr><Td colSpan={6} style={{ textAlign: "center", color: "#64748b", padding: 30 }}>{text("لا توجد أصناف مرتبطة بالعلامة المختارة.", "No items are linked to the selected brand.")}</Td></tr>
                  : preview.map(({ item, brand, link, oldPrice, newPrice }) => (
                    <tr key={`${item.id}-${link.id}`}>
                      <Td mono>{item.code || "—"}</Td>
                      <Td>{item.nameAr}</Td>
                      <Td>{language === "en" ? brand.nameEn || brand.nameAr : brand.nameAr}</Td>
                      <Td num>{fmt(oldPrice)} {currencySymbol()}</Td>
                      <Td num style={{ fontWeight: 800, color: changePrice && newPrice !== oldPrice ? "#087f69" : undefined }}>{fmt(newPrice)} {currencySymbol()}</Td>
                      <Td>
                        {link.discountType === "percent" ? `${fmt(Number(link.discountValue) || 0)}٪`
                          : link.discountType === "amount" ? `${fmt(Number(link.discountValue) || 0)} ${currencySymbol()}/${text("وحدة", "unit")}`
                            : text("بدون", "None")}
                      </Td>
                    </tr>
                  ))}
            </tbody>
          </Table>
        </div>
      </Card>
    </Page>
  );
}
