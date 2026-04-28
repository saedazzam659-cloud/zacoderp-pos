import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

// ─── Scene 2 — AI superpowers ──────────────────────────────────────
// Replaces the original "متوافق مع ZATCA" beat with an "AI inside"
// moment: glowing brain mark, four AI capability pills, and the same
// floating QR-style grid (now rebranded as a neural-net texture).
export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 300),
      setTimeout(() => setPhase(2), 800),
      setTimeout(() => setPhase(3), 1500),
      setTimeout(() => setPhase(4), 2200),
      setTimeout(() => setPhase(5), 4500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center z-10 w-full h-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.9, filter: 'blur(10px)' }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex flex-col items-center justify-center w-full h-full relative">
        <motion.div
          className="absolute w-[40vw] h-[40vw] border-[1px] border-primary/30 rounded-[30%] rotate-45"
          initial={{ scale: 0.5, opacity: 0, rotate: 0 }}
          animate={phase >= 1 ? { scale: 1, opacity: 1, rotate: 45 } : { scale: 0.5, opacity: 0, rotate: 0 }}
          transition={{ duration: 2, ease: "easeOut" }}
        />
        <motion.div
          className="absolute w-[35vw] h-[35vw] border-[2px] border-secondary/20 rounded-[30%] -rotate-12"
          initial={{ scale: 0.5, opacity: 0, rotate: 0 }}
          animate={phase >= 1 ? { scale: 1, opacity: 1, rotate: -12 } : { scale: 0.5, opacity: 0, rotate: 0 }}
          transition={{ duration: 2.5, ease: "easeOut", delay: 0.2 }}
        />

        <div className="relative z-10 flex flex-col items-center text-center gap-6">
          <motion.div
            className="w-24 h-24 mb-4 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-[0_0_40px_rgba(0,108,91,0.5)]"
            initial={{ scale: 0, rotate: -180 }}
            animate={phase >= 2 ? { scale: 1, rotate: 0 } : { scale: 0, rotate: -180 }}
            transition={{ type: 'spring', stiffness: 200, damping: 20 }}
          >
            {/* Brain glyph — replaces the original shield to signal AI */}
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a4 4 0 0 0-4 4v1a3 3 0 0 0-3 3v1a3 3 0 0 0 1 2.236V14a4 4 0 0 0 4 4h0v3" />
              <path d="M12 2a4 4 0 0 1 4 4v1a3 3 0 0 1 3 3v1a3 3 0 0 1-1 2.236V14a4 4 0 0 1-4 4h0v3" />
              <path d="M9 12h6" />
            </svg>
          </motion.div>

          <motion.h2
            className="text-[5vw] font-display font-black text-white leading-tight"
            initial={{ opacity: 0, y: 40 }}
            animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          >
            ذكاء اصطناعي يفكّر معك
          </motion.h2>

          <div className="flex flex-row gap-6 mt-4 dir-rtl flex-wrap justify-center">
            {[
              "تحليلات تلقائية",
              "تنبيهات استباقية",
              "تنبؤات مبيعات",
              "اقتراحات ذكية",
            ].map((text, i) => (
              <motion.div
                key={i}
                className="bg-muted/50 border border-border px-6 py-3 rounded-full backdrop-blur-md"
                initial={{ opacity: 0, y: 20, scale: 0.8 }}
                animate={phase >= 3 ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 20, scale: 0.8 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20, delay: i * 0.15 }}
              >
                <span className="text-[1.2vw] font-bold text-secondary">{text}</span>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Neural-net texture floating around */}
        <div className="absolute inset-0 pointer-events-none z-0 flex items-center justify-center">
          <motion.div
            className="grid grid-cols-4 gap-2 opacity-20"
            initial={{ scale: 2, opacity: 0, rotateX: 60 }}
            animate={phase >= 4 ? { scale: 3, opacity: 0.1, rotateX: 30, y: 100 } : { scale: 2, opacity: 0, rotateX: 60 }}
            transition={{ duration: 4, ease: "easeOut" }}
          >
            {Array.from({ length: 16 }).map((_, i) => (
              <div key={i} className={`w-8 h-8 rounded-full ${i % 3 === 0 ? 'bg-primary' : 'bg-secondary'}`} />
            ))}
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
