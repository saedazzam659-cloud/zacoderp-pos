/**
 * Correlate each saved line with its form row without relying on PostgreSQL
 * RETURNING order. Correlation metadata is echoed only, never stored or used
 * as a persisted line identity. All inserts use the caller's transaction.
 */
export async function insertGoodsDocumentLines(
  tx: any,
  table: any,
  mappedLines: any[],
  inputLines: any[],
): Promise<any[]> {
  const saved = [];
  for (let index = 0; index < mappedLines.length; index++) {
    const [row] = await tx.insert(table).values(mappedLines[index]).returning();
    saved.push({
      ...row,
      clientLineId: typeof inputLines[index]?.clientLineId === "string"
        ? inputLines[index].clientLineId : undefined,
    });
  }
  return saved;
}