export default function ContractingProjectScope({ projectId, projectName, projectCode }: {
  projectId: number; projectName: string; projectCode: string;
}) {
  return <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm dark:border-sky-800 dark:bg-sky-950/30" dir="rtl">
    <div>المشروع: <strong>{projectName}</strong> — الكود: <span className="font-mono">{projectCode || `#${projectId}`}</span></div>
    <p className="mt-1 text-xs text-muted-foreground">هذه البنود خاصة بهذا المشروع فقط. تشابه اسم البند في مشروع آخر لا يعني مشاركة كمياته أو تنفيذه.</p>
  </div>;
}