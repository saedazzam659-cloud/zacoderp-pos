import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

export function usePunch() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: api.punch,
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["me"] });
      queryClient.invalidateQueries({ queryKey: ["attendance"] });
      
      const actionName = variables.type === "in" ? "تسجيل الحضور" : "تسجيل الانصراف";
      toast({
        title: "تمت العملية بنجاح",
        description: `تم ${actionName} الساعة ${data.time}`,
      });
    },
    onError: (err: Error) => {
      toast({
        variant: "destructive",
        title: "خطأ في تسجيل البصمة",
        description: err.message,
      });
    },
  });
}

export function useAttendance(year: number, month: number) {
  return useQuery({
    queryKey: ["attendance", year, month],
    queryFn: () => api.getAttendance(year, month),
  });
}

export function usePermissions() {
  return useQuery({
    queryKey: ["permissions"],
    queryFn: api.getPermissions,
  });
}

export function useCreatePermission() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: api.createPermission,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["permissions"] });
      toast({ title: "تم إرسال طلب الاستئذان بنجاح" });
    },
    onError: (err: Error) => {
      toast({
        variant: "destructive",
        title: "فشل إرسال الطلب",
        description: err.message,
      });
    },
  });
}

export function useLeaves() {
  return useQuery({
    queryKey: ["leaves"],
    queryFn: api.getLeaves,
  });
}

export function useCreateLeave() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: api.createLeave,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leaves"] });
      toast({ title: "تم إرسال طلب الإجازة بنجاح" });
    },
    onError: (err: Error) => {
      toast({
        variant: "destructive",
        title: "فشل إرسال الطلب",
        description: err.message,
      });
    },
  });
}

export function usePayslips() {
  return useQuery({
    queryKey: ["payslips"],
    queryFn: api.getPayslips,
  });
}
