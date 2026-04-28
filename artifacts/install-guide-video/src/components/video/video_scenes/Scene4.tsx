import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200), // title
      setTimeout(() => setPhase(2), 600), // analytics image
      setTimeout(() => setPhase(3), 1200), // stats cards
      setTimeout(() => setPhase(4), 4500), // exit
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  const stats = [
    { label: "المبيعات اليومية", value: "SAR 14,500", trend: "+12%" },
    { label: "الطلبات", value: "342", trend: "+5%" },
    { label: "المخزون النشط", value: "1,204", trend: "-2%" },
  ];

  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center z-10 w-full h-full"
      initial={{ opacity: 0, scale: 1.1 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, y: -100, filter: 'blur(10px)' }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="absolute inset-0 z-0 opacity-50">
        <img 
          src={`${import.meta.env.BASE_URL}images/analytics.png`} 
          className="w-full h-full object-cover mix-blend-screen" 
          alt="" 
        />
        <div className="absolute inset-0 bg-gradient-to-t from-bg-dark via-transparent to-bg-dark" />
      </div>

      <div className="relative z-10 flex flex-col items-center justify-center w-[80vw] h-full text-center gap-12">
        <motion.div
          initial={{ opacity: 0, y: -30 }}
          animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: -30 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          <h2 className="text-[4.5vw] font-display font-black text-white leading-tight text-shadow-glow">
            تحليلات <span className="text-primary">لحظية</span>،<br/>لقرارات أذكى.
          </h2>
          <p className="text-[1.8vw] text-text-muted mt-4">
            إدارة المخزون، المبيعات، والفروع من لوحة تحكم واحدة.
          </p>
        </motion.div>

        <div className="flex flex-row gap-8 dir-rtl">
          {stats.map((stat, i) => (
            <motion.div
              key={i}
              className="bg-card/40 border border-border backdrop-blur-xl p-8 rounded-3xl min-w-[20vw] flex flex-col items-start text-right shadow-2xl relative overflow-hidden"
              initial={{ opacity: 0, y: 50, rotateX: 30 }}
              animate={phase >= 3 ? { opacity: 1, y: 0, rotateX: 0 } : { opacity: 0, y: 50, rotateX: 30 }}
              transition={{ type: 'spring', stiffness: 200, damping: 20, delay: i * 0.15 }}
              style={{ perspective: '1000px' }}
            >
              <motion.div 
                className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary to-secondary"
                initial={{ scaleX: 0 }}
                animate={phase >= 3 ? { scaleX: 1 } : { scaleX: 0 }}
                transition={{ duration: 1, delay: 0.5 + i * 0.15 }}
                style={{ originX: 1 }}
              />
              
              <span className="text-[1.2vw] text-text-muted font-bold mb-2">{stat.label}</span>
              <span className="text-[3vw] font-mono font-bold text-white mb-4 leading-none">{stat.value}</span>
              <div className="flex items-center gap-2">
                <div className={`px-2 py-1 rounded-md text-[1vw] font-bold ${stat.trend.startsWith('+') ? 'bg-primary/20 text-primary' : 'bg-red-500/20 text-red-400'}`}>
                  {stat.trend}
                </div>
                <span className="text-[1vw] text-text-muted">مقارنة بالأمس</span>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
