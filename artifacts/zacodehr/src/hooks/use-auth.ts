import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, setToken, setStoredEmployee, clearAuth } from "@/lib/api";
import { useLocation } from "wouter";
import { useToast } from "@/components/ui/use-toast";

export function useLogin() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  return useMutation({
    mutationFn: api.login,
    onSuccess: (data) => {
      setToken(data.token);
      setStoredEmployee(data.employee);
      setLocation("/");
    },
    onError: (err: Error) => {
      toast({
        variant: "destructive",
        title: "فشل تسجيل الدخول",
        description: err.message,
      });
    },
  });
}

export function useLogout() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  return () => {
    clearAuth();
    queryClient.clear();
    setLocation("/login");
  };
}

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
  });
}
