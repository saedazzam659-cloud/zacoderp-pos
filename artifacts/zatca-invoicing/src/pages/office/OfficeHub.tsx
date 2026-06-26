import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { FileText, FileSpreadsheet, FolderOpen, Save, FileDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export default function OfficeHub() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language?.startsWith("ar") ?? true;

  const tiles = [
    {
      href: "/office/word",
      icon: FileText,
      title: ar ? "محرر المستندات (Word)" : "Document Editor (Word)",
      desc: ar
        ? "افتح وحرّر واحفظ ملفات Word (DOCX) والنصوص (TXT) مباشرة من جهازك، مع تنسيق غني وتصدير PDF."
        : "Open, edit and save Word (DOCX) and text (TXT) files straight from your device, with rich formatting and PDF export.",
      accent: "text-blue-600",
      ring: "group-hover:border-blue-300",
    },
    {
      href: "/office/excel",
      icon: FileSpreadsheet,
      title: ar ? "محرر الجداول (Excel)" : "Spreadsheet Editor (Excel)",
      desc: ar
        ? "افتح وحرّر واحفظ جداول Excel (XLSX) وملفات CSV بأوراق متعددة، مع تصدير PDF للطباعة."
        : "Open, edit and save Excel (XLSX) and CSV spreadsheets with multiple sheets, plus PDF export for printing.",
      accent: "text-green-600",
      ring: "group-hover:border-green-300",
    },
  ];

  const features = [
    {
      icon: FolderOpen,
      title: ar ? "فتح ملفات خارجية" : "Open external files",
      desc: ar ? "اقرأ ملفات DOCX و XLSX و CSV و TXT من جهازك." : "Read DOCX, XLSX, CSV and TXT files from your device.",
    },
    {
      icon: Save,
      title: ar ? "حفظ مباشر" : "Save in place",
      desc: ar
        ? "احفظ التعديلات في نفس الملف (في المتصفحات المدعومة) أو نزّل نسخة جديدة."
        : "Write changes back to the same file (supported browsers) or download a fresh copy.",
    },
    {
      icon: FileDown,
      title: ar ? "تصدير PDF" : "Export to PDF",
      desc: ar ? "اطبع أو احفظ مستنداتك وجداولك كملف PDF بنقرة واحدة." : "Print or save your documents and sheets as PDF in one click.",
    },
  ];

  return (
    <div className="p-6 space-y-6" data-testid="page-office-hub">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <FileText className="h-6 w-6 text-primary" />
          {t("nav.officeModule", { defaultValue: ar ? "أوفيس زاكود" : "Zacode Office" })}
        </h1>
        <p className="text-muted-foreground mt-1">
          {ar
            ? "حزمة مكتبية داخل المتصفح لتحرير مستندات Word وجداول Excel — تفتح وتحفظ ملفاتك الخارجية مباشرةً."
            : "An in-browser office suite to edit Word documents and Excel sheets — opening and saving your external files directly."}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {tiles.map((tile) => (
          <Link key={tile.href} href={tile.href}>
            <a className="group block" data-testid={`tile-office-${tile.href.split("/").pop()}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className={`p-6 border border-transparent rounded-lg ${tile.ring} transition-colors`}>
                  <tile.icon className={`h-10 w-10 ${tile.accent}`} />
                  <h2 className="text-lg font-semibold mt-3">{tile.title}</h2>
                  <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{tile.desc}</p>
                </CardContent>
              </Card>
            </a>
          </Link>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {features.map((f, i) => (
          <div key={i} className="flex items-start gap-3 rounded-lg border bg-card p-4">
            <f.icon className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-sm">{f.title}</div>
              <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{f.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
