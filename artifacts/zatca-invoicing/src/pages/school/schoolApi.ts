import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";

export type Row = Record<string, any> & { id: number; companyId?: number };
export type PageResult<T> = { items: T[]; total: number; page: number; pageSize: number };
export const SCHOOL_API = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/school`;

export function useSchoolContext() {
  const { user, token } = useAuth();
  return { companyId: user?.companyId ?? null, token };
}

async function request<T>(path: string, token: string | null, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SCHOOL_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token ?? ""}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || body.message || "تعذر إكمال الطلب");
  }
  return response.json();
}

export function useSchoolList<T extends Row>(resource: string, params: Record<string, string | number | undefined> = {}) {
  const { companyId, token } = useSchoolContext();
  const query = new URLSearchParams({ companyId: String(companyId ?? ""), page: String(params.page ?? 1), limit: String(params.limit ?? 20), ...Object.fromEntries(Object.entries(params).filter(([k, v]) => k !== "page" && k !== "limit" && v !== undefined).map(([k, v]) => [k, String(v)])) });
  return useQuery<PageResult<T>>({
    queryKey: ["school", companyId, resource, params],
    queryFn: () => request<PageResult<T>>(`/${resource}?${query}`, token),
    enabled: !!companyId && !!token,
    staleTime: 15_000,
  });
}

export function useSchoolLists<T extends Row>(resources: string[], params: Record<string, string | number | undefined> = {}) {
  const { companyId, token } = useSchoolContext();
  return useQueries({
    queries: resources.map(resource => {
      const query = new URLSearchParams({
        companyId: String(companyId ?? ""),
        page: String(params.page ?? 1),
        limit: String(params.limit ?? 100),
        ...Object.fromEntries(Object.entries(params)
          .filter(([key, value]) => key !== "page" && key !== "limit" && value !== undefined)
          .map(([key, value]) => [key, String(value)])),
      });
      return {
        queryKey: ["school", companyId, resource, params],
        queryFn: () => request<PageResult<T>>(`/${resource}?${query}`, token),
        enabled: !!companyId && !!token,
        staleTime: 15_000,
      };
    }),
  });
}

export function useSchoolDashboard() {
  const { companyId, token } = useSchoolContext();
  return useQuery<any>({
    queryKey: ["school", companyId, "dashboard"],
    queryFn: () => request(`/dashboard?companyId=${companyId}`, token),
    enabled: !!companyId && !!token,
    refetchInterval: 60_000,
  });
}

export function useSchoolCrud(resource: string) {
  const qc = useQueryClient();
  const { companyId, token } = useSchoolContext();
  const refresh = () => qc.invalidateQueries({ queryKey: ["school", companyId] });
  const save = useMutation({
    mutationFn: (args: { id?: number; body: Record<string, any> }) =>
      request<Row>(args.id ? `/${resource}/${args.id}` : `/${resource}`, token, {
        method: args.id ? "PUT" : "POST",
        body: JSON.stringify({ ...args.body, companyId }),
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) => request<{ ok: true }>(`/${resource}/${id}?companyId=${companyId}`, token, { method: "DELETE" }),
    onSuccess: refresh,
  });
  return { save, remove };
}

export function useSchoolBulkAttendance() {
  const qc = useQueryClient();
  const { companyId, token } = useSchoolContext();
  return useMutation({
    mutationFn: (body: { attendanceDate: string; period: string; records: { enrollmentId: number; status: string; note?: string }[] }) =>
      request<{ saved: number }>("/attendance/bulk", token, { method: "POST", body: JSON.stringify({ ...body, companyId }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["school", companyId] }),
  });
}
