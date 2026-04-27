import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene4() {
  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center z-10"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="w-[30vw] h-[30vw] rounded-full bg-primary flex items-center justify-center relative overflow-hidden"
        initial={{ scale: 0.2, opacity: 0 }}
        animate={{ scale: 20, opacity: 1 }}
        transition={{ duration: 2, ease: "easeInOut" }}
      />
      
      <motion.div 
        className="absolute inset-0 flex items-center justify-center"
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.5, duration: 1, type: "spring" }}
      >
        <h2 className="text-[8vw] font-black text-white text-shadow-glow">
          الآن، للسحابة
        </h2>
      </motion.div>
    </motion.div>
  );
}
