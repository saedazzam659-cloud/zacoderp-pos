import { useEffect, useState } from "react";
import { Sparkles, Loader2, Database, Box } from "lucide-react";

export interface DemoProvisioningOverlayProps {
  isVisible: boolean;
  progress?: number; 
  statusMessage?: string;
}

export function DemoProvisioningOverlay({
  isVisible,
  progress = 0,
  statusMessage = "جارٍ تهيئة البيانات..."
}: DemoProvisioningOverlayProps) {
  const [fakeProgress, setFakeProgress] = useState(0);

  useEffect(() => {
    if (!isVisible) {
      setFakeProgress(0);
      return;
    }
    
    let timer: number;
    const tick = () => {
      setFakeProgress(p => {
        // Asymptotically approach 96% to simulate ongoing work without capping early
        const diff = 96 - p;
        const inc = Math.max(0.05, diff * 0.03); 
        return p + inc;
      });
      timer = window.setTimeout(tick, 300);
    };
    
    timer = window.setTimeout(tick, 100);
    return () => clearTimeout(timer);
  }, [isVisible]);

  // Use exact progress if > 0, otherwise fall back to the smooth fake progress
  const displayProgress = progress > 0 ? progress : fakeProgress;

  // Micro-interaction: Evolve the icon as progress advances
  let CurrentIcon = Box;
  if (displayProgress > 35) CurrentIcon = Database;
  if (displayProgress > 75) CurrentIcon = Sparkles;

  if (!isVisible) return null;

  return (
    <div 
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-md p-4 animate-fade-in"
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-provisioning-title"
      aria-describedby="demo-provisioning-description"
    >
      <style>{`
        @keyframes shimmer-rtl {
          0% { transform: translateX(100%); }
          100% { transform: translateX(-100%); }
        }
        .animate-shimmer-rtl {
          animation: shimmer-rtl 2.5s infinite linear;
        }
        @keyframes fade-in-scale {
          0% { opacity: 0; transform: scale(0.96); }
          100% { opacity: 1; transform: scale(1); }
        }
        .animate-fade-in-scale {
          animation: fade-in-scale 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        @keyframes fade-in {
          0% { opacity: 0; }
          100% { opacity: 1; }
        }
        .animate-fade-in {
          animation: fade-in 0.3s ease-out forwards;
        }
      `}</style>
      
      <div className="max-w-md w-full bg-card border border-border/60 shadow-2xl shadow-primary/5 rounded-[2rem] p-8 sm:p-10 flex flex-col items-center text-center relative overflow-hidden animate-fade-in-scale">
        
        {/* Background ambient light */}
        <div className="absolute top-0 inset-x-0 h-40 bg-gradient-to-b from-primary/10 to-transparent pointer-events-none" />

        {/* Animated Icon cluster */}
        <div className="relative flex items-center justify-center w-24 h-24 mb-6 mt-2">
          {/* Pulsing rings */}
          <div className="absolute inset-0 rounded-full bg-primary/10 animate-ping motion-reduce:animate-none [animation-duration:3s]" />
          <div className="absolute inset-2 rounded-full bg-primary/10 animate-ping motion-reduce:animate-none [animation-duration:3s] [animation-delay:1s]" />
          
          {/* Center icon block */}
          <div className="relative bg-gradient-to-br from-primary to-primary/90 text-primary-foreground w-16 h-16 rounded-2xl rotate-3 shadow-lg shadow-primary/20 flex items-center justify-center transition-transform hover:rotate-6">
            <CurrentIcon className="w-8 h-8 animate-pulse motion-reduce:animate-none transition-all duration-500" />
          </div>
        </div>

        <h2 id="demo-provisioning-title" className="text-2xl font-bold text-foreground mb-3 tracking-tight">
          جارٍ تجهيز حسابك التجريبي
        </h2>
        
        <p id="demo-provisioning-description" className="text-muted-foreground text-sm leading-relaxed mb-7 max-w-sm">
          نقوم الآن بإعداد حساب الديمو وتجهيز البيانات لأول استخدام، قد تستغرق العملية لحظات فقط.
        </p>

        {/* Progress Section */}
        <div className="w-full space-y-3 relative z-10">
          <div className="flex items-center justify-between gap-3 text-xs font-medium px-1">
            <span className="text-primary flex items-center gap-2 bg-primary/10 px-2.5 py-1 rounded-full">
              <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" />
              {displayProgress >= 100 ? "اكتمل التجهيز، جارٍ الدخول..." : statusMessage}
            </span>
            <span className="text-muted-foreground font-mono font-semibold" dir="ltr">
              {Math.min(100, Math.floor(displayProgress))}%
            </span>
          </div>
          
          <div
            className="h-2.5 w-full bg-secondary/50 overflow-hidden rounded-full relative ring-1 ring-inset ring-border/50"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.floor(displayProgress))}
            aria-live="polite"
          >
            <div 
              className="absolute top-0 bottom-0 right-0 h-full bg-primary transition-all duration-700 ease-out rounded-full"
              style={{ width: `${Math.min(100, Math.max(2, displayProgress))}%` }}
            >
              {/* Shimmer effect inside the bar */}
              <div className="absolute inset-0 bg-gradient-to-l from-transparent via-white/30 to-transparent w-full animate-shimmer-rtl motion-reduce:animate-none" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            يرجى الانتظار... سيتم الدخول تلقائيًا عند اكتمال التجهيز.
          </p>
        </div>
      </div>
    </div>
  );
}
