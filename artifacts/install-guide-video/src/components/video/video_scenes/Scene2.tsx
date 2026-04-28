import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 300), // shield outline
      setTimeout(() => setPhase(2), 800), // title
      setTimeout(() => setPhase(3), 1500), // lines
      setTimeout(() => setPhase(4), 2200), // qr code abstract
      setTimeout(() => setPhase(5), 4500), // exit
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
        
        {/* Abstract Shield / ZATCA Motif */}
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
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              <path d="m9 12 2 2 4-4"/>
            </svg>
          </motion.div>

          <motion.h2 
            className="text-[5vw] font-display font-black text-white leading-tight"
            initial={{ opacity: 0, y: 40 }}
            animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          >
            متوافق 100% مع ZATCA
          </motion.h2>

          <div className="flex flex-row gap-8 mt-4 dir-rtl">
            {[
              "المرحلة الثانية",
              "رمز QR ممتد",
              "توقيع رقمي (UBL 2.1)",
              "ربط آلي بمنصة فاتورة"
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

        {/* Abstract QR Grid floating around */}
        <div className="absolute inset-0 pointer-events-none z-0 flex items-center justify-center">
          <motion.div 
            className="grid grid-cols-4 gap-2 opacity-20"
            initial={{ scale: 2, opacity: 0, rotateX: 60 }}
            animate={phase >= 4 ? { scale: 3, opacity: 0.1, rotateX: 30, y: 100 } : { scale: 2, opacity: 0, rotateX: 60 }}
            transition={{ duration: 4, ease: "easeOut" }}
          >
            {Array.from({ length: 16 }).map((_, i) => (
              <div key={i} className={`w-8 h-8 rounded-sm ${Math.random() > 0.5 ? 'bg-primary' : 'bg-secondary'}`} />
            ))}
          </motion.div>
        </div>

      </div>
    </motion.div>
  );
}
