import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

// A simple typewriter component for the terminal
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
      }, 30); // ms per char
    }
    
    return () => {
      clearTimeout(timeout);
    };
  }, [text, delay]);

  return <span>{displayed}</span>;
};

export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),  // Step 1 title
      setTimeout(() => setPhase(2), 1000), // Step 1 command 1
      setTimeout(() => setPhase(3), 3000), // Step 1 command 2
      setTimeout(() => setPhase(4), 5000), // Step 2 title & command
      setTimeout(() => setPhase(5), 7500), // Step 3 title & command
      setTimeout(() => setPhase(6), 10000), // Show browser mock
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex z-10"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, x: -100 }}
      transition={{ duration: 0.5 }}
    >
      {/* Left side text content (RTL so it appears on the right logically, but we place it using flex) */}
      <div className="w-[45vw] h-full flex flex-col justify-center px-[5vw] ml-auto dir-rtl text-right">
        <motion.h2 
          className="text-[3.5vw] font-black text-primary mb-12"
          initial={{ opacity: 0, x: 50 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8 }}
        >
          سيرفر محلي
        </motion.h2>

        <div className="space-y-10">
          {/* Step 1 */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: phase >= 1 ? 1 : 0, y: phase >= 1 ? 0 : 20 }}
          >
            <div className="flex items-center gap-4 mb-2">
              <div className="w-8 h-8 rounded-full bg-accent text-background flex items-center justify-center font-bold text-xl">1</div>
              <h3 className="text-[2vw] font-bold text-white">تركيب المتطلبات</h3>
            </div>
            <p className="text-[1.2vw] text-white/60 mr-12 font-mono">Node.js + pnpm + PostgreSQL</p>
          </motion.div>

          {/* Step 2 */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: phase >= 4 ? 1 : 0, y: phase >= 4 ? 0 : 20 }}
          >
            <div className="flex items-center gap-4 mb-2">
              <div className="w-8 h-8 rounded-full bg-accent text-background flex items-center justify-center font-bold text-xl">2</div>
              <h3 className="text-[2vw] font-bold text-white">تركيب المشروع</h3>
            </div>
          </motion.div>

          {/* Step 3 */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: phase >= 5 ? 1 : 0, y: phase >= 5 ? 0 : 20 }}
          >
            <div className="flex items-center gap-4 mb-2">
              <div className="w-8 h-8 rounded-full bg-accent text-background flex items-center justify-center font-bold text-xl">3</div>
              <h3 className="text-[2vw] font-bold text-white">تشغيل الخادم والواجهة</h3>
            </div>
          </motion.div>
        </div>
      </div>

      {/* Terminal Content Overlay (Matches the persistent terminal position) */}
      <div className="absolute left-[5vw] top-[20vh] w-[50vw] h-[50vh] pt-12 px-6 pb-6 font-mono text-[1.2vw] leading-relaxed text-[#c9d1d9] flex flex-col z-30 pointer-events-none dir-ltr text-left">
        {phase >= 2 && (
          <div>
            <span className="text-[#7ee787]">user@local</span><span className="text-white">:</span><span className="text-[#79c0ff]">~</span><span className="text-white">$</span>{' '}
            <Typewriter text="sudo apt install nodejs postgresql" delay={0} />
          </div>
        )}
        {phase >= 3 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
            <span className="text-[#7ee787]">user@local</span><span className="text-white">:</span><span className="text-[#79c0ff]">~</span><span className="text-white">$</span>{' '}
            <Typewriter text="npm i -g pnpm" delay={0} />
          </motion.div>
        )}
        {phase >= 4 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
            <span className="text-[#7ee787]">user@local</span><span className="text-white">:</span><span className="text-[#79c0ff]">~/zatca</span><span className="text-white">$</span>{' '}
            <Typewriter text="pnpm install" delay={0} />
          </motion.div>
        )}
        {phase >= 5 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
            <span className="text-[#7ee787]">user@local</span><span className="text-white">:</span><span className="text-[#79c0ff]">~/zatca</span><span className="text-white">$</span>{' '}
            <Typewriter text="pnpm --filter @workspace/api-server run dev" delay={0} />
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1 }}
              className="text-[#a5d6ff] mt-2"
            >
              VITE v5.0.0 ready in 320 ms<br/>
              ➜  Local:   http://localhost:5173/
            </motion.div>
          </motion.div>
        )}
      </div>

      {/* Browser Mockup */}
      <motion.div 
        className="absolute left-[10vw] top-[30vh] w-[40vw] h-[40vh] bg-white rounded-xl shadow-2xl border border-gray-200 z-40 overflow-hidden flex flex-col"
        initial={{ y: 100, opacity: 0, rotate: 5, scale: 0.8 }}
        animate={{ 
          y: phase >= 6 ? 0 : 100, 
          opacity: phase >= 6 ? 1 : 0,
          rotate: phase >= 6 ? -2 : 5,
          scale: phase >= 6 ? 1 : 0.8
        }}
        transition={{ type: 'spring', stiffness: 200, damping: 20 }}
      >
        <div className="h-8 bg-gray-100 border-b border-gray-200 flex items-center px-3 gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-red-400" />
          <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />
          <div className="w-2.5 h-2.5 rounded-full bg-green-400" />
          <div className="ml-4 bg-white px-24 py-1 rounded text-[0.8vw] text-gray-500 font-mono shadow-sm">
            localhost:5173
          </div>
        </div>
        <div className="flex-1 p-6 flex flex-col dir-rtl">
          {/* Mock UI */}
          <div className="h-10 w-48 bg-gray-200 rounded mb-6" />
          <div className="flex gap-4">
            <div className="w-1/4 space-y-3">
              <div className="h-8 w-full bg-primary/10 rounded border border-primary/20" />
              <div className="h-8 w-full bg-gray-100 rounded" />
              <div className="h-8 w-full bg-gray-100 rounded" />
            </div>
            <div className="w-3/4 bg-gray-50 rounded-lg p-4 border border-gray-100">
              <div className="h-6 w-32 bg-gray-200 rounded mb-4" />
              <div className="h-24 w-full bg-white rounded border border-gray-200" />
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
