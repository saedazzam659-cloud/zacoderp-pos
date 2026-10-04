import DeckFrame from "@/components/DeckFrame";

export default function OnlineStore() {
  return <DeckFrame number="10" eyebrow="التحصيل" title="واجهة مخصصة لتحصيل العملاء" intro="تُظهر الشاشة قائمة التحصيل مع ملخصات وفلاتر حالة وأدوات بحث، إضافة إلى إجراء إنشاء تحصيل جديد." image="collection.png" imageLabel="قائمة تحصيل العملاء — بيانات توضيحية">
    <p className="text-[2vw] leading-relaxed text-muted">اللقطة المعروضة لا تحتوي سجلات تحصيل فعلية؛ البيانات التجريبية موسومة داخلها بصفر سجلات.</p>
  </DeckFrame>;
}