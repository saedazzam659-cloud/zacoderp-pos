import DeckFrame from "@/components/DeckFrame";

export default function Overview() {
  return <DeckFrame number="02" eyebrow="نقطة البداية" title="نبدأ بما يمكن رؤيته والتحقق منه" intro="هذه النسخة تعرض أمثلة من واجهات النظام الفعلية. لا تفترض نشاط Graphic Art أو حجمها أو أنظمتها أو احتياجاتها.">
    <div className="grid grid-cols-2 gap-[1.2vw]">
      <div className="bg-[#e6ede9] p-[2vw]"><span className="text-[1.5vw] font-bold text-primary">المعروض هنا</span><p className="mt-[1vh] text-[2vw] font-semibold leading-relaxed">شاشات فعلية لمسارات المستندات والأصناف والتحصيل والتقارير.</p></div>
      <div className="bg-[#f0e9e1] p-[2vw]"><span className="text-[1.5vw] font-bold text-[#965b39]">ما لم يُحسم بعد</span><p className="mt-[1vh] text-[2vw] font-semibold leading-relaxed">ملاءمة الوظائف، تفاصيل النطاق، والبيانات التي ستُستخدم عند التطبيق.</p></div>
    </div>
  </DeckFrame>;
}