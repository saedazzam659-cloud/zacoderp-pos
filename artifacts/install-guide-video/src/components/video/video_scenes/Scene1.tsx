import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

// ─── Scene 1 — Ease + AI hero ──────────────────────────────────────
// Opens the 26-second piece with the new positioning: "محاسبة سهلة
// مدعومة بالذكاء الاصطناعي". Same animation framework as before
// (kinetic letter reveal + concentric pulse + tagline pill) so the
// validate-recording.sh harness keeps passing — only the copy and the
// secondary tagline change.
export function Scene1() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 1200),
      setTimeout(() => setPhase(3), 2000),
      setTimeout(() => setPhase(4), 4000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  // ─── Title rendering ─────────────────────────────────────────────
  // We tokenize by WORD (not by character) and render each word as a
  // single inline-block. Splitting Arabic by character with .split('')
  // breaks the Unicode shaping pipeline — every glyph becomes its own
  // text node and the browser can no longer join the letters into a
  // word, so the title rendered as disconnected isolated forms (the
  // "محاسبة" → "م ح ا س ب ة" bug screenshot from the user). Per-word
  // splitting keeps each word's letters in the same text run so the
  // joining/cursive forms survive, while still letting us stagger the
  // reveal animation.
  const titleSegments = "محاسبة سهلة. ذكاء اصطناعي مدمج.".split(' ');

  return (
    <motion.div
      className="absolute inset-0 flex flex-col items-center justify-center z-10"
      exit={{ opacity: 0, scale: 1.1, filter: 'blur(10px)' }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="relative">
        <motion.div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80vw] h-[80vw] max-w-[800px] max-h-[800px] border-[1px] border-accent/20 rounded-full"
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: phase >= 1 ? 1 : 0, opacity: phase >= 1 ? 1 : 0 }}
          transition={{ duration: 2, ease: "easeOut" }}
        />

        <h1
          className="text-[5vw] font-black leading-tight text-center flex flex-wrap justify-center gap-x-[0.35em] mb-6"
          style={{ direction: 'rtl' }}
        >
          {titleSegments.map((word, i) => (
            <motion.span
              key={i}
              className="inline-block whitespace-nowrap"
              initial={{ opacity: 0, y: 40 }}
              animate={{
                opacity: phase >= 2 ? 1 : 0,
                y: phase >= 2 ? 0 : 40,
              }}
              transition={{
                type: 'spring',
                stiffness: 320,
                damping: 24,
                delay: phase >= 2 ? i * 0.12 : 0,
              }}
            >
              {word}
            </motion.span>
          ))}
        </h1>

        <motion.div
          className="bg-primary/20 border border-primary/50 text-primary-foreground px-8 py-3 rounded-full mx-auto backdrop-blur-sm shadow-[0_0_30px_rgba(17,140,113,0.3)]"
          initial={{ opacity: 0, y: 20, scale: 0.9 }}
          animate={{
            opacity: phase >= 3 ? 1 : 0,
            y: phase >= 3 ? 0 : 20,
            scale: phase >= 3 ? 1 : 0.9,
          }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        >
          <p className="text-[2.2vw] font-bold text-center">
            كل أعمالك في منصة واحدة — بضغطة زر
          </p>
        </motion.div>
      </div>
    </motion.div>
  );
}
