export function boundedOffsetPage(
  total: number,
  requestedPage: number,
  pageSize: number,
  maxOffset = 100_000,
) {
  const fullPageCount = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  const maxPage = Math.floor(maxOffset / pageSize) + 1;
  const pageCount = Math.min(fullPageCount, maxPage);
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const accessibleTotal = Math.min(Math.max(0, total), maxOffset + pageSize);
  return {
    page,
    pageCount,
    accessibleTotal,
    truncated: fullPageCount > maxPage,
  };
}