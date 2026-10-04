import DeckFrame from "@/components/DeckFrame";

export default function SisterCompanies() {
  return <DeckFrame number="09" eyebrow="سياق المستندات" title="الاستعراض دون افتراض ترابط غير مثبت" intro="اللقطات المتاحة توثّق شاشات منفصلة لعروض الأسعار، وفواتير المبيعات، وفواتير المشتريات.">
    <div className="flex items-center gap-[1.1vw]">
      <div className="min-w-0 flex-1 bg-[#e6ede9] p-[1.8vw]"><span className="text-[1.5vw] font-bold text-primary">واجهة موثقة</span><p className="mt-[1vh] text-[2vw] font-bold">عرض سعر</p><p className="mt-[0.7vh] text-[2vw] leading-relaxed text-muted">حقول العرض ظاهرة في لقطة الشاشة.</p></div>
      <span className="text-[2vw] text-[#9ba9a3]">·</span>
      <div className="min-w-0 flex-1 bg-[#e6ede9] p-[1.8vw]"><span className="text-[1.5vw] font-bold text-primary">واجهة موثقة</span><p className="mt-[1vh] text-[2vw] font-bold">فاتورة مبيعات</p><p className="mt-[0.7vh] text-[2vw] leading-relaxed text-muted">نوع الفاتورة وحقولها الأساسية ظاهرة.</p></div>
      <span className="text-[2vw] text-[#9ba9a3]">·</span>
      <div className="min-w-0 flex-1 bg-[#e6ede9] p-[1.8vw]"><span className="text-[1.5vw] font-bold text-primary">واجهة موثقة</span><p className="mt-[1vh] text-[2vw] font-bold">فاتورة مشتريات</p><p className="mt-[0.7vh] text-[2vw] leading-relaxed text-muted">رأس مستند الشراء واختياراته.</p></div>
    </div>
    <p className="mt-[2.4vh] text-[2vw] leading-relaxed text-muted">المخطط أعلاه يجاور الشاشات المعروضة ولا يدّعي تحويل المستندات أو تكاملها تلقائياً.</p>
  </DeckFrame>;
}