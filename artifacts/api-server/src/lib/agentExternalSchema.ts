const EXTERNAL_AGENT_FORBIDDEN_ACCELERATION_COLUMNS = [
  "invoice_acceleration_mode",
  "invoice_trial_remaining",
  "invoice_acceleration_last_error",
  "invoice_acceleration_reason",
  "invoice_acceleration_updated_at",
  "invoice_acceleration_generation",
  "invoice_acceleration_baseline",
] as const;

const forbiddenColumn = new RegExp(
  `\\b(?:${EXTERNAL_AGENT_FORBIDDEN_ACCELERATION_COLUMNS.join("|")})\\b`,
  "i",
);

/** Split only at SQL-level delimiters, not inside expressions, literals or comments. */
function splitSqlAt(sql: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escapeString = false;
  let dollar: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") { blockComment = false; i++; }
      continue;
    }
    if (dollar) {
      if (sql.startsWith(dollar, i)) { i += dollar.length - 1; dollar = null; }
      continue;
    }
    if (quote) {
      if (escapeString && ch === "\\") { i++; continue; }
      if (ch === quote) {
        if (next === quote) i++;
        else { quote = null; escapeString = false; }
      }
      continue;
    }
    if (ch === "-" && next === "-") { lineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"') {
      escapeString = ch === "'" && /[eE]/.test(sql[i - 1] ?? "") &&
        (i < 2 || !/[\w]/.test(sql[i - 2]));
      quote = ch;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[a-zA-Z_0-9]*\$/.exec(sql.slice(i))?.[0];
      if (tag) { dollar = tag; i += tag.length - 1; continue; }
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth < 0) throw new Error("رفض تهيئة قاعدة الوكيل: أقواس SQL غير متوازنة");
    }
    if (ch === delimiter && depth === 0) {
      parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  if (depth || quote || dollar || blockComment) {
    throw new Error("رفض تهيئة قاعدة الوكيل: عبارة SQL غير مكتملة");
  }
  parts.push(sql.slice(start));
  return parts;
}

/**
 * Convert a central schema-only pg_dump into an external-agent-safe schema.
 *
 * The telemetry table must already be excluded by pg_dump. Seeing it here is
 * treated as a configuration failure rather than trying to remove a multi-line
 * CREATE TABLE block with fragile text surgery.
 */
export function sanitizeSchemaDumpForExternalAgent(dumpSql: string): string {
  if (/\bagent_invoice_samples\b/i.test(dumpSql)) {
    throw new Error("رفض تهيئة قاعدة الوكيل: تسرّب جدول قياسات مركزي إلى مخطط الوكيل");
  }
  const sql = dumpSql
    .split("\n")
    .filter(line => !line.startsWith("\\"))
    .filter(line => !(/^\s*--/.test(line) && forbiddenColumn.test(line)))
    .join("\n");

  // Removing a pg_dump column by deleting its line leaves a dangling comma
  // when it was the final column (and breaks multiline defaults). Rebuild the
  // top-level CREATE TABLE list instead, retaining all surviving definitions.
  const statements = splitSqlAt(sql, ";");
  const cleaned = statements.map(statement => {
    if (!forbiddenColumn.test(statement)) return statement;
    const prefix = /^(?:\s|--[^\n]*\n)*/.exec(statement)?.[0].length ?? 0;
    const create = /^CREATE TABLE\s+(?:"[^"]+"|[\w]+)(?:\.(?:"[^"]+"|[\w]+))?\s*\(/i.exec(statement.slice(prefix));
    if (create) {
      const open = prefix + create[0].length;
      const close = statement.lastIndexOf(")");
      if (close < open) throw new Error("رفض تهيئة قاعدة الوكيل: تعريف جدول غير مكتمل");
      const entries = splitSqlAt(statement.slice(open, close), ",");
      const kept = entries.filter(entry => {
        if (!forbiddenColumn.test(entry)) return true;
        const name = /^\s*(?:"([^"]+)"|([a-zA-Z_][\w]*))\s+/.exec(entry)?.slice(1).find(Boolean);
        if (!name || !EXTERNAL_AGENT_FORBIDDEN_ACCELERATION_COLUMNS.some(column => column === name.toLowerCase())) {
          throw new Error("رفض تهيئة قاعدة الوكيل: مرجع غير متوقع لعمود تحكم مركزي داخل جدول");
        }
        return false;
      });
      if (!kept.length) throw new Error("رفض تهيئة قاعدة الوكيل: جدول بلا أعمدة بعد تنقية المخطط");
      return statement.slice(0, open) + kept.join(",") + statement.slice(close);
    }
    // A multiline ALTER/INDEX/constraint referencing a removed column must
    // disappear in its entirety; deleting one line leaves invalid SQL.
    if (/^(?:ALTER TABLE|CREATE (?:UNIQUE )?INDEX|COMMENT ON)\b/i.test(statement.slice(prefix))) return "";
    throw new Error("رفض تهيئة قاعدة الوكيل: مرجع غير متوقع لعمود تحكم مركزي");
  }).map((statement, index) => statement ? statement + (index < statements.length - 1 ? ";" : "") : "").join("");
  if (forbiddenColumn.test(cleaned)) throw new Error("رفض تهيئة قاعدة الوكيل: بقي عمود تحكم مركزي");
  return cleaned;
}