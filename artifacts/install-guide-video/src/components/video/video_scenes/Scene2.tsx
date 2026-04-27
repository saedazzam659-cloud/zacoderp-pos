import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 300), // panels slide in
      setTimeout(() => setPhase(2), 1500), // text appears
      setTimeout(() => setPhase(3), 2500), // pulse icons
      setTimeout(() => setPhase(4), 4500), // commit to local
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex z-10"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
    >
      {/* Right Side: Local */}
      <motion.div 
        className="w-1/2 h-full flex flex-col items-center justify-center relative border-l border-white/10 overflow-hidden"
        initial={{ x: '100%' }}
        animate={{ 
          x: phase >= 1 ? '0%' : '100%',
          width: phase >= 4 ? '100%' : '50%',
          zIndex: phase >= 4 ? 30 : 10
        }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      >
        <motion.div 
          className="absolute inset-0 bg-gradient-to-bl from-primary/10 to-transparent"
          animate={{ opacity: phase >= 4 ? 0 : 1 }}
        />
        
        <motion.div
          animate={{ 
            scale: phase >= 3 ? (phase >= 4 ? 1.5 : 1.1) : 1,
            x: phase >= 4 ? '-25vw' : 0,
            opacity: phase >= 4 ? 0 : 1
          }}
          transition={{ duration: phase >= 4 ? 1 : 0.4 }}
          className="flex flex-col items-center"
        >
          <img 
            src={`${import.meta.env.BASE_URL}images/local-server.png`} 
            alt="Local Server" 
            className="w-[20vw] h-[20vw] object-contain drop-shadow-2xl"
          />
          <motion.h2 
            className="text-[3.5vw] font-bold mt-8 text-white"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: phase >= 2 ? 1 : 0, y: phase >= 2 ? 0 : 20 }}
          >
            سيرفر محلي
          </motion.h2>
        </motion.div>
      </motion.div>

      {/* Left Side: Cloud */}
      <motion.div 
        className="w-1/2 h-full flex flex-col items-center justify-center relative overflow-hidden"
        initial={{ x: '-100%' }}
        animate={{ 
          x: phase >= 1 ? '0%' : '-100%',
          opacity: phase >= 4 ? 0 : 1
        }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      >
        <motion.div className="absolute inset-0 bg-gradient-to-br from-accent/10 to-transparent" />
        
        <motion.div
          animate={{ scale: phase >= 3 && phase < 4 ? 1.1 : 1 }}
          transition={{ duration: 0.4 }}
          className="flex flex-col items-center"
        >
          <img 
            src={`${import.meta.env.BASE_URL}images/cloud-server.png`} 
            alt="Cloud Server" 
            className="w-[20vw] h-[20vw] object-contain drop-shadow-2xl"
          />
          <motion.h2 
            className="text-[3.5vw] font-bold mt-8 text-white"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: phase >= 2 ? 1 : 0, y: phase >= 2 ? 0 : 20 }}
          >
            سيرفر سحابي
          </motion.h2>
        </motion.div>
      </motion.div>

      {/* OR Badge */}
      <motion.div 
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[6vw] h-[6vw] bg-background border-2 border-white/20 rounded-full flex items-center justify-center z-20"
        initial={{ scale: 0, rotate: -180 }}
        animate={{ 
          scale: phase >= 2 ? (phase >= 4 ? 0 : 1) : 0, 
          rotate: phase >= 2 ? 0 : -180 
        }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
      >
        <span className="text-[2vw] font-bold text-accent">أو</span>
      </motion.div>
    </motion.div>
  );
}
