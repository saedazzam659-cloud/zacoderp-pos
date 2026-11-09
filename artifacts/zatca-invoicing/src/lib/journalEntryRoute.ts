function positiveId(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function resolveJournalEntryRouteIds(input: {
  isNew: boolean;
  routeId: string | null | undefined;
  fromParam: string | null | undefined;
}): { editId: number | null; fromId: number | null; sourceId: number | null } {
  // Wouter's /:id matcher also matches the literal "new" route. The new
  // route must use its ?from=<id> source instead of treating "new" as an id.
  const editId = input.isNew ? null : positiveId(input.routeId);
  const fromId = input.isNew ? positiveId(input.fromParam) : null;
  return { editId, fromId, sourceId: editId ?? fromId };
}
