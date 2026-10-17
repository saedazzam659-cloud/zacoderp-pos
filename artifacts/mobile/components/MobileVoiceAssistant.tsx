import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, Text, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';

type EffectiveSettings = { enabled?: boolean; language?: string };
type ParsedCommand = {
  kind?: 'navigate' | 'verb' | 'unknown';
  route?: string;
  verb?: string;
  label?: string;
  reason?: string;
};

const MOBILE_ROUTES: Record<string, string> = {
  '/sales/invoices/new': '/invoice/new',
  '/sales/quotations': '/quotations',
  '/sales/quotations/new': '/quotation/new',
  '/cash-transfers': '/cash-transfers',
  '/cash/receipts': '/cash-transfers',
  '/cash-expenses': '/cash-expenses',
};

export function MobileVoiceAssistant() {
  const c = useColors();
  const router = useRouter();
  const pathname = usePathname();
  const { mp } = useMobilePerms();
  const [enabled, setEnabled] = useState(false);
  const [language, setLanguage] = useState('ar-SA');
  const [open, setOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [working, setWorking] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [message, setMessage] = useState('');
  const handledRef = useRef(false);
  const speechRef = useRef<typeof import('expo-speech-recognition') | null>(null);
  const listenersRef = useRef<Array<{ remove: () => void }>>([]);

  useEffect(() => {
    let active = true;
    api<EffectiveSettings>('/api/voice-assistant/settings/me/effective')
      .then((settings) => {
        if (!active) return;
        setEnabled(settings.enabled === true);
        setLanguage(settings.language || 'ar-SA');
      })
      .catch(() => {
        if (active) setEnabled(false);
      });
    return () => { active = false; };
  }, []);

  const executeTranscript = useCallback(async (text: string) => {
    const command = text.trim();
    if (!command || handledRef.current) return;
    handledRef.current = true;
    setTranscript(command);
    setWorking(true);
    setMessage('');
    try {
      const parsed = await api<ParsedCommand>('/api/voice-assistant/parse-command', {
        method: 'POST',
        body: { transcript: command, contextRoute: pathname },
      });
      if (parsed.kind === 'navigate' && parsed.route) {
        const destination = MOBILE_ROUTES[parsed.route];
        if (destination) {
          setMessage(`الانتقال إلى ${parsed.label ?? 'الشاشة المطلوبة'}`);
          router.push(destination as never);
        } else {
          setMessage('تم فهم الأمر، لكن هذه الشاشة غير متاحة في تطبيق الموبايل حالياً.');
        }
      } else if (parsed.kind === 'verb' && parsed.verb === 'back') {
        setMessage('رجوع');
        router.back();
      } else if (parsed.kind === 'verb' && parsed.verb === 'home') {
        setMessage('الانتقال إلى الرئيسية');
        router.replace('/(tabs)' as never);
      } else if (parsed.kind === 'verb' && parsed.verb === 'save') {
        setMessage('راجع بيانات المستند ثم اضغط حفظ بنفسك.');
      } else {
        setMessage(parsed.reason ?? 'لم أتمكن من فهم الأمر.');
      }
    } catch {
      setMessage('تعذّر تحليل الأمر. تحقق من اتصال التطبيق ثم حاول مرة أخرى.');
    } finally {
      setWorking(false);
    }
  }, [pathname, router]);

  useEffect(() => () => {
    listenersRef.current.forEach((listener) => listener.remove());
    speechRef.current?.ExpoSpeechRecognitionModule.stop();
  }, []);

  const start = async () => {
    handledRef.current = false;
    setTranscript('');
    setMessage('');
    setOpen(true);
    try {
      const speech = speechRef.current ?? await import('expo-speech-recognition');
      speechRef.current = speech;
      if (!listenersRef.current.length) {
        const module = speech.ExpoSpeechRecognitionModule;
        listenersRef.current = [
          module.addListener('start', () => setListening(true)),
          module.addListener('end', () => setListening(false)),
          module.addListener('error', (event) => {
            setListening(false);
            setMessage(event.message || 'تعذّر تشغيل التعرف على الكلام.');
          }),
          module.addListener('result', (event) => {
            const text = event.results?.[0]?.transcript?.trim() ?? '';
            if (!text) return;
            setTranscript(text);
            if (event.isFinal) void executeTranscript(text);
          }),
        ];
      }
      if (Platform.OS !== 'web') {
        const permission = await speech.ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!permission.granted) {
          setMessage('اسمح بالميكروفون والتعرف على الكلام من إعدادات الجهاز.');
          return;
        }
      }
      speech.ExpoSpeechRecognitionModule.start({ lang: language, interimResults: true, continuous: false });
    } catch {
      setListening(false);
      setMessage('يتطلب التعرف الصوتي بناءً تطويرياً للتطبيق، ولا يعمل في Expo Go.');
    }
  };

  if (!enabled || !mp('voice_assistant_use')) return null;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="المساعد الصوتي"
        onPress={() => void start()}
        testID="mobile-voice-assistant-button"
        style={{
          position: 'absolute',
          right: 18,
          bottom: 88,
          width: 54,
          height: 54,
          borderRadius: 27,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: c.primary,
          elevation: 6,
          zIndex: 20,
        }}
      >
        <Feather name="mic" size={22} color={c.primaryForeground ?? '#fff'} />
      </Pressable>
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.45)' }}>
          <View style={{ backgroundColor: c.card, borderRadius: c.radius, padding: 20, gap: 14 }}>
            <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: c.foreground, fontSize: 18, fontFamily: 'Inter_600SemiBold' }}>المساعد الصوتي</Text>
              <Pressable onPress={() => { speechRef.current?.ExpoSpeechRecognitionModule.stop(); setOpen(false); }} accessibilityLabel="إغلاق">
                <Feather name="x" size={22} color={c.foreground} />
              </Pressable>
            </View>
            <Text style={{ minHeight: 42, color: c.mutedForeground, textAlign: 'right' }}>
              {working ? 'جارٍ تحليل الأمر…' : listening ? 'أستمع إليك الآن…' : transcript || 'اضغط على الميكروفون وقل أمراً.'}
            </Text>
            {!!message && <Text style={{ color: c.primary, textAlign: 'right' }}>{message}</Text>}
            <Pressable
              onPress={() => listening ? speechRef.current?.ExpoSpeechRecognitionModule.stop() : void start()}
              accessibilityRole="button"
              accessibilityLabel={listening ? 'إيقاف الاستماع' : 'بدء الاستماع'}
              style={{ alignSelf: 'center', width: 56, height: 56, borderRadius: 28, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' }}
            >
              <Feather name={listening ? 'square' : 'mic'} size={22} color={c.primaryForeground ?? '#fff'} />
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}
