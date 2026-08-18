import { usePayslips } from "@/hooks/use-hr";
import { Download, ReceiptText, Calendar } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

export default function Payslips() {
  const { data, isLoading } = usePayslips();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between px-1 mb-2">
        <h2 className="text-2xl font-bold">مسيرات الرواتب</h2>
      </div>

      <div className="space-y-4">
        {isLoading ? (
          <>
            <Skeleton className="h-40 w-full rounded-3xl" />
            <Skeleton className="h-40 w-full rounded-3xl" />
          </>
        ) : !data?.rows?.length ? (
          <div className="bg-card border rounded-3xl p-12 text-center text-muted-foreground flex flex-col items-center">
            <ReceiptText className="w-16 h-16 opacity-20 mb-4" />
            <p className="text-lg">لا توجد مسيرات رواتب متاحة</p>
          </div>
        ) : (
          data.rows.map((slip) => (
            <div key={slip.id} className="bg-card rounded-3xl border shadow-sm overflow-hidden group">
              <div className="p-5 sm:p-6 border-b bg-muted/30 flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-primary/10 text-primary rounded-2xl flex items-center justify-center">
                    <Calendar className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg">راتب شهر {slip.month}</h3>
                    <p className="text-sm text-muted-foreground">{slip.year}</p>
                  </div>
                </div>
                <div className={`px-3 py-1 rounded-full text-xs font-semibold ${
                  slip.status === "paid" ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-700"
                }`}>
                  {slip.status === "paid" ? "مدفوع" : "معلق"}
                </div>
              </div>
              
              <div className="p-5 sm:p-6 grid grid-cols-2 sm:grid-cols-3 gap-6">
                <div>
                  <p className="text-sm text-muted-foreground mb-1">الراتب الأساسي</p>
                  <p className="font-semibold">{slip.grossSalary}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-1">إجمالي الخصميات</p>
                  <p className="font-semibold text-red-600 dir-ltr text-right sm:text-left">{slip.totalDeductions}</p>
                </div>
                <div className="col-span-2 sm:col-span-1 bg-primary/5 p-4 rounded-2xl">
                  <p className="text-sm text-primary mb-1 font-medium">صافي الراتب</p>
                  <p className="text-2xl font-bold text-primary">{slip.netSalary}</p>
                </div>
              </div>
              
              <div className="px-5 sm:px-6 pb-5 sm:pb-6">
                <Button variant="outline" className="w-full sm:w-auto rounded-xl gap-2 h-11 border-dashed group-hover:border-primary/50 group-hover:text-primary transition-colors">
                  <Download className="w-4 h-4" /> تحميل PDF
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
