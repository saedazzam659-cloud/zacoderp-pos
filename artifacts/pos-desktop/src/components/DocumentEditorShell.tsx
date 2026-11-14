import type { ReactNode } from "react";
import { uiText, useUiLanguage } from "../lib/appSettings";

export type DocumentEditorLayout = "classic" | "quick" | "modern" | "erp";

export interface DocumentEditorShellProps {
  layout: DocumentEditorLayout;
  onLayoutChange: (layout: DocumentEditorLayout) => void;
  label: string;
  helperText: string;
  children: ReactNode;
  /** Optional document-specific accessible name for the selector. */
  selectorAriaLabel?: string;
  /** Optional class for integration with existing document form styles. */
  className?: string;
}

const layoutOptions: { value: DocumentEditorLayout; label: string }[] = [
  { value: "classic", label: "كلاسيكي" },
  { value: "quick", label: "إدخال سريع" },
  { value: "modern", label: "شبكة حديثة" },
  { value: "erp", label: "ERP مكثف" },
];

/**
 * Presentation-only wrapper shared by document editors. The parent owns the
 * persisted preference and all form behavior; children remain mounted as-is.
 */
export function DocumentEditorShell({
  layout,
  onLayoutChange,
  label,
  helperText,
  children,
  selectorAriaLabel,
  className,
}: DocumentEditorShellProps) {
  const language = useUiLanguage();
  return (
    <div
      className={`zdoc-editor-shell${className ? ` ${className}` : ""}`}
      data-layout={layout}
    >
      <style>{documentEditorShellStyles}</style>
      <div className="zdoc-editor-shell__layout-row">
        <label className="zdoc-editor-shell__label" htmlFor="zdoc-editor-layout">
          <span>{label}</span>
          {helperText ? <small>{helperText}</small> : null}
        </label>
        <select
          id="zdoc-editor-layout"
          className="zdoc-editor-shell__select"
          value={layout}
          onChange={(event) =>
            onLayoutChange(event.currentTarget.value as DocumentEditorLayout)
          }
          aria-label={selectorAriaLabel ?? label}
        >
          {layoutOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {uiText(option.label, {
                classic: "Classic",
                quick: "Quick entry",
                modern: "Modern grid",
                erp: "Dense ERP",
              }[option.value], language)}
            </option>
          ))}
        </select>
      </div>
      <div className="zdoc-editor-shell__content">{children}</div>
    </div>
  );
}

export interface DocumentEditorSectionProps {
  children: ReactNode;
  className?: string;
}

/** Optional section frame that inherits the active document layout tokens. */
export function DocumentEditorSection({
  children,
  className,
}: DocumentEditorSectionProps) {
  return (
    <section
      className={`zdoc-editor-section${className ? ` ${className}` : ""}`}
    >
      {children}
    </section>
  );
}

const documentEditorShellStyles = `
  .zdoc-editor-shell {
    --zdoc-accent: #2563eb;
    --zdoc-panel: #f7faff;
    --zdoc-border: #cbd8e8;
    --zdoc-grid: #edf3fb;
    --zdoc-radius: 8px;
    --zdoc-density: 8px;
    display: block;
    width: 100%;
    min-width: 0;
    color: #26354a;
    box-sizing: border-box;
  }
  .zdoc-editor-shell.zdoc-viewport-fit {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .zdoc-editor-shell.zdoc-viewport-fit .zdoc-editor-shell__layout-row {
    flex: 0 0 auto;
    margin: 3px 0 5px;
    padding: 5px 8px;
  }
  .zdoc-editor-shell.zdoc-viewport-fit .zdoc-editor-shell__content {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .zdoc-editor-shell.zdoc-viewport-fit .zdoc-editor-shell__content > .zdoc-editor-section {
    flex: 0 0 auto;
    margin: 3px 0;
    padding: 5px 7px;
  }
  .zdoc-editor-shell.zdoc-viewport-fit .zdoc-editor-shell__content > .zlines-panel {
    display: flex !important;
    flex: 1 1 auto !important;
    flex-direction: column;
    min-height: 90px !important;
    overflow: hidden !important;
  }
  .zdoc-editor-shell.zdoc-viewport-fit .zlines-panel > .zlines-wrap {
    display: block;
    flex: 1 1 auto;
    min-height: 48px;
    max-height: none !important;
    overflow: auto !important;
    overscroll-behavior: contain;
  }
  .zdoc-editor-shell.zdoc-viewport-fit .zdoc-editor-shell__content > [style*="flex-shrink"] {
    flex: 0 0 auto;
  }
  .zdoc-editor-shell *,
  .zdoc-editor-shell *::before,
  .zdoc-editor-shell *::after { box-sizing: border-box; }
  .zdoc-editor-shell[data-layout="quick"] {
    --zdoc-accent: #087f69;
    --zdoc-panel: #f5faf6;
    --zdoc-border: #d5e4d9;
    --zdoc-grid: #e9f3ec;
    --zdoc-radius: 5px;
    --zdoc-density: 6px;
  }
  .zdoc-editor-shell[data-layout="modern"] {
    --zdoc-accent: #c2410c;
    --zdoc-panel: #fff;
    --zdoc-border: #d8dee8;
    --zdoc-grid: #f0f1f2;
    --zdoc-radius: 3px;
    --zdoc-density: 9px;
  }
  .zdoc-editor-shell[data-layout="erp"] {
    --zdoc-accent: #294477;
    --zdoc-panel: #f1f4f8;
    --zdoc-border: #b9c5d6;
    --zdoc-grid: #294477;
    --zdoc-radius: 3px;
    --zdoc-density: 4px;
  }
  .zdoc-editor-shell__layout-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 8px 0 10px;
    padding: 8px 10px;
    border: 1px solid var(--zdoc-border);
    border-radius: var(--zdoc-radius);
    background: var(--zdoc-panel);
  }
  .zdoc-editor-shell__label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: #334155;
    font-size: 12px;
    font-weight: 700;
  }
  .zdoc-editor-shell__label small {
    color: #64748b;
    font-size: 10px;
    font-weight: 500;
  }
  .zdoc-editor-shell__select {
    min-width: 210px;
    max-width: 340px;
    min-height: 34px;
    padding: 4px 9px;
    border: 1px solid var(--zdoc-border);
    border-radius: var(--zdoc-radius);
    background: #fff;
    color: #0f172a;
    font: inherit;
    font-size: 12px;
  }
  .zdoc-editor-shell__select:focus-visible {
    outline: 2px solid var(--zdoc-accent);
    outline-offset: 2px;
  }
  .zdoc-editor-section {
    min-width: 0;
    margin: 10px 0;
    padding: 10px;
    border: 1px solid var(--zdoc-border);
    border-radius: var(--zdoc-radius);
    background: var(--zdoc-panel);
  }
  .zdoc-editor-shell[data-layout="quick"] .zdoc-editor-section {
    padding: 8px;
  }
  .zdoc-editor-shell[data-layout="modern"] .zdoc-editor-section {
    box-shadow: 0 1px 4px #0f172a0c;
  }
  .zdoc-editor-shell[data-layout="erp"] .zdoc-editor-section {
    margin: 7px 0;
    padding: 7px;
  }
  .zdoc-editor-shell .zlines-wrap {
    min-width: 0;
    border-color: var(--zdoc-border);
    max-height: 390px !important;
    overflow-x: auto !important;
    overflow-y: auto !important;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .zdoc-editor-shell .zlines-wrap thead th {
    position: sticky;
    top: 0;
    z-index: 3;
    background: var(--zdoc-grid) !important;
    color: #1e293b !important;
    white-space: nowrap;
  }
  .zdoc-editor-shell[data-layout="erp"] .zlines-wrap thead th {
    color: #fff !important;
    padding: 6px 4px !important;
    font-size: 10px !important;
  }
  .zdoc-editor-shell .zlines-wrap tbody td {
    padding: var(--zdoc-density) 5px !important;
  }
  .zdoc-editor-shell[data-layout="modern"] .zlines-wrap tbody tr:nth-child(odd) td {
    background: #fbfcfd;
  }
  .zdoc-editor-shell[data-layout="erp"] .zlines-wrap .zfield {
    height: 28px !important;
    padding: 3px 4px !important;
    font-size: 11px !important;
  }
  .zdoc-editor-shell .zfield:focus {
    border-color: var(--zdoc-accent) !important;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--zdoc-accent) 20%, transparent) !important;
  }
  .zdoc-editor-shell__content input:focus,
  .zdoc-editor-shell__content select:focus,
  .zdoc-editor-shell__content textarea:focus {
    outline: none;
    border-color: var(--zdoc-accent) !important;
    border-radius: var(--zdoc-radius) !important;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--zdoc-accent) 18%, transparent) !important;
  }
  .zdoc-editor-shell__content table thead th {
    background: var(--zdoc-grid) !important;
    color: #1e293b !important;
  }
  .zdoc-editor-shell[data-layout="erp"] .zdoc-editor-shell__content table thead th {
    color: #fff !important;
  }
  .zdoc-editor-shell .zdoc-form {
    display: block !important;
    height: auto !important;
    min-height: 0 !important;
    overflow: visible !important;
  }
  .zdoc-editor-shell .zlines-panel {
    display: block;
    flex: none !important;
    min-height: 0 !important;
    overflow: visible !important;
  }
  .zdoc-editor-shell__content > h3 {
    margin: 0 0 10px !important;
    padding: 8px 10px;
    border: 1px solid var(--zdoc-border);
    border-inline-start: 4px solid var(--zdoc-accent);
    border-radius: var(--zdoc-radius);
    background: var(--zdoc-panel);
  }
  @media (max-width: 900px) {
    .zdoc-editor-shell__layout-row {
      align-items: stretch;
      flex-direction: column;
    }
    .zdoc-editor-shell__select {
      width: 100%;
      max-width: none;
    }
  }
  @media (max-height: 800px) {
    .zdoc-editor-shell.zdoc-viewport-fit .zdoc-editor-shell__label small { display: none; }
    .zdoc-editor-shell.zdoc-viewport-fit .zdoc-editor-section { margin-block: 2px; padding: 4px 6px; }
  }
  @media (max-width: 700px) {
    .zdoc-editor-shell__layout-row { gap: 8px; }
    .zdoc-editor-section { padding: 8px; }
  }
  @media (max-width: 1100px) {
    .zdoc-editor-shell__content .zdoc-editor-section > div[style*="grid-template-columns"] {
      grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
    }
  }
  @media (max-width: 700px) {
    .zdoc-editor-shell__content .zdoc-editor-section > div[style*="grid-template-columns"] {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    }
  }
`;

export default DocumentEditorShell;
