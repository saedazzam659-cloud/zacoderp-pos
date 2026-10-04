import DeckFrame from "@/components/DeckFrame";

export default function WhyZacod() {
  return <DeckFrame number="14" eyebrow="الخطوة التالية المقترحة" title="جلسة استكشاف قبل تحديد الملاءمة" intro="يمكن استخدام جلسة أولية لفهم واقع العمل لدى Graphic Art، ثم مقارنة ما يُحتاج فعلياً بما ظهر في العرض.">
    <div className="grid grid-cols-3 gap-[1.2vw]">
      <div className="bg-[#e6ede9] p-[1.7vw]"><span className="text-[1.5vw] font-bold text-primary">01 — فهم الواقع</span><p className="mt-[1.2vh] text-[2vw] font-semibold leading-relaxed">مراجعة المستندات والخطوات الحالية كما هي.</p></div>
      <div className="bg-[#e6ede9] p-[1.7vw]"><span className="text-[1.5vw] font-bold text-primary">02 — مراجعة الملاءمة</span><p className="mt-[1.2vh] text-[2vw] font-semibold leading-relaxed">التحقق من الحقول والاختيارات المطلوبة فعلياً.</p></div>
      <div className="bg-[#f0e9e1] p-[1.7vw]"><span className="text-[1.5vw] font-bold text-[#965b39]">03 — تحديد النطاق</span><p className="mt-[1.2vh] text-[2vw] font-semibold leading-relaxed">توثيق ما يلزم توضيحه قبل أي تقدير أو التزام.</p></div>
    </div>
    <p className="mt-[2.5vh] text-[2vw] text-muted">لا يتضمن هذا المقترح موعداً أو سعراً أو خطة تنفيذ.</p>
  </DeckFrame>;
}