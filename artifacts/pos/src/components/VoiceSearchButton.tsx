import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type SR = any;

export interface VoiceSearchButtonProps {
  onResult: (text: string) => void;
  lang?: string;
  className?: string;
}

export default function VoiceSearchButton({
  onResult, lang = "ar-SA", className = "",
}: VoiceSearchButtonProps) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const recRef = useRef<SR>(null);

  useEffect(() => {
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    setSupported(!!SR);
  }, []);

  const start = () => {
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.lang = lang;
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => { setListening(true); setInterim(""); };
    r.onerror = (e: any) => {
      setListening(false); setInterim("");
      if (e.error && e.error !== "no-speech" && e.error !== "aborted") {
        alert(`خطأ في الإدخال الصوتي: ${e.error}`);
      }
    };
    r.onend = () => { setListening(false); setInterim(""); };
    r.onresult = (event: any) => {
      let finalText = ""; let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += t; else interimText += t;
      }
      if (interimText) setInterim(interimText);
      if (finalText) {
        const cleaned = finalText.trim();
        if (cleaned) onResult(cleaned);
      }
    };
    recRef.current = r;
    try { r.start(); } catch { /* ignore double-start */ }
  };

  const stop = () => {
    try { recRef.current?.stop(); } catch { /* ignore */ }
    setListening(false);
  };

  if (!supported) return null;

  return (
    <div className={`relative ${className}`}>
      <Button
        type="button"
        size="icon"
        variant={listening ? "destructive" : "secondary"}
        onClick={listening ? stop : start}
        title={listening ? "إيقاف الإدخال الصوتي" : "البحث الصوتي"}
        className={listening ? "animate-pulse" : ""}
      >
        {listening ? <MicOff className="h-4 w-4" /> :
          recRef.current && interim ? <Loader2 className="h-4 w-4 animate-spin" /> :
          <Mic className="h-4 w-4" />}
      </Button>
      {listening && interim && (
        <div className="absolute top-full mt-1 right-0 bg-slate-900 border border-amber-500/50 rounded px-2 py-1 text-xs whitespace-nowrap z-10 shadow-lg">
          {interim}
        </div>
      )}
    </div>
  );
}
