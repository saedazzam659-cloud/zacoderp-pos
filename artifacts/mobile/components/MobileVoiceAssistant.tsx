import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, PanResponder, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '@/lib/api';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { emitVoiceDocumentFill } from '@/lib/voiceDocumentFillBus';

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

function learnAfterSuccess(transcript: string, parsed: ParsedCommand, contextRoute: string): void {
  if (parsed.kind !== 'navigate' && parsed.kind !== 'verb') return;
  void api('/api/voice-assistant/learn', {
    method: 'POST',
    body: {
      transcript: transcript.trim(),
      parsed: { kind: parsed.kind, route: parsed.route, verb: parsed.verb },
      contextRoute,
    },
  }).catch(() => {});
}

export function MobileVoiceAssistant() {
  const c = useColors();
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const { mp } = useMobilePerms();
  const { width, height } = useWindowDimensions();
  const [enabled, setEnabled] = useState(false);
  const [language, setLanguage] = useState('ar-SA');
  const [open, setOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [working, setWorking] = useState(false);
  const [, setTranscript] = useState('');
  const [, setMessage] = useState('');
  const handledRef = useRef(false);
  const speechRef = useRef<typeof import('expo-speech-recognition') | null>(null);
  const listenersRef = useRef<Array<{ remove: () => void }>>([]);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragOffsetRef = useRef(dragOffset);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const positionKey = `zacode.voiceAssistantPosition.v1:${user?.id ?? 'guest'}`;

  useEffect(() => { dragOffsetRef.current = dragOffset; }, [dragOffset]);

  useEffect(() => {
    let active = true;
    dragOffsetRef.current = { x: 0, y: 0 };
    setDragOffset({ x: 0, y: 0 });
    AsyncStorage.getItem(positionKey).then((raw) => {
      if (!active || !raw) return;
      const saved = JSON.parse(raw);
      if (!Number.isFinite(saved?.x) || !Number.isFinite(saved?.y)) return;
      const next = {
        x: Math.max(90 - width, Math.min(18, saved.x)),
        y: Math.max(142 - height, Math.min(88, saved.y)),
      };
      dragOffsetRef.current = next;
      setDragOffset(next);
    }).catch(() => {});
    return () => { active = false; };
  }, [positionKey, width, height]);

  const panResponder = React.useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_event, gesture) =>
      Math.abs(gesture.dx) > 5 || Math.abs(gesture.dy) > 5,
    onPanResponderGrant: () => {
      dragStartRef.current = dragOffsetRef.current;
    },
    onPanResponderMove: (_event, gesture) => {
      const next = {
        x: Math.max(90 - width, Math.min(18, dragStartRef.current.x + gesture.dx)),
        y: Math.max(142 - height, Math.min(88, dragStartRef.current.y + gesture.dy)),
      };
      dragOffsetRef.current = next;
      setDragOffset(next);
    },
    onPanResponderRelease: () => {
      AsyncStorage.setItem(positionKey, JSON.stringify(dragOffsetRef.current)).catch(() => {});
    },
    onPanResponderTerminate: () => {
      AsyncStorage.setItem(positionKey, JSON.stringify(dragOffsetRef.current)).catch(() => {});
    },
  }), [height, positionKey, width]);

  useEffect(() => {
    if (!user?.id) {
      setEnabled(false);
      return;
    }
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
  }, [user?.id]);

  const executeTranscript = useCallback(async (text: string) => {
    const command = text.trim();
    if (!command || handledRef.current) return;
    handledRef.current = true;
    setTranscript(command);
    setWorking(true);
    setMessage('');
    if (emitVoiceDocumentFill(command)) {
      setWorking(false);
      return;
    }
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
          learnAfterSuccess(command, parsed, pathname);
        } else {
          setMessage('تم فهم الأمر، لكن هذه الشاشة غير متاحة في تطبيق الموبايل حالياً.');
        }
      } else if (parsed.kind === 'verb' && parsed.verb === 'back') {
        setMessage('رجوع');
        router.back();
        learnAfterSuccess(command, parsed, pathname);
      } else if (parsed.kind === 'verb' && parsed.verb === 'home') {
        setMessage('الانتقال إلى الرئيسية');
        router.replace('/(tabs)' as never);
        learnAfterSuccess(command, parsed, pathname);
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
      <View
        {...panResponder.panHandlers}
        style={{
          position: 'absolute',
          right: 18,
          bottom: 88,
          transform: [{ translateX: dragOffset.x }, { translateY: dragOffset.y }],
          zIndex: 20,
        }}
      >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="المساعد الصوتي"
        onPress={() => void start()}
        testID="mobile-voice-assistant-button"
        style={{
          width: 54,
          height: 54,
          borderRadius: 27,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: c.primary,
          elevation: 6,
        }}
      >
        <Feather name="mic" size={22} color={c.primaryForeground ?? '#fff'} />
      </Pressable>
      </View>
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.45)' }}>
          <View style={{ backgroundColor: c.card, borderRadius: c.radius, padding: 20, gap: 14 }}>
            <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: c.foreground, fontSize: 18, fontFamily: 'Inter_600SemiBold' }}>المساعد الصوتي</Text>
              <Pressable onPress={() => { speechRef.current?.ExpoSpeechRecognitionModule.stop(); setOpen(false); }} accessibilityLabel="إغلاق">
                <Feather name="x" size={22} color={c.foreground} />
              </Pressable>
            </View>
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
