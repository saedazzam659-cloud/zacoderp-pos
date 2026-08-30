export function postgresErrorField(error: any, field: string): unknown {
  const seen = new Set<any>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current[field] != null) return current[field];
    current = current.cause;
  }
  return undefined;
}

export function isPrimaryKeyCollision(error: any): boolean {
  const code = String(postgresErrorField(error, "code") ?? "");
  const constraint = String(
    postgresErrorField(error, "constraint_name")
      ?? postgresErrorField(error, "constraint")
      ?? "",
  );
  return code === "23505" && constraint.includes("pkey");
}

export function safeWriteErrorMessage(error: any, fallback: string): string {
  const nested = String(postgresErrorField(error?.cause, "message") ?? "");
  const outer = String(error?.message ?? "");
  if (nested) return nested;
  if (outer && !/^Failed query:/i.test(outer)) return outer;
  return fallback;
}