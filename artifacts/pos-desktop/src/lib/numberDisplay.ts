import { APP_SETTINGS_EVENT, getNumberSystem } from "./appSettings";

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export function convertDisplayedDigits(value: string, system = getNumberSystem()): string {
  return value.replace(/[0-9٠-٩۰-۹]/g, (digit) => {
    if (system === "latin") {
      const code = digit.charCodeAt(0);
      if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
      if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
      return digit;
    }
    const code = digit.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) return digit;
    if (code >= 0x06f0 && code <= 0x06f9) return ARABIC_DIGITS[code - 0x06f0];
    return ARABIC_DIGITS[code - 0x30];
  });
}

function shouldSkipTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return true;
  if (parent.closest("input, textarea, select, script, style, noscript, [contenteditable='true']")) return true;
  return false;
}

function convertTextNode(node: Text, system = getNumberSystem()): void {
  if (shouldSkipTextNode(node)) return;
  const converted = convertDisplayedDigits(node.data, system);
  if (converted !== node.data) node.data = converted;
}

export function applyNumberSystemToDocument(doc: Document, system = getNumberSystem()): void {
  if (!doc.body) return;
  const walker = doc.createTreeWalker(doc.body, 4);
  let node = walker.nextNode();
  while (node) {
    convertTextNode(node as Text, system);
    node = walker.nextNode();
  }
}

export function observeNumberSystem(doc: Document = document): () => void {
  if (!doc.body || !doc.defaultView?.MutationObserver) return () => {};
  const apply = () => applyNumberSystemToDocument(doc);
  apply();
  const observer = new doc.defaultView.MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData" && record.target.nodeType === 3) {
        convertTextNode(record.target as Text);
      }
      for (const added of Array.from(record.addedNodes)) {
        if (added.nodeType === 3) convertTextNode(added as Text);
        else if (added.nodeType === 1) {
          const walker = doc.createTreeWalker(added, 4);
          let node = walker.nextNode();
          while (node) {
            convertTextNode(node as Text);
            node = walker.nextNode();
          }
        }
      }
    }
  });
  observer.observe(doc.body, { subtree: true, childList: true, characterData: true });
  doc.defaultView.addEventListener(APP_SETTINGS_EVENT, apply);
  doc.defaultView.addEventListener("storage", apply);
  return () => {
    observer.disconnect();
    doc.defaultView?.removeEventListener(APP_SETTINGS_EVENT, apply);
    doc.defaultView?.removeEventListener("storage", apply);
  };
}
