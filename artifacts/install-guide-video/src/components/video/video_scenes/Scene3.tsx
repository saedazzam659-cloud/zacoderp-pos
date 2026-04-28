import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

// ─── Scene 3 — Ease of use ─────────────────────────────────────────
// Reframes the device-grid scene around the new ease-of-use promise:
// "ابدأ الآن — بدون تعقيد". Keeps the same two layered images so the
// asset pipeline (devices.png + payments.png) doesn't break.
export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 600),
      setTimeout(() => setPhase(3), 1200),
      setTimeout(() => setPhase(4), 1800),
      setTimeout(() => setPhase(5), 4500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center z-10 w-full h-full"
      initial={{ opacity: 0, x: 100 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -100, filter: 'blur(10px)' }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex flex-row items-center justify-between w-[85vw] h-[70vh] dir-rtl">
        <div className="w-[45%] flex flex-col justify-center gap-8">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            <h2 className="text-[4vw] font-display font-black text-white leading-tight">
              تجربة <span className="text-secondary">سهلة</span>،<br />من أول دقيقة
            </h2>
          </motion.div>

          <div className="flex flex-col gap-6 mt-4">
            {[
              { title: "إعداد فوري", desc: "ابدأ خلال دقيقتين بدون تركيب أو خبرة تقنية" },
              { title: "واجهة عربية أنيقة", desc: "كل القوائم والتقارير بالعربية، RTL أصيل" },
              { title: "يعمل في أي مكان", desc: "متصفح أو جوال أو جهاز لوحي — نفس التجربة" },
            ].map((item, i) => (
              <motion.div
                key={i}
                className="flex flex-row items-start gap-4"
                initial={{ opacity: 0, x: 50 }}
                animate={phase >= 3 ? { opacity: 1, x: 0 } : { opacity: 0, x: 50 }}
                transition={{ type: 'spring', stiffness: 300, damping: 25, delay: i * 0.15 }}
              >
                <div className="w-12 h-12 rounded-full bg-primary/20 border border-primary flex items-center justify-center shrink-0 mt-1">
                  <div className="w-4 h-4 rounded-full bg-secondary" />
                </div>
                <div>
                  <h3 className="text-[1.8vw] font-bold text-white mb-1">{item.title}</h3>
                  <p className="text-[1.2vw] text-text-muted">{item.desc}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        <div className="w-[50%] h-full relative perspective-1000 flex items-center justify-center">
          <motion.div
            className="w-[40vw] h-[40vw] absolute"
            initial={{ opacity: 0, scale: 0.8, rotateY: 20 }}
            animate={phase >= 2 ? { opacity: 1, scale: 1, rotateY: -10 } : { opacity: 0, scale: 0.8, rotateY: 20 }}
            transition={{ type: 'spring', stiffness: 200, damping: 20 }}
          >
            <img
              src={`${import.meta.env.BASE_URL}images/devices.png`}
              className="w-full h-full object-contain drop-shadow-2xl"
              alt="أجهزة متعددة"
            />
          </motion.div>

          <motion.div
            className="w-[15vw] h-[15vw] absolute -bottom-10 -left-10"
            initial={{ opacity: 0, scale: 0, y: 50 }}
            animate={phase >= 4 ? { opacity: 1, scale: 1, y: 0 } : { opacity: 0, scale: 0, y: 50 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
          >
            <img
              src={`${import.meta.env.BASE_URL}images/payments.png`}
              className="w-full h-full object-contain drop-shadow-lg mix-blend-screen"
              alt="مدفوعات"
            />
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
