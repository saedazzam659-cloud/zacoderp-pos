import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200), // title
      setTimeout(() => setPhase(2), 600), // devices image
      setTimeout(() => setPhase(3), 1200), // features list
      setTimeout(() => setPhase(4), 1800), // payments image
      setTimeout(() => setPhase(5), 4500), // exit
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
        
        {/* Right Side: Text & Features */}
        <div className="w-[45%] flex flex-col justify-center gap-8">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            <h2 className="text-[4vw] font-display font-black text-white leading-tight">
              يعمل في كل مكان،<br/>حتى <span className="text-secondary">بدون إنترنت</span>
            </h2>
          </motion.div>

          <div className="flex flex-col gap-6 mt-4">
            {[
              { title: "متعدد الأجهزة", desc: "يعمل على الأجهزة اللوحية والجوالات" },
              { title: "دعم الأوفلاين", desc: "لا تتوقف مبيعاتك عند انقطاع الشبكة" },
              { title: "مدفوعات متكاملة", desc: "مدى، Apple Pay، والبطاقات الائتمانية" },
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

        {/* Left Side: Images */}
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
              alt="POS Devices" 
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
              alt="Payments" 
            />
          </motion.div>
        </div>

      </div>
    </motion.div>
  );
}
