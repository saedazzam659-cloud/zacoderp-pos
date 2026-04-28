import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

// ─── Scene 4 — AI insights surfaced as live KPIs ───────────────────
// Same three-card analytics layout the previous version had, but the
// labels now showcase what the AI engine produces autonomously
// (forecasts, anomaly detection, smart recommendations).
export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 600),
      setTimeout(() => setPhase(3), 1200),
      setTimeout(() => setPhase(4), 4500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  const stats = [
    { label: "تنبؤ مبيعات الأسبوع", value: "+12.4%", trend: "AI" },
    { label: "تنبيه ذكي", value: "نقص مخزون", trend: "اقترح طلب" },
    { label: "كفاءة العمليات", value: "94%", trend: "مرتفع" },
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
            قرارات أذكى <span className="text-primary">بدون مجهود</span>
          </h2>
          <p className="text-[1.8vw] text-text-muted mt-4">
            الذكاء الاصطناعي يحلّل، ينبّه، ويقترح. وأنت تركّز على نموّ عملك.
          </p>
        </motion.div>

        <div className="flex flex-row gap-8 dir-rtl flex-wrap justify-center">
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
              <span className="text-[2.5vw] font-mono font-bold text-white mb-4 leading-none">{stat.value}</span>
              <div className="flex items-center gap-2">
                <div className="px-2 py-1 rounded-md text-[1vw] font-bold bg-primary/20 text-primary">
                  {stat.trend}
                </div>
                <span className="text-[1vw] text-text-muted">بقوة الذكاء الاصطناعي</span>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
