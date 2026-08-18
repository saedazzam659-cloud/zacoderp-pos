import { useLeaves, usePermissions, useCreateLeave, useCreatePermission } from "@/hooks/use-hr";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Plus, Clock, CalendarDays, FileText } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

const permissionSchema = z.object({
  permissionDate: z.string().min(1, "التاريخ مطلوب"),
  startTime: z.string().min(1, "وقت البداية مطلوب"),
  endTime: z.string().min(1, "وقت النهاية مطلوب"),
  permissionType: z.enum(["personal", "official"], { required_error: "النوع مطلوب" }),
  reason: z.string().min(1, "السبب مطلوب"),
});

const leaveSchema = z.object({
  leaveType: z.string().min(1, "النوع مطلوب"),
  startDate: z.string().min(1, "تاريخ البداية مطلوب"),
  endDate: z.string().min(1, "تاريخ النهاية مطلوب"),
  reason: z.string().min(1, "السبب مطلوب"),
});

export default function Requests() {
  const [openPermission, setOpenPermission] = useState(false);
  const [openLeave, setOpenLeave] = useState(false);
  
  const { data: permissions, isLoading: pLoading } = usePermissions();
  const { data: leaves, isLoading: lLoading } = useLeaves();
  
  const createPermission = useCreatePermission();
  const createLeave = useCreateLeave();

  const pForm = useForm<z.infer<typeof permissionSchema>>({
    resolver: zodResolver(permissionSchema),
    defaultValues: { permissionDate: "", startTime: "", endTime: "", permissionType: "personal", reason: "" },
  });

  const lForm = useForm<z.infer<typeof leaveSchema>>({
    resolver: zodResolver(leaveSchema),
    defaultValues: { leaveType: "", startDate: "", endDate: "", reason: "" },
  });

  const onSubmitPermission = (data: z.infer<typeof permissionSchema>) => {
    createPermission.mutate(data, { onSuccess: () => setOpenPermission(false) });
  };

  const onSubmitLeave = (data: z.infer<typeof leaveSchema>) => {
    createLeave.mutate(data, { onSuccess: () => setOpenLeave(false) });
  };

  const StatusBadge = ({ status }: { status: string }) => {
    const s = {
      pending: { label: "معلق", color: "bg-orange-100 text-orange-700 border-orange-200" },
      approved: { label: "معتمد", color: "bg-green-100 text-green-700 border-green-200" },
      rejected: { label: "مرفوض", color: "bg-red-100 text-red-700 border-red-200" },
    }[status] || { label: status, color: "bg-gray-100 text-gray-700 border-gray-200" };

    return (
      <span className={`text-[11px] font-medium px-2 py-0.5 rounded border ${s.color}`}>
        {s.label}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <Tabs defaultValue="permissions" className="w-full">
        <TabsList className="grid w-full grid-cols-2 mb-6 bg-muted/50 p-1 rounded-2xl h-14">
          <TabsTrigger value="permissions" className="rounded-xl font-bold text-base h-full">الاستئذان</TabsTrigger>
          <TabsTrigger value="leaves" className="rounded-xl font-bold text-base h-full">الإجازات</TabsTrigger>
        </TabsList>

        <TabsContent value="permissions" className="space-y-4">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold px-1">طلبات الاستئذان</h2>
            <Dialog open={openPermission} onOpenChange={setOpenPermission}>
              <DialogTrigger asChild>
                <Button className="rounded-full shadow-sm gap-2">
                  <Plus className="w-4 h-4" /> طلب جديد
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md p-6">
                <DialogHeader>
                  <DialogTitle>طلب استئذان جديد</DialogTitle>
                </DialogHeader>
                <Form {...pForm}>
                  <form onSubmit={pForm.handleSubmit(onSubmitPermission)} className="space-y-4 pt-4">
                    <FormField control={pForm.control} name="permissionDate" render={({ field }) => (
                      <FormItem><FormLabel>التاريخ</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={pForm.control} name="startTime" render={({ field }) => (
                        <FormItem><FormLabel>من الساعة</FormLabel><FormControl><Input type="time" {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                      <FormField control={pForm.control} name="endTime" render={({ field }) => (
                        <FormItem><FormLabel>إلى الساعة</FormLabel><FormControl><Input type="time" {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                    </div>
                    <FormField control={pForm.control} name="permissionType" render={({ field }) => (
                      <FormItem>
                        <FormLabel>نوع الاستئذان</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl><SelectTrigger><SelectValue placeholder="اختر النوع" /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="personal">شخصي</SelectItem>
                            <SelectItem value="official">عمل رسمي</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={pForm.control} name="reason" render={({ field }) => (
                      <FormItem><FormLabel>السبب</FormLabel><FormControl><Textarea rows={3} {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <Button type="submit" className="w-full mt-2" disabled={createPermission.isPending}>إرسال الطلب</Button>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </div>

          <div className="space-y-3">
            {pLoading ? (
              <Skeleton className="h-32 w-full rounded-2xl" />
            ) : !permissions?.rows?.length ? (
              <div className="bg-card border rounded-2xl p-8 text-center text-muted-foreground flex flex-col items-center">
                <FileText className="w-12 h-12 opacity-20 mb-2" />
                <p>لا توجد طلبات استئذان</p>
              </div>
            ) : (
              permissions.rows.map((req) => (
                <div key={req.id} className="bg-card p-4 rounded-2xl border shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <StatusBadge status={req.status} />
                      <span className="font-semibold text-sm">استئذان {req.permissionType === "personal" ? "شخصي" : "عمل"}</span>
                    </div>
                    <div className="text-sm text-muted-foreground flex flex-wrap gap-x-4 gap-y-2 mt-2">
                      <span className="flex items-center gap-1"><CalendarDays className="w-4 h-4" /> {req.permissionDate}</span>
                      <span className="flex items-center gap-1"><Clock className="w-4 h-4" /> {req.startTime} - {req.endTime}</span>
                      <span className="bg-muted px-2 py-0.5 rounded text-xs">{req.minutes} دقيقة</span>
                    </div>
                    <p className="text-sm mt-3 text-foreground/80 bg-muted/50 p-2 rounded-lg">{req.reason}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="leaves" className="space-y-4">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold px-1">طلبات الإجازات</h2>
            <Dialog open={openLeave} onOpenChange={setOpenLeave}>
              <DialogTrigger asChild>
                <Button className="rounded-full shadow-sm gap-2">
                  <Plus className="w-4 h-4" /> طلب جديد
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md p-6">
                <DialogHeader>
                  <DialogTitle>طلب إجازة جديد</DialogTitle>
                </DialogHeader>
                <Form {...lForm}>
                  <form onSubmit={lForm.handleSubmit(onSubmitLeave)} className="space-y-4 pt-4">
                    <FormField control={lForm.control} name="leaveType" render={({ field }) => (
                      <FormItem>
                        <FormLabel>نوع الإجازة</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl><SelectTrigger><SelectValue placeholder="اختر النوع" /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="annual">سنوية</SelectItem>
                            <SelectItem value="sick">مرضية</SelectItem>
                            <SelectItem value="unpaid">بدون راتب</SelectItem>
                            <SelectItem value="other">أخرى</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={lForm.control} name="startDate" render={({ field }) => (
                        <FormItem><FormLabel>من تاريخ</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                      <FormField control={lForm.control} name="endDate" render={({ field }) => (
                        <FormItem><FormLabel>إلى تاريخ</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                    </div>
                    <FormField control={lForm.control} name="reason" render={({ field }) => (
                      <FormItem><FormLabel>السبب</FormLabel><FormControl><Textarea rows={3} {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <Button type="submit" className="w-full mt-2" disabled={createLeave.isPending}>إرسال الطلب</Button>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </div>

          <div className="space-y-3">
            {lLoading ? (
              <Skeleton className="h-32 w-full rounded-2xl" />
            ) : !leaves?.rows?.length ? (
              <div className="bg-card border rounded-2xl p-8 text-center text-muted-foreground flex flex-col items-center">
                <FileText className="w-12 h-12 opacity-20 mb-2" />
                <p>لا توجد طلبات إجازات</p>
              </div>
            ) : (
              leaves.rows.map((req) => (
                <div key={req.id} className="bg-card p-4 rounded-2xl border shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <StatusBadge status={req.status} />
                      <span className="font-semibold text-sm bg-primary/10 text-primary px-2 py-0.5 rounded">
                        {
                          { annual: "سنوية", sick: "مرضية", unpaid: "بدون راتب", other: "أخرى" }[req.leaveType] || req.leaveType
                        }
                      </span>
                    </div>
                    <div className="text-sm text-muted-foreground flex flex-wrap gap-x-4 gap-y-2 mt-2">
                      <span className="flex items-center gap-1"><CalendarDays className="w-4 h-4" /> {req.startDate} </span>
                      <span className="text-xs">إلى</span>
                      <span className="flex items-center gap-1"><CalendarDays className="w-4 h-4" /> {req.endDate}</span>
                    </div>
                    <p className="text-sm mt-3 text-foreground/80 bg-muted/50 p-2 rounded-lg">{req.reason}</p>
                  </div>
                  <div className="bg-background border rounded-xl p-3 text-center min-w-[80px]">
                    <div className="text-xl font-bold">{req.days}</div>
                    <div className="text-[10px] text-muted-foreground">أيام</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
