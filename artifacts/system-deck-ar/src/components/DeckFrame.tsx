import type { ReactNode } from "react";

type Props = {
  number: string;
  eyebrow: string;
  title: string;
  intro?: string;
  image?: string;
  imageLabel?: string;
  children?: ReactNode;
  cover?: boolean;
  closing?: boolean;
};

const base = import.meta.env.BASE_URL;

export default function DeckFrame({
  number, eyebrow, title, intro, image, imageLabel, children, cover, closing,
}: Props) {
  return (
    <div dir="rtl" className={`relative h-screen w-screen overflow-hidden font-body ${cover || closing ? "bg-[#17332f] text-[#f3f5f2]" : "bg-bg text-ink"}`}>
      <div className="deck-grain pointer-events-none absolute inset-0" />
      <div className="absolute right-[6vw] top-[6vh] flex items-center gap-[1vw]">
        <span className={`h-[2.4vw] w-[0.24vw] ${cover || closing ? "bg-[#d8a27d]" : "bg-primary"}`} />
        <span className={`font-display text-[1.5vw] font-extrabold tracking-[0.08em] ${cover || closing ? "text-[#f3f5f2]" : "text-primary"}`}>ZACOD <span className="font-medium opacity-65">ERP</span></span>
      </div>
      <div dir="ltr" className={`absolute left-[6vw] top-[6vh] font-display text-[1.5vw] font-semibold tracking-[0.13em] ${cover || closing ? "text-white/55" : "text-muted"}`}>{number} / 15</div>
      {cover ? (
        <div className="relative flex h-full flex-col justify-center px-[10vw]">
          <p className="mb-[2.2vh] text-[1.65vw] font-semibold text-[#d8a27d]">{eyebrow}</p>
          <h1 className="max-w-[75vw] font-display text-[6vw] font-extrabold leading-[1.13] tracking-tight">{title}</h1>
          {intro && <p className="mt-[3vh] max-w-[62vw] text-[2.05vw] leading-relaxed text-white/70">{intro}</p>}
          <div className="mt-[6vh] flex items-center gap-[1vw] text-[1.5vw] text-white/55"><span className="h-[1px] w-[5vw] bg-[#d8a27d]" /> عرض تمهيدي للنقاش — دون افتراض نطاق أو بيانات للعميل</div>
          <div className="absolute bottom-[8vh] left-[10vw] text-[1.5vw] text-white/45">Graphic Art</div>
        </div>
      ) : closing ? (
        <div className="relative flex h-full flex-col justify-center px-[10vw]">
          <p className="mb-[2vh] text-[1.6vw] font-semibold text-[#d8a27d]">{eyebrow}</p>
          <h1 className="max-w-[74vw] font-display text-[5vw] font-extrabold leading-[1.15]">{title}</h1>
          <p className="mt-[3vh] max-w-[65vw] text-[2.1vw] leading-relaxed text-white/70">{intro}</p>
          <div className="mt-[6vh] inline-flex w-fit items-center gap-[1.2vw] border-y border-white/15 py-[1.5vh] text-[1.55vw]"><span className="text-[#d8a27d]">Graphic Art</span><span className="text-white/40">×</span><span>زاكود ERP</span></div>
        </div>
      ) : (
        <div className="relative flex h-full flex-col px-[6vw] pb-[6vh] pt-[14vh]">
          <div className={`${image ? "mb-[2.5vh]" : "mb-[4vh]"} flex items-end justify-between gap-[3vw]`}>
            <div className="max-w-[82vw]">
              <p className="mb-[1.15vh] text-[1.5vw] font-bold tracking-[0.1em] text-primary">{eyebrow}</p>
              <h1 className="font-display text-[3.5vw] font-extrabold leading-[1.18] tracking-tight">{title}</h1>
              {intro && <p className="mt-[1.5vh] max-w-[76vw] text-[2vw] leading-relaxed text-muted">{intro}</p>}
            </div>
          </div>
          <div className="deck-rule h-[0.28vh] w-[12vw] shrink-0" />
          <div className={`mt-[3vh] min-h-0 flex-1 ${image ? "grid grid-cols-[0.84fr_1.16fr] items-center gap-[3vw]" : "flex flex-col justify-center"}`}>
            <div className="min-w-0">{children}</div>
            {image && <figure className="m-0 min-w-0">
              <div className="overflow-hidden rounded-[0.8vw] border border-[#cfdbd6] bg-[#e8eeeb] p-[0.55vw] shadow-[0_1.4vw_3vw_rgba(29,62,54,0.10)]">
                <img src={`${base}graphic-art/${image}`} crossOrigin="anonymous" alt={imageLabel || "لقطة فعلية من واجهة زاكود ERP"} className="block h-auto max-h-[62vh] w-full object-contain" />
              </div>
              {imageLabel && <figcaption className="mt-[1vh] text-[1.5vw] text-muted">{imageLabel}<span className="mr-[1vw] rounded-full bg-[#e2ebe7] px-[0.8vw] py-[0.35vh] text-[1.5vw] text-primary">بيانات توضيحية</span></figcaption>}
            </figure>}
          </div>
          <div className="absolute bottom-[2.5vh] right-[6vw] text-[1.5vw] font-medium text-muted/80">مقترح أولي لـ Graphic Art</div>
        </div>
      )}
    </div>
  );
}