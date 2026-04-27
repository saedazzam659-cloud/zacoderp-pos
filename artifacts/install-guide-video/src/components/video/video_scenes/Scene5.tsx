import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

const Typewriter = ({ text, delay = 0, onComplete = () => {} }: { text: string, delay?: number, onComplete?: () => void }) => {
  const [displayed, setDisplayed] = useState('');
  
  useEffect(() => {
    let timeout: NodeJS.Timeout;
    if (delay > 0) {
      timeout = setTimeout(() => startTyping(), delay);
    } else {
      startTyping();
    }
    
    function startTyping() {
      let i = 0;
      const interval = setInterval(() => {
        setDisplayed(text.substring(0, i + 1));
        i++;
        if (i >= text.length) {
          clearInterval(interval);
          onComplete();
        }
      }, 20); // Faster for scene 5
    }
    
    return () => clearTimeout(timeout);
  }, [text, delay]);

  return <span>{displayed}</span>;
};

export function Scene5() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),  // Step 1
      setTimeout(() => setPhase(2), 2500), // Step 2
      setTimeout(() => setPhase(3), 5500), // Step 3
      setTimeout(() => setPhase(4), 8500), // Step 4
      setTimeout(() => setPhase(5), 11000), // Show domain lock
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex z-10 bg-primary/90 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
    >
      {/* Right side text content (RTL) */}
      <div className="w-[45vw] h-full flex flex-col justify-center px-[5vw] ml-auto dir-rtl text-right z-20 relative">
        <motion.h2 
          className="text-[3.5vw] font-black text-white mb-10"
          initial={{ opacity: 0, x: 50 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8 }}
        >
          سيرفر سحابي
        </motion.h2>

        <div className="space-y-8">
          {/* Step 1 */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: phase >= 1 ? 1 : 0, y: phase >= 1 ? 0 : 20 }}
          >
            <div className="flex items-center gap-4 mb-1">
              <div className="w-8 h-8 rounded-full bg-accent text-background flex items-center justify-center font-bold text-xl">1</div>
              <h3 className="text-[1.8vw] font-bold text-white">تجهيز سيرفر VPS</h3>
            </div>
            <p className="text-[1.1vw] text-white/80 mr-12 font-mono">Ubuntu 22.04</p>
          </motion.div>

          {/* Step 2 */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: phase >= 2 ? 1 : 0, y: phase >= 2 ? 0 : 20 }}
          >
            <div className="flex items-center gap-4 mb-1">
              <div className="w-8 h-8 rounded-full bg-accent text-background flex items-center justify-center font-bold text-xl">2</div>
              <h3 className="text-[1.8vw] font-bold text-white">تركيب المتطلبات</h3>
            </div>
            <p className="text-[1.1vw] text-white/80 mr-12 font-mono">Node.js + PostgreSQL + Nginx + PM2</p>
          </motion.div>

          {/* Step 3 */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: phase >= 3 ? 1 : 0, y: phase >= 3 ? 0 : 20 }}
          >
            <div className="flex items-center gap-4 mb-1">
              <div className="w-8 h-8 rounded-full bg-accent text-background flex items-center justify-center font-bold text-xl">3</div>
              <h3 className="text-[1.8vw] font-bold text-white">بناء الإنتاج وتشغيله</h3>
            </div>
          </motion.div>

          {/* Step 4 */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: phase >= 4 ? 1 : 0, y: phase >= 4 ? 0 : 20 }}
          >
            <div className="flex items-center gap-4 mb-1">
              <div className="w-8 h-8 rounded-full bg-accent text-background flex items-center justify-center font-bold text-xl">4</div>
              <h3 className="text-[1.8vw] font-bold text-white">تفعيل HTTPS مجاني</h3>
            </div>
          </motion.div>
        </div>
      </div>

      {/* Terminal Content Overlay */}
      <div className="absolute left-[45vw] top-[15vh] w-[45vw] h-[60vh] pt-12 px-6 pb-6 font-mono text-[1vw] leading-relaxed text-[#c9d1d9] flex flex-col z-30 pointer-events-none dir-ltr text-left">
        {phase >= 1 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[#a5d6ff]">
            Connecting to root@192.168.1.100...
            <br />Welcome to Ubuntu 22.04.3 LTS
          </motion.div>
        )}
        {phase >= 2 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
            <span className="text-[#7ee787]">root@vps</span><span className="text-white">:</span><span className="text-[#79c0ff]">~</span><span className="text-white">#</span>{' '}
            <Typewriter text="apt install nodejs postgresql nginx && npm i -g pnpm pm2" delay={0} />
          </motion.div>
        )}
        {phase >= 3 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
            <span className="text-[#7ee787]">root@vps</span><span className="text-white">:</span><span className="text-[#79c0ff]">/var/www/zatca</span><span className="text-white">#</span>{' '}
            <Typewriter text="pnpm install && pnpm build && pm2 start ecosystem.config.cjs" delay={0} />
          </motion.div>
        )}
        {phase >= 4 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
            <span className="text-[#7ee787]">root@vps</span><span className="text-white">:</span><span className="text-[#79c0ff]">~</span><span className="text-white">#</span>{' '}
            <Typewriter text="certbot --nginx -d yourdomain.sa" delay={0} />
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1 }}
              className="text-[#7ee787] mt-2"
            >
              Successfully deployed certificate for yourdomain.sa
            </motion.div>
          </motion.div>
        )}
      </div>

      {/* Domain Padlock Reveal */}
      <motion.div 
        className="absolute bottom-[10vh] left-[55vw] bg-white rounded-lg shadow-2xl px-8 py-4 flex items-center gap-4 z-40"
        initial={{ opacity: 0, y: 50, scale: 0.8 }}
        animate={{ 
          opacity: phase >= 5 ? 1 : 0, 
          y: phase >= 5 ? 0 : 50,
          scale: phase >= 5 ? 1 : 0.8
        }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      >
        <motion.div
          initial={{ rotate: -90, opacity: 0 }}
          animate={{ rotate: phase >= 5 ? 0 : -90, opacity: phase >= 5 ? 1 : 0 }}
          transition={{ delay: 0.5, duration: 0.5 }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
        </motion.div>
        <span className="text-[1.5vw] font-mono text-gray-800 tracking-tight">https://yourdomain.sa</span>
      </motion.div>
    </motion.div>
  );
}
