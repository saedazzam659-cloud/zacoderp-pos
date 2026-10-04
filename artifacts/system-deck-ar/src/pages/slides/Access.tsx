import DeckFrame from "@/components/DeckFrame";

export default function Access() {
  return <DeckFrame number="13" eyebrow="ما تغطيه اللقطات" title="نطاق العرض موثّق بصرياً" intro="بدلاً من توسيع الوعود، يقتصر هذا الاستعراض على مسارات الواجهة التي توافرت لها لقطات فعلية.">
    <div className="grid grid-cols-2 gap-x-[4vw] gap-y-[2vh] text-[2vw]">
      <p className="border-b border-[#d4ded9] pb-[1.3vh]"><span className="text-primary">01</span><span className="mr-[1vw] font-semibold">لوحة التحكم والتنقّل</span></p>
      <p className="border-b border-[#d4ded9] pb-[1.3vh]"><span className="text-primary">02</span><span className="mr-[1vw] font-semibold">كتالوج الأصناف</span></p>
      <p className="border-b border-[#d4ded9] pb-[1.3vh]"><span className="text-primary">03</span><span className="mr-[1vw] font-semibold">عرض السعر وفواتير البيع والشراء</span></p>
      <p className="border-b border-[#d4ded9] pb-[1.3vh]"><span className="text-primary">04</span><span className="mr-[1vw] font-semibold">التحصيل وسند القبض</span></p>
      <p className="border-b border-[#d4ded9] pb-[1.3vh]"><span className="text-primary">05</span><span className="mr-[1vw] font-semibold">معايير ميزان المراجعة</span></p>
    </div>
  </DeckFrame>;
}