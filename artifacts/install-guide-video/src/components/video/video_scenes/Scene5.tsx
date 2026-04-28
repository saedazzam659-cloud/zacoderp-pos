import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene5() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200), // logo reveal
      setTimeout(() => setPhase(2), 1000), // tagline
      setTimeout(() => setPhase(3), 1800), // zatca badge
      setTimeout(() => setPhase(4), 4500), // hold
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center z-10 w-full h-full bg-bg-dark"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.8 }}
    >
      <div className="flex flex-col items-center justify-center text-center">
        
        {/* Abstract Logo */}
        <motion.div
          className="relative w-32 h-32 mb-8 flex items-center justify-center"
          initial={{ scale: 0, rotate: -90 }}
          animate={phase >= 1 ? { scale: 1, rotate: 0 } : { scale: 0, rotate: -90 }}
          transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        >
          <div className="absolute inset-0 bg-primary rounded-2xl rotate-45 opacity-80 mix-blend-screen" />
          <div className="absolute inset-0 bg-secondary rounded-2xl -rotate-12 opacity-80 mix-blend-screen" />
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="relative z-10">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <line x1="3" y1="9" x2="21" y2="9"/>
            <line x1="9" y1="21" x2="9" y2="9"/>
          </svg>
        </motion.div>

        <motion.h1
          className="text-[4vw] font-display font-black text-white mb-4 tracking-tight"
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          نظام نقاط البيع السعودي
        </motion.h1>

        <motion.div
          className="h-[2px] bg-gradient-to-r from-transparent via-primary to-transparent w-[30vw] my-6"
          initial={{ scaleX: 0 }}
          animate={phase >= 2 ? { scaleX: 1 } : { scaleX: 0 }}
          transition={{ duration: 1, ease: "easeInOut" }}
        />

        <motion.div
          className="flex items-center gap-4"
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        >
          <img 
            src={`${import.meta.env.BASE_URL}images/zatca-badge.png`} 
            className="w-12 h-12 object-contain" 
            alt="ZATCA" 
          />
          <span className="text-[1.8vw] font-bold text-secondary">
            متوافق مع هيئة الزكاة والضريبة والجمارك
          </span>
        </motion.div>

      </div>
    </motion.div>
  );
}
