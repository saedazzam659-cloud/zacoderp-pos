import ExportButtons from "@/components/ExportButtons";
import type { ExportColumn, ExportExtraSection } from "@/lib/export";

export default function SchoolExportMenu({
  rows,
  columns,
  filename,
  title,
  subtitle,
  label = "تصدير",
  disabled = false,
  loadRows,
  extraSections,
}: {
  rows: Record<string, unknown>[];
  columns: ExportColumn[];
  filename: string;
  title: string;
  subtitle?: string;
  label?: string;
  disabled?: boolean;
  loadRows?: () => Promise<Record<string, unknown>[]>;
  extraSections?: ExportExtraSection[];
}) {
  return <ExportButtons
    rows={rows}
    loadRows={loadRows}
    columns={columns}
    filename={filename}
    title={title}
    subtitle={subtitle}
    label={label}
    disabled={disabled}
    size="sm"
    extraSections={extraSections}
    showWordButton
  />;
}
