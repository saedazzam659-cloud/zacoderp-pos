import { motion, AnimatePresence } from 'framer-motion';
import { useVideoPlayer } from '@/lib/video';
import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';
import { Scene5 } from './video_scenes/Scene5';
import { Scene6 } from './video_scenes/Scene6';
import { Scene7 } from './video_scenes/Scene7';

const SCENE_DURATIONS = {
  s1_hook: 5000,
  s2_paths: 6000,
  s3_local: 12000,
  s4_pivot: 3000,
  s5_cloud: 14000,
  s6_why: 8000,
  s7_outro: 6000,
};

// SVG Arabesque Star Pattern for background
const ArabesquePattern = () => (
  <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <pattern id="arabesque" width="100" height="100" patternUnits="userSpaceOnUse" patternTransform="scale(2)">
        <path
          d="M50 0L60 40L100 50L60 60L50 100L40 60L0 50L40 40Z"
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth="0.5"
          strokeOpacity="0.3"
        />
        <circle cx="50" cy="50" r="30" fill="none" stroke="var(--color-accent)" strokeWidth="0.2" strokeOpacity="0.2" />
        <path
          d="M15 15L35 35M85 15L65 35M15 85L35 65M85 85L65 65"
          stroke="var(--color-primary)"
          strokeWidth="0.5"
          strokeOpacity="0.2"
        />
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#arabesque)" />
  </svg>
);

export default function VideoTemplate() {
  const { currentScene } = useVideoPlayer({ durations: SCENE_DURATIONS });

  return (
    <div className="relative w-full h-screen overflow-hidden bg-background text-foreground">
      {/* Persistent Background Layer */}
      <div className="absolute inset-0 z-0">
        <video
          className="absolute inset-0 w-full h-full object-cover opacity-20 mix-blend-screen"
          src={`${import.meta.env.BASE_URL}videos/bg.mp4`}
          autoPlay
          muted
          loop
          playsInline
        />
        
        <motion.div
          className="absolute inset-0"
          animate={{
            x: ['0%', '-5%', '0%'],
            y: ['0%', '2%', '0%'],
            rotate: [0, 2, 0]
          }}
          transition={{ duration: 30, repeat: Infinity, ease: 'linear' }}
        >
          <ArabesquePattern />
        </motion.div>

        {/* Ambient Gradients */}
        <motion.div
          className="absolute w-[80vw] h-[80vh] rounded-full opacity-30 blur-[80px]"
          style={{ background: 'radial-gradient(circle, var(--color-primary), transparent 70%)' }}
          animate={{
            x: ['-20%', '20%', '-20%'],
            y: ['-20%', '10%', '-20%'],
            scale: [1, 1.2, 1]
          }}
          transition={{ duration: 20, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute w-[60vw] h-[60vh] rounded-full opacity-20 blur-[60px] right-0 bottom-0"
          style={{ background: 'radial-gradient(circle, var(--color-secondary), transparent 70%)' }}
          animate={{
            x: ['20%', '-10%', '20%'],
            y: ['20%', '-20%', '20%'],
            scale: [1, 1.3, 1]
          }}
          transition={{ duration: 25, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>

      {/* Persistent Terminal - Lives outside AnimatePresence so it can smoothly resize/move across scenes */}
      <motion.div
        className="absolute z-20 overflow-hidden border border-white/10 rounded-xl bg-[#0d1117] shadow-2xl flex flex-col"
        animate={{
          opacity: (currentScene === 2 || currentScene === 4) ? 1 : 0,
          scale: (currentScene === 2 || currentScene === 4) ? 1 : 0.9,
          x: currentScene === 2 ? '5vw' : currentScene === 4 ? '45vw' : '50vw',
          y: currentScene === 2 ? '20vh' : currentScene === 4 ? '15vh' : '100vh',
          width: currentScene === 2 ? '50vw' : currentScene === 4 ? '45vw' : '0vw',
          height: currentScene === 2 ? '50vh' : currentScene === 4 ? '60vh' : '0vh',
        }}
        initial={false}
        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="h-8 bg-[#161b22] border-b border-white/5 flex items-center px-4 gap-2 w-full shrink-0">
          <div className="w-3 h-3 rounded-full bg-[#ff5f56]" />
          <div className="w-3 h-3 rounded-full bg-[#ffbd2e]" />
          <div className="w-3 h-3 rounded-full bg-[#27c93f]" />
          <div className="ml-4 text-xs font-mono text-white/40">bash</div>
        </div>
        <div className="p-6 font-mono text-[1.2vw] leading-relaxed text-[#c9d1d9] flex-1 overflow-hidden dir-ltr text-left">
          {/* Terminal content is injected by the scenes via a React context or just matched visually. 
              For simplicity here, we'll render the terminal content inside the scenes and make this a purely aesthetic background box. */}
        </div>
      </motion.div>

      {/* Scene Content */}
      <AnimatePresence initial={false} mode="wait">
        {currentScene === 0 && <Scene1 key="s1" />}
        {currentScene === 1 && <Scene2 key="s2" />}
        {currentScene === 2 && <Scene3 key="s3" />}
        {currentScene === 3 && <Scene4 key="s4" />}
        {currentScene === 4 && <Scene5 key="s5" />}
        {currentScene === 5 && <Scene6 key="s6" />}
        {currentScene === 6 && <Scene7 key="s7" />}
      </AnimatePresence>
    </div>
  );
}
