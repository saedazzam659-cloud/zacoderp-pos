import ts from "typescript";
import type { Plugin } from "vite";

const UI_ATTRIBUTE_NAMES = new Set(["title", "placeholder", "aria-label", "alt"]);
const SKIP_TEXT_TAGS = new Set(["code", "pre", "script", "style", "textarea"]);
const ARABIC_TEXT = /[\u0600-\u06ff]/;

function normalizeJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let result = "";
  let previousLineHadText = false;

  lines.forEach((sourceLine, index) => {
    let line = sourceLine.replace(/\t/g, " ");
    if (index > 0) line = line.replace(/^\s+/, "");
    if (index < lines.length - 1) line = line.replace(/\s+$/, "");
    if (!line) return;
    if (previousLineHadText) result += " ";
    result += line;
    previousLineHadText = true;
  });

  return result;
}

function inSkippedTextElement(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isJsxElement(current)) {
      const tag = current.openingElement.tagName;
      if (ts.isIdentifier(tag) && SKIP_TEXT_TAGS.has(tag.text.toLowerCase())) return true;
    } else if (ts.isJsxSelfClosingElement(current)) {
      const tag = current.tagName;
      if (ts.isIdentifier(tag) && SKIP_TEXT_TAGS.has(tag.text.toLowerCase())) return true;
    }
  }
  return false;
}

function importInsertionPoint(source: ts.SourceFile): number {
  let point = 0;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      point = statement.end;
      continue;
    }
    if (
      ts.isExpressionStatement(statement)
      && ts.isStringLiteral(statement.expression)
      && point === 0
    ) {
      point = statement.end;
      continue;
    }
    break;
  }
  return point;
}

/**
 * Localizes compile-time Arabic UI literals only. Dynamic JSX expressions,
 * record values, and input values are not rewritten or inspected.
 */
export function staticUiLocalizationPlugin(): Plugin {
  return {
    name: "zatca-static-ui-localization",
    enforce: "pre",
    transform(code, id) {
      const normalizedId = id.replace(/\\/g, "/").split("?")[0];
      if (!normalizedId.includes("/src/") || !/\.[jt]sx$/.test(normalizedId)) return null;
      if (!ARABIC_TEXT.test(code)) return null;

      const scriptKind = normalizedId.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
      const source = ts.createSourceFile(normalizedId, code, ts.ScriptTarget.Latest, true, scriptKind);
      const edits: Array<{ start: number; end: number; text: string }> = [];
      let needsLocalizedTextImport = false;
      let needsLocalizeFunctionImport = false;

      const jsxComponent = (value: string) => `<LocalizedText value={${JSON.stringify(value)}} />`;
      const jsxExpression = (value: string) => `{localizeUiText(${JSON.stringify(value)})}`;
      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node) && !inSkippedTextElement(node)) {
          const raw = node.getText(source);
          // Leave entities alone: JSX decodes them before rendering, whereas a
          // JavaScript string expression would not.
          if (ARABIC_TEXT.test(raw) && !raw.includes("&")) {
            const value = normalizeJsxText(raw);
            if (value) {
              edits.push({ start: node.getStart(source), end: node.end, text: jsxComponent(value) });
              needsLocalizedTextImport = true;
            }
          }
        }

        if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && UI_ATTRIBUTE_NAMES.has(node.name.text)) {
          const initializer = node.initializer;
          if (initializer && ts.isStringLiteral(initializer) && ARABIC_TEXT.test(initializer.text) && !initializer.text.includes("&")) {
            edits.push({
              start: initializer.getStart(source),
              end: initializer.end,
              text: jsxExpression(initializer.text),
            });
            needsLocalizeFunctionImport = true;
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(source);
      if (edits.length === 0) return null;

      let output = code;
      edits.sort((a, b) => b.start - a.start);
      for (const edit of edits) {
        output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
      }
      const hasLocalizedTextImport = /import\s*\{[^}]*\bLocalizedText\b[^}]*\}\s*from\s*["']@\/lib\/localizedUiText["']/.test(output);
      const hasLocalizeFunctionImport = /import\s*\{[^}]*\blocalizeUiText\b[^}]*\}\s*from\s*["']@\/lib\/localizedUiText["']/.test(output);
      const imports = [
        needsLocalizedTextImport && !hasLocalizedTextImport ? "LocalizedText" : "",
        needsLocalizeFunctionImport && !hasLocalizeFunctionImport ? "localizeUiText" : "",
      ].filter(Boolean);
      if (imports.length > 0) {
        const point = importInsertionPoint(source);
        output = output.slice(0, point)
          + `\nimport { ${imports.join(", ")} } from "@/lib/localizedUiText";`
          + output.slice(point);
      }

      return { code: output, map: null };
    },
  };
}
