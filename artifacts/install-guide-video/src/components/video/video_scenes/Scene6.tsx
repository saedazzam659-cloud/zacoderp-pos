import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene6() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),  // show center nodes
      setTimeout(() => setPhase(2), 1500), // link nodes
      setTimeout(() => setPhase(3), 2500), // bullet 1
      setTimeout(() => setPhase(4), 3500), // bullet 2
      setTimeout(() => setPhase(5), 4500), // bullet 3
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center z-10"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.1 }}
      transition={{ duration: 0.6 }}
    >
      <motion.h2 
        className="text-[4vw] font-black text-white mb-20"
        initial={{ opacity: 0, y: -30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
      >
        لماذا النظام يعمل بكفاءة؟
      </motion.h2>

      <div className="relative w-[60vw] h-[40vh] flex items-center justify-center">
        
        {/* Architecture Diagram */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-between w-[40vw]">
          {/* React */}
          <motion.div 
            className="flex flex-col items-center z-20"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: phase >= 1 ? 1 : 0, opacity: phase >= 1 ? 1 : 0 }}
            transition={{ type: 'spring' }}
          >
            <div className="w-[8vw] h-[8vw] rounded-2xl bg-secondary border-2 border-primary flex items-center justify-center shadow-[0_0_20px_rgba(17,140,113,0.3)]">
              <span className="text-[1.5vw] font-bold text-white">الواجهة</span>
            </div>
            <span className="text-[1vw] text-white/60 mt-2 font-mono">React</span>
          </motion.div>

          {/* Node */}
          <motion.div 
            className="flex flex-col items-center z-20"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: phase >= 1 ? 1 : 0, opacity: phase >= 1 ? 1 : 0 }}
            transition={{ type: 'spring', delay: 0.1 }}
          >
            <div className="w-[10vw] h-[10vw] rounded-full bg-primary border-4 border-accent flex items-center justify-center shadow-[0_0_30px_rgba(212,175,55,0.4)]">
              <span className="text-[2vw] font-bold text-background">الخادم</span>
            </div>
            <span className="text-[1vw] text-white/60 mt-2 font-mono">Node.js</span>
          </motion.div>

          {/* PostgreSQL */}
          <motion.div 
            className="flex flex-col items-center z-20"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: phase >= 1 ? 1 : 0, opacity: phase >= 1 ? 1 : 0 }}
            transition={{ type: 'spring', delay: 0.2 }}
          >
            <div className="w-[8vw] h-[8vw] rounded-2xl bg-secondary border-2 border-primary flex items-center justify-center shadow-[0_0_20px_rgba(17,140,113,0.3)]">
              <span className="text-[1.5vw] font-bold text-white text-center leading-tight">قاعدة<br/>البيانات</span>
            </div>
            <span className="text-[1vw] text-white/60 mt-2 font-mono">PostgreSQL</span>
          </motion.div>

          {/* Connecting Lines */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none z-10">
            <motion.path
              d="M 15% 50% L 40% 50%"
              stroke="var(--color-primary)"
              strokeWidth="4"
              strokeDasharray="10 5"
              fill="none"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: phase >= 2 ? 1 : 0 }}
              transition={{ duration: 1 }}
            />
            <motion.path
              d="M 60% 50% L 85% 50%"
              stroke="var(--color-primary)"
              strokeWidth="4"
              strokeDasharray="10 5"
              fill="none"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: phase >= 2 ? 1 : 0 }}
              transition={{ duration: 1 }}
            />
          </svg>
        </div>

        {/* Bullets floating around */}
        <motion.div 
          className="absolute top-0 right-0 bg-secondary/80 border border-white/10 px-6 py-3 rounded-full backdrop-blur-md"
          initial={{ opacity: 0, y: 20, scale: 0.8 }}
          animate={{ opacity: phase >= 3 ? 1 : 0, y: phase >= 3 ? 0 : 20, scale: phase >= 3 ? 1 : 0.8 }}
          transition={{ type: 'spring' }}
        >
          <span className="text-[1.5vw] font-bold text-white">نسخ احتياطي يومي تلقائي</span>
        </motion.div>

        <motion.div 
          className="absolute bottom-0 right-[20%] bg-secondary/80 border border-white/10 px-6 py-3 rounded-full backdrop-blur-md"
          initial={{ opacity: 0, y: -20, scale: 0.8 }}
          animate={{ opacity: phase >= 4 ? 1 : 0, y: phase >= 4 ? 0 : -20, scale: phase >= 4 ? 1 : 0.8 }}
          transition={{ type: 'spring' }}
        >
          <span className="text-[1.5vw] font-bold text-white">أداء عالٍ ومراقبة لحظية</span>
        </motion.div>

        <motion.div 
          className="absolute top-[20%] left-0 bg-primary/80 border border-accent/50 px-6 py-3 rounded-full backdrop-blur-md"
          initial={{ opacity: 0, x: -50, scale: 0.8 }}
          animate={{ opacity: phase >= 5 ? 1 : 0, x: phase >= 5 ? 0 : -50, scale: phase >= 5 ? 1 : 0.8 }}
          transition={{ type: 'spring' }}
        >
          <span className="text-[1.5vw] font-bold text-white">متوافق مع هيئة الزكاة والضريبة</span>
        </motion.div>
        
      </div>
    </motion.div>
  );
}
