import { listItemBrands, type ItemBrandView } from "../lib/brands";
import type { LocalItem } from "../lib/items";
import { calculateBrandNetPrice } from "../lib/brandPricing";
import { uiText, useUiLanguage } from "../lib/appSettings";
import { currencySymbol } from "../lib/currency";
import { fmt, btnSecondary } from "../pages/_adminUi";

export default function BrandPricePicker({ item, onPick, onCancel }: {
  item: LocalItem;
  onPick: (brand: ItemBrandView | null) => void;
  onCancel: () => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const brands = listItemBrands(item.id).filter((brand) => brand.status === "active");
  const choices: Array<{ brand: ItemBrandView | null; name: string; price: number; discountType?: ItemBrandView["discountType"]; discountValue?: number | null }> = [
    { brand: null, name: text("السعر الأساسي للصنف", "Base item price"), price: item.salePrice },
    ...brands.map((brand) => ({
      brand,
      name: language === "en" ? brand.brandNameEn || brand.brandNameAr : brand.brandNameAr,
      price: Number(brand.salePrice1) > 0 ? Number(brand.salePrice1) : item.salePrice,
      discountType: brand.discountType,
      discountValue: brand.discountValue,
    })),
  ];
  return (
    <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}
      style={{ position: "fixed", inset: 0, zIndex: 10020, display: "grid", placeItems: "center", padding: 16, background: "#0f172a75" }}>
      <section role="dialog" aria-modal="true" aria-labelledby="brand-price-picker-title"
        dir={language === "en" ? "ltr" : "rtl"}
        style={{ width: "min(480px,96vw)", maxHeight: "88vh", overflow: "auto", background: "#fff", borderRadius: 14, padding: 20, boxShadow: "0 24px 70px #0f172a40", border: "1px solid #dbe4eb" }}>
        <h3 id="brand-price-picker-title" style={{ margin: "0 0 5px", color: "#183c39" }}>{item.nameAr}</h3>
        <p style={{ margin: "0 0 14px", color: "#64748b", fontSize: 13 }}>{text("اختر العلامة التجارية لتحديد سعر البيع والخصم المناسبين.", "Choose the brand to use its sales price and discount.")}</p>
        <div style={{ display: "grid", gap: 8 }}>
          {choices.map((choice, index) => {
            const net = calculateBrandNetPrice(choice.price, choice.discountType, choice.discountValue);
            const hasDiscount = net < choice.price;
            return (
              <button key={choice.brand?.brandId ?? "base"} type="button" onClick={() => onPick(choice.brand)}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, width: "100%", minHeight: 58, padding: "10px 12px", borderRadius: 10, border: "1px solid #dbe5e7", background: index === 0 ? "#f8fafc" : "#f2fbf8", color: "#233044", font: "inherit", textAlign: "start", cursor: "pointer" }}>
                <span>
                  <strong style={{ display: "block" }}>{choice.name}</strong>
                  {choice.brand?.brandCode && <small style={{ color: "#64748b" }}>{choice.brand.brandCode}</small>}
                </span>
                <span style={{ textAlign: "end", whiteSpace: "nowrap", fontWeight: 800, color: "#087f69" }}>
                  {hasDiscount ? (
                    <>
                      <small style={{ display: "block", textDecoration: "line-through", color: "#94a3b8", fontWeight: 500 }}>{fmt(choice.price)}</small>
                      {fmt(net)} {text("بعد الخصم", "net")}
                    </>
                  ) : <>{fmt(choice.price)} {currencySymbol()}</>}
                </span>
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "end", marginTop: 14 }}>
          <button type="button" onClick={onCancel} style={btnSecondary}>{text("إلغاء", "Cancel")}</button>
        </div>
      </section>
    </div>
  );
}
