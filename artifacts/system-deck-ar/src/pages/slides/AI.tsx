import DeckFrame from "@/components/DeckFrame";

export default function AI() {
  return <DeckFrame number="12" eyebrow="التقارير المحاسبية" title="ميزان مراجعة بمعايير عرض محددة" intro="واجهة التقرير الظاهرة تسمح بعرض اختيارات الفترة والتاريخ والفرع ومركز التكلفة ومستوى الحساب، مع خيار إظهار الحسابات الصفرية." image="accounting.png" imageLabel="معايير تقرير ميزان المراجعة">
    <p className="text-[2vw] leading-relaxed text-muted">الصورة تعرض نموذج المعايير؛ ولا تعرض أرصدة أو نتائج مالية للعميل.</p>
  </DeckFrame>;
}