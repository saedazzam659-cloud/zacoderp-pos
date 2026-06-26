import { useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import {
  FileText, FolderOpen, Save, FileDown, FilePlus2, Bold, Italic, Underline,
  List, ListOrdered, Heading1, Heading2, Heading3, AlignRight, AlignCenter, AlignLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { openFile, saveFile, printHtml, withExtension, type OpenedFile } from "./fileIo";

const DOCX_ACCEPT = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
};
const TXT_ACCEPT = { "text/plain": [".txt"] };

// Walk a contentEditable DOM tree and build a docx Document.
async function buildDocxBlob(root: HTMLElement, rtl: boolean): Promise<Blob> {
  const docx: any = await import("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = docx;

  const makeRuns = (
    node: Node,
    fmt: { bold?: boolean; italics?: boolean; underline?: boolean },
  ): any[] => {
    const runs: any[] = [];
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? "";
        if (text) {
          runs.push(
            new TextRun({
              text,
              bold: fmt.bold,
              italics: fmt.italics,
              underline: fmt.underline ? {} : undefined,
            }),
          );
        }
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (tag === "br") {
        runs.push(new TextRun({ break: 1 }));
        return;
      }
      const next = { ...fmt };
      const style = window.getComputedStyle(el);
      if (tag === "b" || tag === "strong" || +style.fontWeight >= 600) next.bold = true;
      if (tag === "i" || tag === "em" || style.fontStyle === "italic") next.italics = true;
      if (tag === "u" || style.textDecorationLine.includes("underline")) next.underline = true;
      runs.push(...makeRuns(el, next));
    });
    return runs;
  };

  const alignOf = (el: HTMLElement) => {
    const a = window.getComputedStyle(el).textAlign;
    if (a === "center") return AlignmentType.CENTER;
    if (a === "left") return AlignmentType.LEFT;
    if (a === "right") return AlignmentType.RIGHT;
    return undefined;
  };

  const headingOf = (tag: string) =>
    tag === "h1" ? HeadingLevel.HEADING_1
    : tag === "h2" ? HeadingLevel.HEADING_2
    : tag === "h3" ? HeadingLevel.HEADING_3
    : undefined;

  const paragraphs: any[] = [];
  const pushPara = (el: HTMLElement, opts: { bullet?: boolean; numbered?: boolean } = {}) => {
    const runs = makeRuns(el, {});
    paragraphs.push(
      new Paragraph({
        children: runs.length ? runs : [new TextRun("")],
        heading: headingOf(el.tagName.toLowerCase()),
        alignment: alignOf(el),
        bidirectional: rtl,
        bullet: opts.bullet ? { level: 0 } : undefined,
        numbering: opts.numbered ? { reference: "office-num", level: 0 } : undefined,
      }),
    );
  };

  const blockTags = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);
  const children = Array.from(root.children) as HTMLElement[];

  if (children.length === 0) {
    (root.innerText || root.textContent || "").split("\n").forEach((line) =>
      paragraphs.push(new Paragraph({ children: [new TextRun(line)], bidirectional: rtl })),
    );
  } else {
    children.forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === "ul" || tag === "ol") {
        Array.from(el.children).forEach((li) =>
          pushPara(li as HTMLElement, tag === "ol" ? { numbered: true } : { bullet: true }),
        );
      } else if (blockTags.has(tag)) {
        pushPara(el);
      } else {
        pushPara(el);
      }
    });
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "office-num",
          levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }],
        },
      ],
    },
    sections: [{ properties: {}, children: paragraphs }],
  });
  return Packer.toBlob(doc);
}

export default function WordEditor() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language?.startsWith("ar") ?? true;
  const { toast } = useToast();
  const editorRef = useRef<HTMLDivElement>(null);
  const [fileName, setFileName] = useState<string>(ar ? "مستند جديد.docx" : "Untitled.docx");
  const [handle, setHandle] = useState<OpenedFile["handle"]>(null);
  const [busy, setBusy] = useState(false);
  const [rtl, setRtl] = useState(true);
  const [dirty, setDirty] = useState(false);

  const focusEditor = () => editorRef.current?.focus();

  const exec = useCallback((command: string, value?: string) => {
    focusEditor();
    document.execCommand(command, false, value);
    setDirty(true);
  }, []);

  const formatBlock = (tag: string) => exec("formatBlock", tag);

  const handleNew = () => {
    if (dirty && !window.confirm(ar ? "تجاهل التغييرات غير المحفوظة؟" : "Discard unsaved changes?")) return;
    if (editorRef.current) editorRef.current.innerHTML = "";
    setFileName(ar ? "مستند جديد.docx" : "Untitled.docx");
    setHandle(null);
    setDirty(false);
  };

  const handleOpen = async () => {
    try {
      const opened = await openFile({
        accept: { ...DOCX_ACCEPT, ...TXT_ACCEPT },
        description: ar ? "مستندات Word والنصوص" : "Word & text documents",
      });
      if (!opened) return;
      setBusy(true);
      const lower = opened.file.name.toLowerCase();
      if (lower.endsWith(".txt")) {
        const text = await opened.file.text();
        if (editorRef.current) {
          editorRef.current.innerHTML = text
            .split("\n")
            .map((l) => `<p>${escapeHtml(l) || "<br>"}</p>`)
            .join("");
        }
      } else {
        const mammoth: any = await import("mammoth");
        const buf = await opened.file.arrayBuffer();
        const result = await (mammoth.default ?? mammoth).convertToHtml({ arrayBuffer: buf });
        // Sanitize untrusted document HTML before injecting into the app DOM.
        const clean = DOMPurify.sanitize(result.value || "<p><br></p>", { USE_PROFILES: { html: true } });
        if (editorRef.current) editorRef.current.innerHTML = clean || "<p><br></p>";
      }
      setFileName(opened.file.name);
      setHandle(opened.handle);
      setDirty(false);
    } catch (e: any) {
      toast({ title: ar ? "تعذّر فتح الملف" : "Could not open file", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const doSave = async (kind: "docx" | "txt", saveAs: boolean) => {
    if (!editorRef.current) return;
    try {
      setBusy(true);
      let blob: Blob;
      let suggested: string;
      let accept: Record<string, string[]>;
      if (kind === "txt") {
        blob = new Blob([editorRef.current.innerText], { type: "text/plain;charset=utf-8" });
        suggested = withExtension(fileName, "txt");
        accept = TXT_ACCEPT;
      } else {
        blob = await buildDocxBlob(editorRef.current, rtl);
        suggested = withExtension(fileName, "docx");
        accept = DOCX_ACCEPT;
      }
      const sameKind = kind === "docx" ? fileName.toLowerCase().endsWith(".docx") : fileName.toLowerCase().endsWith(".txt");
      const res = await saveFile(blob, {
        suggestedName: suggested,
        accept,
        description: kind === "docx" ? "Word" : "Text",
        handle: saveAs || !sameKind ? null : handle,
      });
      if (res.saved) {
        if (res.handle) setHandle(res.handle);
        setFileName(suggested);
        setDirty(false);
        toast({ title: ar ? "تم الحفظ" : "Saved", description: suggested });
      }
    } catch (e: any) {
      toast({ title: ar ? "تعذّر الحفظ" : "Could not save", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handlePdf = () => {
    if (!editorRef.current) return;
    printHtml(editorRef.current.innerHTML, { title: fileName, rtl });
  };

  return (
    <div className="p-4 sm:p-6 space-y-3" data-testid="page-office-word">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <FileText className="h-5 w-5 text-blue-600" />
          {t("nav.officeWord", { defaultValue: ar ? "محرر المستندات (Word)" : "Document Editor (Word)" })}
          <span className="text-sm font-normal text-muted-foreground truncate max-w-[40vw]">
            — {fileName}{dirty ? " *" : ""}
          </span>
        </h1>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={handleNew} disabled={busy} data-testid="button-word-new">
            <FilePlus2 className="h-4 w-4 ms-1" /> {ar ? "جديد" : "New"}
          </Button>
          <Button size="sm" variant="outline" onClick={handleOpen} disabled={busy} data-testid="button-word-open">
            <FolderOpen className="h-4 w-4 ms-1" /> {ar ? "فتح" : "Open"}
          </Button>
          <Button size="sm" onClick={() => doSave("docx", false)} disabled={busy} data-testid="button-word-save">
            <Save className="h-4 w-4 ms-1" /> {ar ? "حفظ DOCX" : "Save DOCX"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => doSave("docx", true)} disabled={busy} data-testid="button-word-saveas">
            {ar ? "حفظ باسم" : "Save As"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => doSave("txt", true)} disabled={busy} data-testid="button-word-savetxt">
            {ar ? "حفظ TXT" : "Save TXT"}
          </Button>
          <Button size="sm" variant="outline" onClick={handlePdf} disabled={busy} data-testid="button-word-pdf">
            <FileDown className="h-4 w-4 ms-1" /> PDF
          </Button>
        </div>
      </div>

      <Card className="p-2">
        <div className="flex flex-wrap items-center gap-1">
          <ToolBtn onClick={() => exec("bold")} title={ar ? "غامق" : "Bold"}><Bold className="h-4 w-4" /></ToolBtn>
          <ToolBtn onClick={() => exec("italic")} title={ar ? "مائل" : "Italic"}><Italic className="h-4 w-4" /></ToolBtn>
          <ToolBtn onClick={() => exec("underline")} title={ar ? "تسطير" : "Underline"}><Underline className="h-4 w-4" /></ToolBtn>
          <Divider />
          <ToolBtn onClick={() => formatBlock("<h1>")} title="H1"><Heading1 className="h-4 w-4" /></ToolBtn>
          <ToolBtn onClick={() => formatBlock("<h2>")} title="H2"><Heading2 className="h-4 w-4" /></ToolBtn>
          <ToolBtn onClick={() => formatBlock("<h3>")} title="H3"><Heading3 className="h-4 w-4" /></ToolBtn>
          <ToolBtn onClick={() => formatBlock("<p>")} title={ar ? "نص عادي" : "Paragraph"}><span className="text-xs px-1">P</span></ToolBtn>
          <Divider />
          <ToolBtn onClick={() => exec("insertUnorderedList")} title={ar ? "قائمة نقطية" : "Bullet list"}><List className="h-4 w-4" /></ToolBtn>
          <ToolBtn onClick={() => exec("insertOrderedList")} title={ar ? "قائمة رقمية" : "Numbered list"}><ListOrdered className="h-4 w-4" /></ToolBtn>
          <Divider />
          <ToolBtn onClick={() => exec("justifyRight")} title={ar ? "محاذاة لليمين" : "Align right"}><AlignRight className="h-4 w-4" /></ToolBtn>
          <ToolBtn onClick={() => exec("justifyCenter")} title={ar ? "توسيط" : "Align center"}><AlignCenter className="h-4 w-4" /></ToolBtn>
          <ToolBtn onClick={() => exec("justifyLeft")} title={ar ? "محاذاة لليسار" : "Align left"}><AlignLeft className="h-4 w-4" /></ToolBtn>
          <Divider />
          <ToolBtn onClick={() => setRtl((v) => !v)} title={ar ? "اتجاه النص" : "Text direction"}>
            <span className="text-xs px-1">{rtl ? "RTL" : "LTR"}</span>
          </ToolBtn>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        <div
          ref={editorRef}
          contentEditable
          dir={rtl ? "rtl" : "ltr"}
          onInput={() => setDirty(true)}
          className="min-h-[55vh] max-h-[70vh] overflow-y-auto p-6 outline-none prose prose-sm max-w-none bg-white text-black leading-relaxed"
          style={{ textAlign: rtl ? "right" : "left" }}
          data-testid="editor-word"
          suppressContentEditableWarning
        >
          <p><br /></p>
        </div>
      </Card>
      <p className="text-xs text-muted-foreground">
        {ar
          ? "ملاحظة: يحافظ الحفظ على النصوص والتنسيقات الأساسية (غامق/مائل/تسطير، العناوين، القوائم، المحاذاة). التنسيقات المتقدمة (الجداول، الصور) قد لا تُحفظ في هذه النسخة."
          : "Note: saving preserves text and basic formatting (bold/italic/underline, headings, lists, alignment). Advanced content (tables, images) may not be preserved in this version."}
      </p>
    </div>
  );
}

function ToolBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      className="inline-flex items-center justify-center h-8 min-w-8 px-1.5 rounded hover:bg-muted text-foreground"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-border" />;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
