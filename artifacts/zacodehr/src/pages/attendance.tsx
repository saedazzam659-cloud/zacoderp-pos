import { useState } from "react";
import { useAttendance } from "@/hooks/use-hr";
import { Button } from "@/components/ui/button";
import { ChevronRight, ChevronLeft, Calendar as CalendarIcon, Clock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { format, subMonths, addMonths } from "date-fns";
import { ar } from "date-fns/locale";

export default function Attendance() {
  const [currentDate, setCurrentDate] = useState(new Date());
  
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth() + 1; // JS months are 0-indexed

  const { data, isLoading } = useAttendance(year, month);

  const prevMonth = () => setCurrentDate(subMonths(currentDate, 1));
  const nextMonth = () => setCurrentDate(addMonths(currentDate, 1));

  const getStatusColor = (status: string) => {
    switch (status) {
      case "present": return "bg-green-100 text-green-700 border-green-200";
      case "absent": return "bg-red-100 text-red-700 border-red-200";
      case "late": return "bg-orange-100 text-orange-700 border-orange-200";
      case "leave": return "bg-blue-100 text-blue-700 border-blue-200";
      case "permission": return "bg-purple-100 text-purple-700 border-purple-200";
      default: return "bg-gray-100 text-gray-700 border-gray-200";
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "present": return "حاضر";
      case "absent": return "غائب";
      case "late": return "متأخر";
      case "leave": return "إجازة";
      case "permission": return "استئذان";
      default: return status;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between bg-card p-4 rounded-2xl border shadow-sm">
        <Button variant="ghost" size="icon" onClick={nextMonth} className="h-10 w-10 rounded-full">
          <ChevronRight className="w-5 h-5" />
        </Button>
        <div className="flex items-center gap-2 font-bold text-lg">
          <CalendarIcon className="w-5 h-5 text-primary" />
          {format(currentDate, "MMMM yyyy", { locale: ar })}
        </div>
        <Button variant="ghost" size="icon" onClick={prevMonth} className="h-10 w-10 rounded-full">
          <ChevronLeft className="w-5 h-5" />
        </Button>
      </div>

      <div className="bg-card rounded-2xl border shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="divide-y">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="p-4 flex justify-between items-center">
                <Skeleton className="h-12 w-24" />
                <Skeleton className="h-8 w-20" />
              </div>
            ))}
          </div>
        ) : !data?.rows?.length ? (
          <div className="p-8 text-center text-muted-foreground flex flex-col items-center justify-center gap-3">
            <CalendarIcon className="w-12 h-12 opacity-20" />
            <p>لا توجد سجلات حضور لهذا الشهر</p>
          </div>
        ) : (
          <div className="divide-y">
            {data.rows.map((row, i) => (
              <div key={i} className="p-4 hover:bg-muted/50 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="bg-muted p-2 rounded-xl text-center min-w-[60px]">
                    <div className="text-2xl font-bold leading-none mb-1">
                      {row.date.split("/")[0]}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {/* Assuming date format DD/MM/YYYY */}
                      {format(new Date(row.date.split("/").reverse().join("-")), "EEEE", { locale: ar })}
                    </div>
                  </div>
                  <div>
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${getStatusColor(row.status)}`}>
                      {getStatusLabel(row.status)}
                    </span>
                    {(row.checkIn || row.checkOut) && (
                      <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                        {row.checkIn && (
                          <span className="flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5" /> دخول {row.checkIn}
                          </span>
                        )}
                        {row.checkOut && (
                          <span className="flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5" /> خروج {row.checkOut}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                
                <div className="flex items-center gap-4 text-sm sm:text-end bg-background sm:bg-transparent p-3 sm:p-0 rounded-xl border sm:border-none">
                  {row.lateMinutes > 0 && (
                    <div className="text-orange-600 flex-1 sm:flex-none">
                      <span className="block text-[10px] text-muted-foreground sm:hidden mb-1">التأخير</span>
                      <span className="font-semibold">{row.lateMinutes}</span> دقيقة
                    </div>
                  )}
                  {row.workedHours && (
                    <div className="font-medium flex-1 sm:flex-none">
                      <span className="block text-[10px] text-muted-foreground sm:hidden mb-1">ساعات العمل</span>
                      {row.workedHours}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
