import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import ContractingExecutionTable from "./ContractingExecutionTable";
import { executionInputs, type ExecutionInputs, type ExecutionLine } from "@/lib/contractingExecution";

const API = import.meta.env.VITE_API_URL || "";
export type DraftExecutionState = { scope: string; loading: boolean; error: string | null; lines: ExecutionLine[]; values: ExecutionInputs };
export const emptyDraftExecution: DraftExecutionState = { scope: "", loading: false, error: null, lines: [], values: {} };
export const draftExecutionScope = (projectId: number, direction: string, contractId: number | null, date: string) => `${projectId}:${direction}:${contractId}:${date}`;

export default function ContractingDraftExecution({ projectId, direction, contractId, date, state, onChange, disabled }: {
  projectId: number; direction: "outgoing" | "incoming"; contractId: number | null; date: string;
  state: DraftExecutionState; onChange: (state: DraftExecutionState) => void; disabled?: boolean;
}) {
  const { token } = useAuth() as any;
  const [reload, setReload] = useState(0);
  const scope = draftExecutionScope(projectId, direction, contractId, date);
  useEffect(() => {
    if (!contractId || !date || !token) return;
    const abort = new AbortController();
    onChange({ ...emptyDraftExecution, scope, loading: true });
    const query = new URLSearchParams({ direction, billDate: date, [direction === "incoming" ? "subcontractorContractId" : "ownerContractId"]: String(contractId) });
    void fetch(`${API}/api/contracting/projects/${projectId}/certification-preview?${query}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: abort.signal,
    }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "تعذر تحميل بنود العقد");
      if (!Array.isArray(data.lines)) throw Error("استجابة بنود العقد غير صحيحة");
      if (!abort.signal.aborted) onChange({ scope, loading: false, error: null, lines: data.lines, values: executionInputs(data.lines) });
    }).catch(error => {
      if (!abort.signal.aborted) onChange({ ...emptyDraftExecution, scope, error: error.message });
    });
    return () => abort.abort();
  }, [scope, token, reload, projectId, direction, contractId, date, onChange]);
  if (!contractId || !date) return <p className="rounded border p-4 text-sm text-muted-foreground">اختر العقد والتاريخ لتحميل بنود التنفيذ.</p>;
  if (state.scope !== scope || state.loading) return <p className="rounded border p-4 text-sm">جارٍ تحميل كمية العقد والتنفيذ السابق ورصيد الاعتماد المعلّق…</p>;
  if (state.error) return <div role="alert" className="rounded border border-red-200 p-4 text-sm text-red-700">{state.error}<Button className="mx-3" size="sm" variant="outline" onClick={() => setReload(value => value + 1)}>إعادة التحميل</Button></div>;
  return <section className="space-y-3">
    <h5 className="font-semibold">بنود العقد — التنفيذ والاعتماد للصرف</h5>
    <ContractingExecutionTable rows={state.lines} values={state.values} disabled={disabled} onChange={values => onChange({ ...state, values })} />
  </section>;
}