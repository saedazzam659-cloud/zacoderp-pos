import DeckFrame from "@/components/DeckFrame";

export default function Accounting() {
  return <DeckFrame number="04" eyebrow="المشتريات" title="حقول الفاتورة في شاشة واحدة" intro="تُظهر الشاشة حقول رأس فاتورة الشراء، واختيارات المورد والفرع والمستودع، إلى جانب التبويبات الظاهرة للمستند." image="purchasing.png" imageLabel="واجهة فاتورة مشتريات جديدة">
    <p className="text-[2vw] leading-relaxed">مثال بصري على تنظيم إدخال بيانات المستند. تفاصيل المطابقة مع دورة الشراء الفعلية لدى Graphic Art تحتاج إلى استيضاح.</p>
  </DeckFrame>;
}