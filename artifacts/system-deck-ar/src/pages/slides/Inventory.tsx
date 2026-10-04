import DeckFrame from "@/components/DeckFrame";

export default function Inventory() {
  return <DeckFrame number="07" eyebrow="فاتورة المبيعات" title="شاشة فعلية بمساحة تستحق الاستعراض" intro="في الواجهة يظهر اختيار نوع الفاتورة، ثم حقول بياناتها الأساسية وخيارات الدفع والمستودع والفرع والضريبة." image="sales-invoice.png" imageLabel="شاشة فاتورة مبيعات جديدة — بيانات توضيحية">
    <p className="text-[2vw] leading-relaxed">لقطة النظام الأصلية مع شريط التنقّل ومحتوى الشاشة كما هو، بلا طبقات تغطي الواجهة.</p>
  </DeckFrame>;
}