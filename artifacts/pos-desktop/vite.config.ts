import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

const isBuild = process.argv.includes("build");
const rawPort = process.env.PORT;

if (!rawPort && !isBuild) {
  throw new Error("PORT environment variable is required for dev server.");
}

const port = rawPort ? Number(rawPort) : 5173;
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? (isBuild ? "/" : undefined);
if (!basePath) {
  throw new Error("BASE_PATH environment variable is required for dev server.");
}

const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const sourceRoot = resolve(projectRoot, "src");
const appSettingsPath = resolve(sourceRoot, "lib/appSettings");
const languageControlPath = resolve(sourceRoot, "components/LanguageControl.tsx");
const enUiTranslations = JSON.parse(
  readFileSync(fileURLToPath(new URL("./localization/en-ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

const nonUiJsxAttributes = new Set([
  "value", "defaultValue", "filenameBase", "nameAr", "nameEn", "code", "id",
  "type", "key", "role", "lang", "href", "src", "htmlFor", "style",
]);
const translatedObjectProperties = new Set([
  "label", "title", "text", "description", "subtitle", "placeholder", "emptyText",
  "emptyMessage", "actionLabel", "tooltip", "header", "message", "name",
  "asset", "liability", "equity", "revenue", "expense", "balance_sheet",
  "open", "closed", "l", "ar", "en", "done", "map", "preview", "excel",
  "pdf", "purchase", "purchase_return", "sale", "sale_return", "adjustment",
  "stocktake", "transfer_in", "transfer_out",
]);
const moduleLevelTranslatedProperties = new Set([
  "label", "title", "description", "subtitle", "emptyText", "emptyMessage",
  "actionLabel", "tooltip", "header", "message", "open", "closed",
  "purchase", "purchase_return", "sale", "sale_return", "adjustment",
  "stocktake", "transfer_in", "transfer_out", "opening",
]);
const translatedMessageCalls = new Set([
  "alert", "confirm", "prompt", "setErr", "setError", "setToast",
  "setActionErr", "setHeartbeatErr", "showToast", "notify", "setOcrNote",
  "errText", "collectDocIssues",
]);

function normalizeUiText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function posDesktopLocalization(): Plugin {
  return {
    name: "pos-desktop-ui-localization",
    enforce: "pre",
    transform(code, id) {
      const sourceId = id.split("?")[0];
      if (
        !sourceId.endsWith(".tsx")
        || !sourceId.startsWith(sourceRoot + sep)
        || resolve(sourceId) === languageControlPath
      ) {
        return null;
      }

      const sourceFile = ts.createSourceFile(
        sourceId,
        code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const edits: Array<{ start: number; end: number; text: string }> = [];
      let needsUiText = false;
      let needsUiTemplate = false;
      let needsLanguage = false;
      const handledLiterals = new Set<ts.StringLiteral | ts.NoSubstitutionTemplateLiteral>();
      const handledTemplates = new Set<ts.TemplateExpression>();

      const localizedCall = (arabic: string): string | null => {
        const key = normalizeUiText(arabic);
        const english = enUiTranslations[key];
        if (!english) return null;
        needsUiText = true;
        return `__posUiText(${JSON.stringify(key)}, ${JSON.stringify(english)})`;
      };
      const editLocalizedLiteral = (
        node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral,
        jsxAttribute = false,
      ) => {
        if (handledLiterals.has(node)) return;
        if (!/[\u0600-\u06ff]/.test(node.text)) return;
        const expression = localizedCall(node.text);
        if (!expression) return;
        handledLiterals.add(node);
        edits.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          text: jsxAttribute ? `{${expression}}` : expression,
        });
      };

      const editLocalizedTemplate = (node: ts.TemplateExpression): boolean => {
        const parts = [node.head.text];
        const values = node.templateSpans.map((span) => {
          parts.push(span.literal.text);
          return span.expression.getText(sourceFile);
        });
        if (!parts.some((part) => /[\u0600-\u06ff]/.test(part))) return false;
        const key = normalizeUiText(parts.map((part, index) =>
          part + (index < values.length ? `{{${index}}}` : ""),
        ).join(""));
        const english = enUiTranslations[key];
        if (!english) return false;
        const expected = [...key.matchAll(/\{\{\d+\}\}/g)].map((match) => match[0]).sort();
        const actual = [...english.matchAll(/\{\{\d+\}\}/g)].map((match) => match[0]).sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual)) return false;
        needsUiTemplate = true;
        handledTemplates.add(node);
        edits.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          text: `__posUiTemplate(${JSON.stringify(parts)}, ${JSON.stringify(english)}, [${values.join(", ")}])`,
        });
        return true;
      };

      const translatePresentationValue = (node: ts.Node): void => {
        if (ts.isTemplateExpression(node)) {
          if (handledTemplates.has(node)) return;
          if (!editLocalizedTemplate(node)) {
            handledTemplates.add(node);
            node.templateSpans.forEach((span) => translatePresentationValue(span.expression));
          }
          return;
        }
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          editLocalizedLiteral(node);
          return;
        }
        if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
          translatePresentationValue(node.expression);
          return;
        }
        if (ts.isConditionalExpression(node)) {
          translatePresentationValue(node.whenTrue);
          translatePresentationValue(node.whenFalse);
          return;
        }
        if (
          ts.isBinaryExpression(node)
          && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken
            || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
            || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        ) {
          translatePresentationValue(node.right);
          return;
        }
        if (ts.isArrayLiteralExpression(node)) {
          node.elements.forEach(translatePresentationValue);
        }
      };

      function visit(node: ts.Node, insideFunction = false, insideBilingualCall = false) {
        const inFunction = insideFunction
          || ts.isFunctionDeclaration(node)
          || ts.isFunctionExpression(node)
          || ts.isArrowFunction(node)
          || ts.isMethodDeclaration(node)
          || ts.isGetAccessor(node)
          || ts.isSetAccessor(node)
          || ts.isConstructorDeclaration(node);
        const callName = ts.isCallExpression(node)
          ? ts.isIdentifier(node.expression)
            ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name.text
              : ""
          : "";
        const inBilingualCall = insideBilingualCall
          || (ts.isCallExpression(node) && (callName === "uiText" || callName === "text"));

        if (ts.isTemplateExpression(node) && handledTemplates.has(node)) return;
        if (inFunction && !inBilingualCall && ts.isTemplateExpression(node)) {
          if (editLocalizedTemplate(node)) return;
          handledTemplates.add(node);
          node.templateSpans.forEach((span) => translatePresentationValue(span.expression));
          return;
        }

        if (inFunction && ts.isJsxText(node) && /[\u0600-\u06ff]/.test(node.getText(sourceFile))) {
          const raw = node.getText(sourceFile);
          const expression = localizedCall(raw);
          if (expression) {
            const inlineText = !/[\r\n]/.test(raw);
            const leading = inlineText && /^[ \t]+/.test(raw) ? " " : "";
            const trailing = inlineText && /[ \t]+$/.test(raw) ? " " : "";
            edits.push({
              start: node.getStart(sourceFile),
              end: node.getEnd(),
              text: `${leading}{${expression}}${trailing}`,
            });
          }
        }

        if (inFunction && ts.isJsxAttribute(node)) {
          const name = node.name.getText(sourceFile);
          const initializer = node.initializer;
          if (name === "dir" && initializer && ts.isStringLiteral(initializer) && initializer.text === "rtl") {
            needsLanguage = true;
            edits.push({
              start: initializer.getStart(sourceFile),
              end: initializer.getEnd(),
              text: '{__posGetUiLanguage() === "en" ? "ltr" : "rtl"}',
            });
          } else if (
            !nonUiJsxAttributes.has(name)
            && !name.startsWith("data-")
            && !name.startsWith("on")
            && initializer
          ) {
            if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
              editLocalizedLiteral(initializer, true);
            } else if (ts.isJsxExpression(initializer) && initializer.expression) {
              translatePresentationValue(initializer.expression);
            }
          }
        }

        if (inFunction && ts.isJsxExpression(node) && node.expression) {
          if (!ts.isJsxAttribute(node.parent)) {
            translatePresentationValue(node.expression);
          }
        }

        if (inFunction && ts.isCallExpression(node)) {
          const callName = ts.isIdentifier(node.expression)
            ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name.text
              : "";
          const first = node.arguments[0];
          const receiver = ts.isPropertyAccessExpression(node.expression)
            ? node.expression.expression
            : null;
          const isDateLocaleMethod = callName === "toLocaleDateString" || callName === "toLocaleTimeString";
          const isDateLocaleString = callName === "toLocaleString"
            && receiver
            && ts.isNewExpression(receiver)
            && ts.isIdentifier(receiver.expression)
            && receiver.expression.text === "Date";
          if (isDateLocaleMethod || isDateLocaleString) {
            if (!first) {
              needsLanguage = true;
              const openParen = node.expression.getEnd();
              edits.push({
                start: openParen,
                end: openParen + 1,
                text: '(__posGetUiLanguage() === "en" ? "en-GB" : "ar-SA"',
              });
            } else if (
              ts.isStringLiteral(first)
              && /^ar(?:-|$)/.test(first.text)
            ) {
              needsLanguage = true;
              edits.push({
                start: first.getStart(sourceFile),
                end: first.getEnd(),
                text: '__posGetUiLanguage() === "en" ? "en-GB" : "ar-SA"',
              });
            }
          }
          if (translatedMessageCalls.has(callName)) {
            if (callName === "collectDocIssues") {
              node.arguments.forEach(translatePresentationValue);
            } else if (first) {
              translatePresentationValue(first);
            }
          }
        }

        if (
          inFunction
          &&
          ts.isNewExpression(node)
          && ts.isIdentifier(node.expression)
          && node.expression.text === "Error"
          && node.arguments[0]
        ) {
          translatePresentationValue(node.arguments[0]);
        }
        if (
          inFunction
          && ts.isNewExpression(node)
          && node.expression.getText(sourceFile) === "Intl.DateTimeFormat"
          && node.arguments[0]
          && ts.isStringLiteral(node.arguments[0])
          && /^ar(?:-|$)/.test(node.arguments[0].text)
        ) {
          needsLanguage = true;
          edits.push({
            start: node.arguments[0].getStart(sourceFile),
            end: node.arguments[0].getEnd(),
            text: '__posGetUiLanguage() === "en" ? "en-GB" : "ar-SA"',
          });
        }

        if (ts.isPropertyAssignment(node)) {
          const key = node.name.getText(sourceFile).replace(/^['"]|['"]$/g, "");
          const initializer = node.initializer;
          if (translatedObjectProperties.has(key)) {
            if (inFunction) {
              translatePresentationValue(initializer);
            } else if (
              moduleLevelTranslatedProperties.has(key)
              &&
              /^[A-Za-z_$][\w$]*$/.test(key)
              && (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
            ) {
              const expression = localizedCall(initializer.text);
              if (expression) {
                edits.push({
                  start: node.getStart(sourceFile),
                  end: node.getEnd(),
                  text: `get ${key}() { return ${expression}; }`,
                });
              }
            }
          }
        }

        ts.forEachChild(node, (child) => visit(child, inFunction, inBilingualCall));
      }
      visit(sourceFile);

      if (edits.length === 0) return null;
      edits.sort((a, b) => b.start - a.start);
      let transformed = code;
      for (const edit of edits) {
        transformed = transformed.slice(0, edit.start) + edit.text + transformed.slice(edit.end);
      }

      const relativeSettings = relative(dirname(sourceId), appSettingsPath).replace(/\\/g, "/");
      const settingsImport = relativeSettings.startsWith(".") ? relativeSettings : `./${relativeSettings}`;
      const names = [
        needsUiText ? "uiText as __posUiText" : "",
        needsUiTemplate ? "uiTemplate as __posUiTemplate" : "",
        needsLanguage ? "getUiLanguage as __posGetUiLanguage" : "",
      ].filter(Boolean).join(", ");
      return {
        code: `import { ${names} } from ${JSON.stringify(settingsImport)};\n${transformed}`,
        map: null,
      };
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [posDesktopLocalization(), react()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  server: {
    host: "0.0.0.0",
    port,
    strictPort: true,
    allowedHosts: true,
    hmr: { clientPort: 443 },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: { target: "es2020", minify: "esbuild", sourcemap: false },
});
