import { motion } from 'framer-motion';

export function Scene7() {
  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center z-10"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, filter: 'blur(20px)' }}
      transition={{ duration: 1 }}
    >
      <motion.div
        className="w-[12vw] h-[12vw] rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center mb-8 relative border-2 border-accent shadow-[0_0_50px_rgba(212,175,55,0.3)]"
        initial={{ scale: 0, rotate: -180 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 200, damping: 20 }}
      >
        <svg width="50%" height="50%" viewBox="0 0 24 24" fill="none" stroke="var(--color-bg-light)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
          <path d="M2 17l10 5 10-5"></path>
          <path d="M2 12l10 5 10-5"></path>
        </svg>
      </motion.div>

      <motion.h1 
        className="text-[5vw] font-black text-white mb-4 text-shadow-glow"
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.8 }}
      >
        نظام الفاتورة الإلكترونية السعودية
      </motion.h1>

      <motion.p 
        className="text-[2vw] text-accent font-bold tracking-widest"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8, duration: 1 }}
      >
        جاهز للتشغيل في دقائق
      </motion.p>
    </motion.div>
  );
}
