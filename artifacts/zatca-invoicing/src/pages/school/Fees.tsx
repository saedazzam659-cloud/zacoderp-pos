import { SchoolCrudPage, type CrudConfig } from "./SchoolCrud";
import { usePermission } from "@/hooks/usePermission";
import { Receipt } from "lucide-react";
import { Link } from "wouter";

const config: CrudConfig = {
  resource: "fees", title: "الرسوم المدرسية", singular: "رسم", description: "سجل تشغيلي للرسوم مع مرجع اختياري إلى فاتورة المبيعات القائمة. التحصيل والترحيل يتمان عبر مسارات ERP الحالية، والمسار الموصى به للفواتير المرتبطة هو سند القبض المتعدد.",
  fields: [
    { key: "enrollmentId", label: "قيد الطالب", type: "relation", resource: "enrollments", required: true },
    { key: "guardianId", label: "ولي الأمر", type: "relation", resource: "guardians", labelKey: "name" },
    { key: "description", label: "وصف الرسم", required: true }, { key: "amount", label: "المبلغ", type: "number", required: true },
    { key: "dueDate", label: "تاريخ الاستحقاق", type: "date" },
    { key: "salesInvoiceId", label: "فاتورة المبيعات المرتبطة", type: "relation", resource: "sales-invoices", labelKey: "docNumber" },
    { key: "status", label: "الحالة", type: "select", options: [["planned", "مستحق"], ["invoiced", "مرتبط بفاتورة"], ["waived", "معفى"]] },
    { key: "notes", label: "ملاحظات", type: "textarea" },
  ],
  columns: [{ key: "description", label: "وصف الرسم" }, { key: "enrollmentId", label: "القيد", type: "relation", resource: "enrollments" }, { key: "amount", label: "المبلغ", type: "number" }, { key: "dueDate", label: "الاستحقاق", type: "date" }, { key: "salesInvoiceId", label: "فاتورة المبيعات", type: "relation", resource: "sales-invoices", labelKey: "docNumber" }, { key: "status", label: "الحالة", type: "status", options: [["planned", "مستحق"], ["invoiced", "مرتبط بفاتورة"], ["waived", "معفى"]] }],
};

export default function Fees() {
  const canCreateReceipt = usePermission("receipt_vouchers", "create");

  return (
    <SchoolCrudPage
      config={config}
      headingExtra={canCreateReceipt ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="school-fee-recommended-collection">
          <span
            className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary"
            data-testid="badge-school-fee-recommended-path"
          >
            المسار الموصى به
          </span>
          <Link
            href="/cash/receipt-vouchers/multi/new"
            className="inline-flex min-h-9 items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            data-testid="link-school-fees-multi-receipt"
          >
            <Receipt className="h-4 w-4" aria-hidden="true" />
            تحصيل بسند قبض متعدد
          </Link>
        </div>
      ) : undefined}
    />
  );
}
