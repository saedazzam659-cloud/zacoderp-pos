import DeckFrame from "@/components/DeckFrame";

export default function Sales() {
  return <DeckFrame number="05" eyebrow="كتالوج الأصناف" title="بحث وتصنيف وجدول أصناف" intro="واجهة الأصناف المعروضة تشمل أدوات بحث وتصنيف وجدولاً يظهر فيه رمز الصنف والاسم والوحدة والتكلفة والبيع والحالة." image="inventory.png" imageLabel="قائمة الأصناف — أسماء وبيانات تجريبية">
    <p className="text-[2vw] leading-relaxed text-muted">الأسماء والأرقام الظاهرة في الصورة أمثلة توضيحية من بيئة العرض، وليست بيانات للعميل.</p>
  </DeckFrame>;
}