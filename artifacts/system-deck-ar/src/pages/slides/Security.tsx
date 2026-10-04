import DeckFrame from "@/components/DeckFrame";

export default function Security() {
  return <DeckFrame number="11" eyebrow="سند القبض" title="تسجيل المبلغ وطريقة القبض" intro="تظهر الشاشة حقول سند القبض بما فيها الفرع والعملة وسعر الصرف وطريقة الدفع، مع اختيار الخزنة، وتبويبات بيانات السند والعميل والمراجع." image="cash-receipt.png" imageLabel="سند قبض جديد — بيانات توضيحية">
    <p className="text-[2vw] leading-relaxed">هذه ملاحظات على عناصر واجهة ظاهرة فقط؛ لا تمثل إعداداً أو ممارسة لدى Graphic Art.</p>
  </DeckFrame>;
}