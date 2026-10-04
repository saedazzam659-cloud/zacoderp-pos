import DeckFrame from "@/components/DeckFrame";

export default function Zatca() {
  return <DeckFrame number="03" eyebrow="استكشاف واجهة النظام" title="نقطة دخول واحدة إلى وحدات ظاهرة" intro="تعرض لقطة لوحة التحكم شريط تنقّل يضم مجموعات مثل المخزون، العملاء والمبيعات، الموردين والمشتريات، النقد والبنوك، والحسابات العامة." image="dashboard.png" imageLabel="لوحة التحكم وشريط التنقّل في لقطة النظام">
    <p className="text-[2vw] leading-relaxed text-muted">تُستخدم هذه الشاشة لتأطير الاستعراض فقط؛ ولا تثبت وجود إعدادات أو بيانات خاصة بـ Graphic Art.</p>
    <div className="mt-[2.2vh] border-t border-[#d5dfda] pt-[1.8vh] text-[1.5vw] text-muted">لقطة العرض تحتوي بيانات توضيحية.</div>
  </DeckFrame>;
}