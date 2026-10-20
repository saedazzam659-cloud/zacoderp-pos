import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Props = {
  documentType: string;
  documentId?: number | null;
  className?: string;
};

export function DocumentApprovalAction({ documentType, documentId, className }: Props) {
  const { token, user, actingCompanyId } = useAuth() as any;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const companyId = actingCompanyId ?? user?.company?.id ?? user?.companyId;
  const key = ["document-approval", documentType, documentId, companyId];
  const { data, isLoading } = useQuery<{
    requiredStages: number;
    approvals: Array<{ id: number; level: number; userId: number | null; createdAt: string }>;
    complete: boolean;
    canApprove: boolean;
    eligible: boolean;
  }>({
    queryKey: key,
    enabled: !!documentId && !!token,
    queryFn: async () => {
      const suffix = companyId ? `?companyId=${companyId}` : "";
      const response = await fetch(`${API}/api/document-approvals/${documentType}/${documentId}${suffix}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "تعذر تحميل حالة التأكيد");
      return payload;
    },
  });
  const approve = useMutation({
    mutationFn: async () => {
      const suffix = companyId ? `?companyId=${companyId}` : "";
      const response = await fetch(`${API}/api/document-approvals/${documentType}/${documentId}/approve${suffix}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "تعذر تأكيد المستند");
      return payload;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
      toast({ title: "تم تسجيل مرحلة التأكيد" });
    },
    onError: (error: Error) => toast({ title: error.message, variant: "destructive" }),
  });

  if (!documentId || isLoading || !data || data.requiredStages <= 0 || !data.eligible) return null;
  const complete = data.complete;
  const completed = complete ? data.requiredStages : data.approvals.length;
  return (
    <div className={className ?? "flex items-center gap-2"}>
      <Badge variant={complete ? "default" : "secondary"} className="gap-1">
        {complete ? <CheckCircle2 className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
        {complete ? "مكتمل" : `التأكيد ${completed}/${data.requiredStages}`}
      </Badge>
      {data.canApprove && !complete && (
        <Button type="button" size="sm" variant="outline" onClick={() => approve.mutate()} disabled={approve.isPending}>
          {approve.isPending ? <Loader2 className="h-4 w-4 me-1 animate-spin" /> : <ShieldCheck className="h-4 w-4 me-1" />}
          تأكيد المرحلة
        </Button>
      )}
    </div>
  );
}
