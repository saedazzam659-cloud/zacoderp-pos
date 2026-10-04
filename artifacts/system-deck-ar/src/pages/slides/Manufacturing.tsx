import DeckFrame from "@/components/DeckFrame";

export default function Manufacturing() {
  return <DeckFrame number="08" eyebrow="تفاصيل الفاتورة الظاهرة" title="اختيارات منظمة حول المستند" intro="تُظهر شاشة الفاتورة حقولاً ورؤوس أقسام قابلة للاستعراض قبل الانتقال إلى تفاصيل الأصناف." image="sales-invoice.png" imageLabel="واجهة الفاتورة — لقطة عرض توضيحية">
    <div className="space-y-[1.35vh] text-[2vw] leading-relaxed">
      <p><strong className="text-primary">بيانات أساسية</strong><span className="text-muted"> — الرقم، التاريخ، العميل والفرع.</span></p>
      <p><strong className="text-primary">خيارات المستند</strong><span className="text-muted"> — نوع الفاتورة، الدفع، المستودع، العملة والضريبة.</span></p>
      <p><strong className="text-primary">أقسام إضافية</strong><span className="text-muted"> — تظهر تبويبات الأصناف والمدفوعات والتفاصيل.</span></p>
    </div>
  </DeckFrame>;
}