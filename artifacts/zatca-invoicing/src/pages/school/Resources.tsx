import { Link } from "wouter";
import { ArrowUpLeft, Boxes, Building2, Coins, FileText, Landmark, PackageSearch, ShoppingCart, Users, UserRoundCog } from "lucide-react";

const resources = [
  { title: "المخزون والأصناف", detail: "إدارة أصناف المدرسة والمستلزمات عبر المخزون", href: "/inventory/items", icon: Boxes, tag: "المخزون" },
  { title: "العملاء والمبيعات", detail: "ملفات أولياء الأمور وفواتير المبيعات والتحصيلات", href: "/customers", icon: Users, tag: "المبيعات" },
  { title: "فواتير المبيعات", detail: "إصدار الفاتورة وتطبيق دورة التحصيل المعتمدة", href: "/invoices", icon: FileText, tag: "المبيعات" },
  { title: "الموردون والمشتريات", detail: "الموردون وطلبات وفواتير الشراء", href: "/suppliers", icon: ShoppingCart, tag: "المشتريات" },
  { title: "النقد والبنوك", detail: "الصناديق والحسابات البنكية وسندات القبض", href: "/cash/financial-transactions", icon: Coins, tag: "النقد والبنوك" },
  { title: "دفتر الأستاذ", detail: "الحسابات والقيود والتقارير المحاسبية", href: "/accounting/accounts", icon: Landmark, tag: "المحاسبة" },
  { title: "الموارد البشرية", detail: "ملفات الموظفين والمعلمين", href: "/hr/employees", icon: UserRoundCog, tag: "الموارد البشرية" },
  { title: "الأصول الثابتة", detail: "سجل الأصول ومتابعة الموجودات", href: "/fixed-assets", icon: Building2, tag: "الأصول" },
  { title: "المشتريات والمخزون", detail: "متابعة التوريد واستلام المستلزمات", href: "/purchasing/invoices", icon: PackageSearch, tag: "المشتريات" },
];
export default function Resources() {
  return <main dir="rtl" className="space-y-4 p-4 sm:p-5"><header><h1 className="text-xl font-bold sm:text-2xl">موارد ERP المرتبطة</h1><p className="mt-1 text-sm text-muted-foreground">انتقال مباشر إلى وحدات زاتكا الحالية. الصلاحيات والتفعيل يحددهما النظام القائم.</p></header><section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{resources.map(r => <Link href={r.href} key={r.href} className="group flex items-start gap-3 rounded-xl border bg-card p-4 hover:border-primary/40 hover:bg-primary/[0.025]"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><r.icon className="h-5 w-5" /></span><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><span className="font-semibold">{r.title}</span><ArrowUpLeft className="h-4 w-4 shrink-0 text-muted-foreground" /></span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{r.detail}</span><span className="mt-3 inline-flex rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">{r.tag}</span></span></Link>)}</section><p className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs leading-5 text-sky-900">الرسوم في وحدة المدرسة سجلات تشغيلية فقط. إنشاء الفواتير وتسجيل الإيصالات والترحيل المحاسبي يبقى ضمن مسارات ERP الحالية دون تغيير.</p></main>;
}
