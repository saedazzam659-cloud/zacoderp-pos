import * as React from "react";
import { ChevronsLeft, ChevronsRight, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const PAGE_SIZE_OPTIONS = [10, 50, 100, 500, 1000] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 10;

export interface UsePaginationResult<T> {
  page: number;
  pageSize: PageSize;
  setPage: (p: number) => void;
  setPageSize: (s: PageSize) => void;
  pageCount: number;
  total: number;
  pagedItems: T[];
  reset: () => void;
}

export function usePagination<T>(
  items: T[],
  initialPageSize: PageSize = DEFAULT_PAGE_SIZE,
): UsePaginationResult<T> {
  const [page, setPageRaw] = React.useState(1);
  const [pageSize, setPageSizeRaw] = React.useState<PageSize>(initialPageSize);

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  React.useEffect(() => {
    setPageRaw(1);
  }, [total]);

  React.useEffect(() => {
    if (page > pageCount) setPageRaw(pageCount);
  }, [page, pageCount]);

  const pagedItems = React.useMemo(() => {
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);

  const setPage = React.useCallback(
    (p: number) => setPageRaw(Math.min(Math.max(1, p), pageCount)),
    [pageCount],
  );
  const setPageSize = React.useCallback((s: PageSize) => {
    setPageSizeRaw(s);
    setPageRaw(1);
  }, []);
  const reset = React.useCallback(() => {
    setPageRaw(1);
  }, []);

  return { page, pageSize, setPage, setPageSize, pageCount, total, pagedItems, reset };
}

interface TablePaginationProps {
  page: number;
  pageSize: PageSize;
  pageCount: number;
  total: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (s: PageSize) => void;
  className?: string;
  itemLabel?: string;
}

export function TablePagination({
  page,
  pageSize,
  pageCount,
  total,
  onPageChange,
  onPageSizeChange,
  className,
  itemLabel,
}: TablePaginationProps) {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language?.startsWith("ar");
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  const PrevIcon = isRtl ? ChevronRight : ChevronLeft;
  const NextIcon = isRtl ? ChevronLeft : ChevronRight;
  const FirstIcon = isRtl ? ChevronsRight : ChevronsLeft;
  const LastIcon = isRtl ? ChevronsLeft : ChevronsRight;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span>{t("pagination.rowsPerPage")}</span>
        <Select
          value={String(pageSize)}
          onValueChange={(v) => onPageSizeChange(Number(v) as PageSize)}
        >
          <SelectTrigger className="h-8 w-20 text-xs" dir={isRtl ? "rtl" : "ltr"}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((opt) => (
              <SelectItem key={opt} value={String(opt)} className="text-xs">
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="hidden sm:inline">
          {t("pagination.showingRange", {
            start,
            end,
            total,
            label: itemLabel ?? t("pagination.itemDefault"),
          })}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <span className="me-2 hidden md:inline">
          {t("pagination.pageOf", { page, pageCount })}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(1)}
          disabled={page <= 1}
          title={t("pagination.first")}
        >
          <FirstIcon className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          title={t("pagination.previous")}
        >
          <PrevIcon className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
          title={t("pagination.next")}
        >
          <NextIcon className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(pageCount)}
          disabled={page >= pageCount}
          title={t("pagination.last")}
        >
          <LastIcon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
