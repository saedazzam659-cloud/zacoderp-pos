import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  ArrowUpLeft,
  BookOpen,
  Check,
  ChevronLeft,
  CircleHelp,
  FileBarChart2,
  Image as ImageIcon,
  List,
  Search,
  Sparkles,
} from "lucide-react";

export type GuideScreen = {
  path: string;
  label: string;
  report?: boolean;
};

export type GuideStep = {
  title: string;
  body: string;
  href?: string;
};

export type GuideChapter = {
  id: string;
  title: string;
  summary: string;
  intro: string;
  screens: GuideScreen[];
  workflow: GuideStep[];
  tips: string[];
  screenshot?: {
    src: string;
    alt: string;
    caption: string;
  };
};

type UserGuideViewProps = {
  chapters: GuideChapter[];
  brandName?: string | null;
};

export default function UserGuideView({
  chapters,
  brandName,
}: UserGuideViewProps) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(chapters[0]?.id ?? "");

  const filteredChapters = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return chapters;
    return chapters.filter((chapter) => {
      const searchableText = [
        chapter.title,
        chapter.summary,
        chapter.intro,
        ...chapter.screens.map((screen) => screen.label),
        ...chapter.workflow.flatMap((step) => [step.title, step.body]),
        ...chapter.tips,
      ]
        .join(" ")
        .toLocaleLowerCase();
      return searchableText.includes(normalizedQuery);
    });
  }, [chapters, query]);

  const activeChapter =
    filteredChapters.find((chapter) => chapter.id === activeId) ??
    filteredChapters[0];

  const setChapter = (id: string) => setActiveId(id);

  return (
    <main
      className="min-h-[calc(100dvh-5rem)] bg-[#f2f5f1] px-3 py-5 text-[#203b37] sm:px-6 sm:py-8 lg:px-8"
      dir="rtl"
      data-testid="page-user-guide"
    >
      <div className="mx-auto max-w-[1440px]">
        <header className="relative mb-6 overflow-hidden rounded-[1.65rem] bg-[#173e39] px-5 py-7 text-[#f6f4e9] shadow-[0_16px_45px_rgba(25,61,55,0.12)] sm:px-8 sm:py-9">
          <div className="pointer-events-none absolute -left-10 -top-20 h-64 w-64 rounded-full border border-white/10" />
          <div className="pointer-events-none absolute -left-1 top-8 h-44 w-44 rounded-full border border-white/10" />
          <div className="relative flex flex-col justify-between gap-7 lg:flex-row lg:items-end">
            <div className="max-w-3xl">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs font-semibold tracking-wide text-[#d9e9dd]">
                <BookOpen size={15} aria-hidden="true" />
                <span>{brandName || "زاكود ERP"}</span>
                <span className="h-1 w-1 rounded-full bg-[#b8d7a8]" />
                <span>دليل التشغيل</span>
              </div>
              <h1 className="text-3xl font-extrabold leading-tight tracking-tight sm:text-[2.7rem]">
                اعثر على الخطوة التالية
                <span className="mt-1 block text-[#c4d9a9]">وأنجز العمل بثقة.</span>
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-[#d8e5dd] sm:text-base">
                شرح عملي للشاشات ومسارات العمل المتاحة لك في النظام. اختر
                موضوعاً للوصول إلى الشاشات والخطوات المرتبطة به.
              </p>
            </div>
            <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.07] p-3 sm:min-w-[250px] sm:p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#d5e3bd] text-[#224b41]">
                <List size={19} aria-hidden="true" />
              </div>
              <div>
                <div className="text-2xl font-bold tabular-nums" data-testid="text-guide-chapter-count">
                  {chapters.length}
                </div>
                <div className="text-xs text-[#d8e5dd]">موضوع في دليلك</div>
              </div>
            </div>
          </div>
        </header>

        {chapters.length === 0 ? (
          <section
            className="rounded-3xl border border-[#d9e2d9] bg-[#fbfcf8] px-6 py-16 text-center shadow-sm"
            data-testid="empty-guide"
          >
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#e5eee3] text-[#3f7567]">
              <CircleHelp size={25} aria-hidden="true" />
            </div>
            <h2 className="text-lg font-bold">لا توجد موضوعات لعرضها</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#687c75]">
              لا يتوفر محتوى دليل لهذه الشركة حالياً.
            </p>
          </section>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_310px]">
            <section className="min-w-0 space-y-5">
              {activeChapter ? (
                <>
                  <article
                    className="overflow-hidden rounded-[1.5rem] border border-[#dce5db] bg-[#fbfcf8] shadow-[0_6px_24px_rgba(31,67,59,0.045)]"
                    data-testid={`chapter-${activeChapter.id}`}
                  >
                    <div className="border-b border-[#e5ebe3] px-5 py-6 sm:px-8 sm:py-8">
                      <div className="mb-4 flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e8f0e5] px-3 py-1 text-xs font-bold text-[#426e5f]">
                          <Sparkles size={13} aria-hidden="true" />
                          دليل عملي
                        </span>
                        <span className="text-xs text-[#7a8b83]">
                          {activeChapter.screens.length} شاشة
                        </span>
                      </div>
                      <h2 className="text-2xl font-extrabold leading-snug tracking-tight text-[#1b3934] sm:text-3xl">
                        {activeChapter.title}
                      </h2>
                      <p className="mt-3 max-w-3xl text-sm font-semibold leading-7 text-[#567168] sm:text-base">
                        {activeChapter.summary}
                      </p>
                      <p className="mt-4 max-w-4xl text-sm leading-8 text-[#536961]">
                        {activeChapter.intro}
                      </p>
                    </div>

                    {activeChapter.screenshot && (
                      <figure
                        className="border-b border-[#e5ebe3] bg-[#eef2eb] p-4 sm:p-6"
                        data-testid={`screenshot-${activeChapter.id}`}
                      >
                        <div className="overflow-hidden rounded-2xl border border-[#d3ddd2] bg-[#e2e9e1] shadow-sm">
                          <img
                            src={activeChapter.screenshot.src.startsWith("/")
                              ? `${import.meta.env.BASE_URL}${activeChapter.screenshot.src.slice(1)}`
                              : activeChapter.screenshot.src}
                            alt={activeChapter.screenshot.alt}
                            className="block max-h-[560px] w-full object-contain"
                            loading="lazy"
                            data-testid={`img-guide-${activeChapter.id}`}
                          />
                        </div>
                        <figcaption className="mt-3 flex items-start gap-2 text-xs leading-6 text-[#5d746a]">
                          <ImageIcon
                            size={15}
                            className="mt-1 shrink-0"
                            aria-hidden="true"
                          />
                          <span>{activeChapter.screenshot.caption}</span>
                        </figcaption>
                      </figure>
                    )}

                    <div className="grid gap-6 px-5 py-6 sm:px-8 sm:py-8 xl:grid-cols-[1.15fr_0.85fr]">
                      <section aria-labelledby="guide-workflow-heading">
                        <div className="mb-5 flex items-center gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#e7efe1] text-[#477665]">
                            <Check size={18} aria-hidden="true" />
                          </div>
                          <div>
                            <h3
                              id="guide-workflow-heading"
                              className="font-bold text-[#243f39]"
                            >
                              خطوات العمل
                            </h3>
                            <p className="mt-0.5 text-xs text-[#788981]">
                              اتبع التسلسل الوارد في الدليل
                            </p>
                          </div>
                        </div>
                        {activeChapter.workflow.length ? (
                          <ol className="space-y-3" data-testid={`workflow-${activeChapter.id}`}>
                            {activeChapter.workflow.map((step, index) => (
                              <li
                                key={`${activeChapter.id}-step-${index}`}
                                className="relative rounded-2xl border border-[#e3e9e1] bg-white/70 p-4"
                                data-testid={`step-${activeChapter.id}-${index + 1}`}
                              >
                                <div className="flex items-start gap-3">
                                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#e6eee2] text-xs font-bold tabular-nums text-[#456e5d]">
                                    {index + 1}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <h4 className="font-bold leading-6 text-[#29463e]">
                                      {step.title}
                                    </h4>
                                    <p className="mt-1 text-sm leading-7 text-[#5b7068]">
                                      {step.body}
                                    </p>
                                    {step.href && (
                                      <Link
                                        href={step.href}
                                        className="mt-3 inline-flex items-center gap-1.5 rounded-lg text-sm font-bold text-[#347363] transition-colors hover:text-[#1d5349] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8b78] focus-visible:ring-offset-2"
                                        data-testid={`link-step-${activeChapter.id}-${index + 1}`}
                                      >
                                        الانتقال إلى الشاشة
                                        <ArrowLeft size={15} aria-hidden="true" />
                                      </Link>
                                    )}
                                  </div>
                                </div>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <p className="rounded-xl bg-[#f2f5f0] px-4 py-5 text-sm text-[#71827b]">
                            لا توجد خطوات عمل مضافة لهذا الموضوع.
                          </p>
                        )}
                      </section>

                      <div className="space-y-6">
                        <section aria-labelledby="guide-screens-heading">
                          <div className="mb-4 flex items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#edf0dc] text-[#747c4b]">
                              <ArrowUpLeft size={18} aria-hidden="true" />
                            </div>
                            <div>
                              <h3
                                id="guide-screens-heading"
                                className="font-bold text-[#243f39]"
                              >
                                الشاشات المرتبطة
                              </h3>
                              <p className="mt-0.5 text-xs text-[#788981]">
                                افتح الشاشة المطلوبة مباشرة
                              </p>
                            </div>
                          </div>
                          {activeChapter.screens.length ? (
                            <div className="flex flex-wrap gap-2" data-testid={`screens-${activeChapter.id}`}>
                              {activeChapter.screens.map((screen) => (
                                <Link
                                  key={screen.path}
                                  href={screen.path}
                                  className="group inline-flex max-w-full items-center gap-2 rounded-xl border border-[#dfe7dc] bg-white px-3 py-2.5 text-sm font-semibold text-[#36574c] transition-colors hover:border-[#a9c8b8] hover:bg-[#f1f6ef] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8b78] focus-visible:ring-offset-2"
                                  data-testid={`link-screen-${activeChapter.id}-${encodeURIComponent(screen.path)}`}
                                >
                                  {screen.report ? (
                                    <FileBarChart2
                                      size={15}
                                      className="shrink-0 text-[#81906b]"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#78a18d]" />
                                  )}
                                  <span className="truncate">{screen.label}</span>
                                  <ChevronLeft
                                    size={14}
                                    className="shrink-0 text-[#8da198] transition-transform group-hover:-translate-x-0.5"
                                    aria-hidden="true"
                                  />
                                </Link>
                              ))}
                            </div>
                          ) : (
                            <p className="rounded-xl bg-[#f2f5f0] px-4 py-5 text-sm text-[#71827b]">
                              لا توجد شاشات مرتبطة مدرجة.
                            </p>
                          )}
                        </section>

                        {activeChapter.tips.length > 0 && (
                          <section
                            className="rounded-2xl border border-[#e6e8d7] bg-[#f5f5e9] p-4 sm:p-5"
                            aria-labelledby="guide-tips-heading"
                            data-testid={`tips-${activeChapter.id}`}
                          >
                            <div className="mb-3 flex items-center gap-2">
                              <CircleHelp
                                size={17}
                                className="text-[#788054]"
                                aria-hidden="true"
                              />
                              <h3
                                id="guide-tips-heading"
                                className="font-bold text-[#4d573b]"
                              >
                                ملاحظات مفيدة
                              </h3>
                            </div>
                            <ul className="space-y-2.5">
                              {activeChapter.tips.map((tip, index) => (
                                <li
                                  key={`${activeChapter.id}-tip-${index}`}
                                  className="flex items-start gap-2.5 text-sm leading-7 text-[#626a50]"
                                  data-testid={`tip-${activeChapter.id}-${index + 1}`}
                                >
                                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#9b9b68]" />
                                  <span>{tip}</span>
                                </li>
                              ))}
                            </ul>
                          </section>
                        )}
                      </div>
                    </div>
                  </article>
                </>
              ) : (
                <div
                  className="rounded-3xl border border-dashed border-[#cdd9ce] bg-[#fbfcf8] px-6 py-14 text-center"
                  data-testid="empty-guide-search"
                >
                  <Search size={22} className="mx-auto text-[#81968a]" aria-hidden="true" />
                  <p className="mt-3 font-bold text-[#36574c]">لا توجد نتائج مطابقة</p>
                  <p className="mt-1 text-sm text-[#71827b]">
                    جرّب كلمة أخرى للبحث في موضوعات الدليل.
                  </p>
                </div>
              )}
            </section>

            <aside className="order-first lg:order-last">
              <div className="overflow-hidden rounded-[1.4rem] border border-[#dce5db] bg-[#fbfcf8] shadow-[0_6px_24px_rgba(31,67,59,0.04)] lg:sticky lg:top-5">
                <div className="border-b border-[#e5ebe3] p-4 sm:p-5">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <h2 className="font-bold text-[#263f39]">فهرس الدليل</h2>
                      <p className="mt-1 text-xs text-[#7b8b83]">
                        انتقل إلى موضوع
                      </p>
                    </div>
                    <span className="rounded-lg bg-[#eef3eb] px-2 py-1 text-xs font-semibold tabular-nums text-[#567568]">
                      {filteredChapters.length} / {chapters.length}
                    </span>
                  </div>
                  <label className="relative block">
                    <span className="sr-only">ابحث في موضوعات الدليل</span>
                    <Search
                      size={16}
                      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#81928a]"
                      aria-hidden="true"
                    />
                    <input
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="ابحث في الدليل"
                      className="h-10 w-full rounded-xl border border-[#dce5db] bg-[#f8faf6] pr-9 pl-3 text-sm text-[#29463e] outline-none transition focus:border-[#78a18d] focus:ring-2 focus:ring-[#78a18d]/20"
                      data-testid="input-guide-search"
                    />
                  </label>
                </div>
                <nav
                  aria-label="موضوعات دليل التشغيل"
                  className="flex max-h-[290px] gap-2 overflow-x-auto p-3 lg:max-h-[calc(100dvh-18rem)] lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden"
                  data-testid="guide-chapter-navigation"
                >
                  {filteredChapters.map((chapter, index) => {
                    const selected = chapter.id === activeChapter?.id;
                    return (
                      <button
                        key={chapter.id}
                        type="button"
                        onClick={() => setChapter(chapter.id)}
                        aria-current={selected ? "page" : undefined}
                        className={`group flex min-w-[220px] flex-1 items-start gap-3 rounded-xl border p-3 text-right transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8b78] focus-visible:ring-offset-2 lg:min-w-0 ${
                          selected
                            ? "border-[#b8cdbd] bg-[#edf4eb]"
                            : "border-transparent bg-transparent hover:border-[#e5ebe3] hover:bg-[#f5f8f3]"
                        }`}
                        data-testid={`button-chapter-${chapter.id}`}
                      >
                        <span
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold tabular-nums ${
                            selected
                              ? "bg-[#315f52] text-white"
                              : "bg-[#edf1e9] text-[#6e8278]"
                          }`}
                        >
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-bold leading-6 text-[#2c4a40]">
                            {chapter.title}
                          </span>
                          <span className="mt-0.5 block line-clamp-2 text-xs leading-5 text-[#74857d]">
                            {chapter.summary}
                          </span>
                        </span>
                        <ChevronLeft
                          size={15}
                          className={`mt-1 shrink-0 transition-colors ${
                            selected
                              ? "text-[#527d6c]"
                              : "text-[#b0bbb4] group-hover:text-[#688b7c]"
                          }`}
                          aria-hidden="true"
                        />
                      </button>
                    );
                  })}
                  {filteredChapters.length === 0 && (
                    <p
                      className="px-3 py-5 text-center text-sm text-[#71827b]"
                      data-testid="text-no-guide-results"
                    >
                      لا توجد موضوعات مطابقة.
                    </p>
                  )}
                </nav>
                <div className="hidden border-t border-[#e5ebe3] px-5 py-4 lg:block">
                  <p className="text-xs leading-6 text-[#829088]">
                    تظهر هنا موضوعات الدليل المتاحة لهذه الشركة.
                  </p>
                </div>
              </div>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}