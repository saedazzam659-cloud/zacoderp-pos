import React from "react";
import { X, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Width = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl" | "6xl" | "7xl" | "full";
const widthMap: Record<Width, string> = {
  sm:  "max-w-sm",
  md:  "max-w-md",
  lg:  "max-w-lg",
  xl:  "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
  "5xl": "max-w-5xl",
  "6xl": "max-w-6xl",
  "7xl": "max-w-7xl",
  "full": "max-w-full",
};

export interface FormPanelProps {
  icon?: React.ElementType;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  width?: Width;
  onClose: () => void;
  onSave?: () => void;
  saving?: boolean;
  saveDisabled?: boolean;
  saveLabel?: string;
  cancelLabel?: string;
  hideFooter?: boolean;
  footer?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

/**
 * Centered, bordered form panel with consistent header + body + footer.
 * Use inside the page to wrap any add/edit inline form.
 *
 * Place fields in a 2-column responsive grid:
 *   <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-4">
 *     <Field label="..."> <Input ... /> </Field>
 *     <Field label="..." className="md:col-span-2"> ... </Field>
 *   </div>
 */
export function FormPanel({
  icon: Icon,
  title,
  subtitle,
  width = "3xl",
  onClose,
  onSave,
  saving,
  saveDisabled,
  saveLabel,
  cancelLabel,
  hideFooter,
  footer,
  className,
  children,
}: FormPanelProps) {
  const { t } = useTranslation();
  const _saveLabel = saveLabel ?? (t("common.save") as string);
  const _cancelLabel = cancelLabel ?? (t("common.cancel") as string);
  const _savingLabel = t("common.loading") as string;
  const _closeLabel = t("common.close") as string;
  return (
    <div className={cn("mx-auto w-full", widthMap[width])}>
      <div className={cn("rounded-xl border bg-card shadow-sm overflow-hidden", className)}>
        <div className="flex items-center justify-between px-6 py-4 border-b bg-muted/30">
          <div className="flex items-center gap-2.5 min-w-0">
            {Icon && (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0">
              <h2 className="font-semibold text-sm sm:text-base text-foreground truncate">{title}</h2>
              {subtitle && <p className="text-xs text-muted-foreground truncate mt-0.5">{subtitle}</p>}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={_closeLabel}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-6">{children}</div>

        {!hideFooter && (
          <div className="flex items-center justify-end gap-2 px-6 py-3.5 border-t bg-muted/20">
            {footer}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onClose}>
              <X className="h-4 w-4" />
              {_cancelLabel}
            </Button>
            {onSave && (
              <Button
                size="sm"
                className="gap-1.5 min-w-[110px]"
                onClick={onSave}
                disabled={saving || saveDisabled}
              >
                <Save className="h-4 w-4" />
                {saving ? _savingLabel : _saveLabel}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Field — uniform label + control wrapper. Use inside a 2-col grid. */
export function Field({
  label,
  required,
  hint,
  className,
  children,
}: {
  label?: React.ReactNode;
  required?: boolean;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <label className="text-xs font-medium text-foreground/80 flex items-center gap-1">
          {label}
          {required && <span className="text-destructive">*</span>}
        </label>
      )}
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** FormGrid — 2-column responsive grid, with consistent gaps. */
export function FormGrid({
  className,
  cols = 2,
  children,
}: {
  className?: string;
  cols?: 1 | 2 | 3 | 4;
  children: React.ReactNode;
}) {
  const colsClass =
    cols === 1 ? "grid-cols-1" :
    cols === 4 ? "grid-cols-2 lg:grid-cols-4" :
    cols === 3 ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3" :
    "grid-cols-1 md:grid-cols-2";
  return (
    <div className={cn("grid gap-x-5 gap-y-4", colsClass, className)}>
      {children}
    </div>
  );
}

/** FormSection — labeled group inside the form. */
export function FormSection({
  title,
  description,
  className,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-4", className)}>
      {(title || description) && (
        <div className="border-b pb-2">
          {title && <h3 className="text-xs font-semibold text-foreground/80 uppercase tracking-wide">{title}</h3>}
          {description && <p className="text-[11px] text-muted-foreground mt-0.5">{description}</p>}
        </div>
      )}
      {children}
    </div>
  );
}
