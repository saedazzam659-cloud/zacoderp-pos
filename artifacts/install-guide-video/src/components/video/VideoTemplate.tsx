import { motion, AnimatePresence } from 'framer-motion';
import { useVideoPlayer } from '@/lib/video/hooks';
import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';
import { Scene5 } from './video_scenes/Scene5';

const SCENE_DURATIONS = {
  open: 5000,
  zatca: 6000,
  devices: 5000,
  analytics: 5000,
  close: 5000,
};

export default function VideoTemplate() {
  const { currentScene } = useVideoPlayer({ durations: SCENE_DURATIONS });

  return (
    <div className="relative w-full h-screen overflow-hidden bg-bg-dark font-body text-text-primary flex items-center justify-center">
      {/* Persistent Background Layer */}
      <div className="absolute inset-0 z-0">
        {/* Base dark color */}
        <div className="absolute inset-0 bg-bg-dark" />
        
        {/* Subtle noise texture */}
        <div className="absolute inset-0 bg-noise opacity-[0.03] mix-blend-overlay" />
        
        {/* Animated gradients */}
        <motion.div 
          className="absolute w-[80vw] h-[80vw] rounded-full blur-[100px] opacity-30 mix-blend-screen"
          style={{ background: 'radial-gradient(circle, var(--color-primary), transparent 70%)' }}
          animate={{ 
            x: ['-20vw', '40vw', '10vw'], 
            y: ['-10vh', '30vh', '60vh'],
            scale: [1, 1.2, 0.9]
          }}
          transition={{ duration: 15, repeat: Infinity, ease: 'easeInOut' }}
        />
        
        <motion.div 
          className="absolute w-[60vw] h-[60vw] rounded-full blur-[100px] opacity-20 mix-blend-screen"
          style={{ background: 'radial-gradient(circle, var(--color-secondary), transparent 70%)' }}
          animate={{ 
            x: ['60vw', '-10vw', '40vw'], 
            y: ['60vh', '10vh', '-20vh'],
            scale: [0.8, 1.3, 1]
          }}
          transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
        />
        
        {/* Subtle geometric grid pattern that fades based on scene */}
        <motion.div 
          className="absolute inset-0"
          style={{
            backgroundImage: `linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px)`,
            backgroundSize: '4vw 4vw'
          }}
          animate={{ 
            opacity: currentScene === 1 || currentScene === 3 ? 0.8 : 0.2,
            scale: currentScene === 1 ? 1.05 : 1
          }}
          transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>

      {/* Persistent Midground Accent */}
      <motion.div
        className="absolute top-0 right-0 w-[40vw] h-[100vh] bg-gradient-to-l from-primary/10 to-transparent z-0"
        animate={{
          x: currentScene === 0 ? '0%' : currentScene === 4 ? '0%' : '100%',
          opacity: currentScene === 0 || currentScene === 4 ? 1 : 0
        }}
        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
      />

      {/* Main Content Area */}
      <div className="relative z-10 w-full h-full flex items-center justify-center">
        <AnimatePresence initial={false} mode="wait">
          {currentScene === 0 && <Scene1 key="open" />}
          {currentScene === 1 && <Scene2 key="zatca" />}
          {currentScene === 2 && <Scene3 key="devices" />}
          {currentScene === 3 && <Scene4 key="analytics" />}
          {currentScene === 4 && <Scene5 key="close" />}
        </AnimatePresence>
      </div>
    </div>
  );
}
