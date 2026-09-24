import React, { useEffect, useState } from 'react';
import { Modal, Text, View } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';
import { defaultDomain, getDomain } from '@/lib/api';
import { useColors } from '@/hooks/useColors';
import { Btn, Card, Field } from '@/components/ui';

export function ServerSettings({ visible, onClose, onChanged }: {
  visible: boolean;
  onClose: () => void;
  onChanged?: (domain: string) => void;
}) {
  const c = useColors();
  const { switchServer } = useAuth();
  const [domain, setDomain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (visible) {
      setError('');
      getDomain().then(setDomain).catch((e) => setError(e.message));
    }
  }, [visible]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const saved = await switchServer(domain);
      onClose();
      onChanged?.(saved);
    } catch (e: any) {
      setError(e?.message ?? 'تعذّر حفظ الخادم');
    } finally { setBusy(false); }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => { if (!busy) onClose(); }}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
        <Card style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0, gap: 14, paddingBottom: 34 }}>
          <Text style={{ fontSize: 17, fontFamily: 'Inter_600SemiBold', textAlign: 'right', color: c.foreground }}>إعدادات الخادم</Text>
          <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: 'right' }}>
            الخادم الافتراضي لهذه النسخة: {defaultDomain()}. لإعادة ضبطه اترك الحقل فارغاً؛ للاتصال بالسحابة المركزية أدخل zacoderp.com صراحةً. أدخل نطاق وكيلك (مثل alkamilerp.com). يُزال مسار الرابط الملصق؛ يلزم HTTPS وسيُطلب تسجيل الدخول مجدداً عند التغيير.
          </Text>
          <Field label="نطاق الخادم" value={domain} onChangeText={setDomain} placeholder={defaultDomain()} ltr testID="input-server-domain" />
          {error ? <Text style={{ color: c.destructive, textAlign: 'right', fontSize: 13 }}>{error}</Text> : null}
          <View style={{ flexDirection: 'row-reverse', gap: 10 }}>
            <View style={{ flex: 1 }}><Btn title="تحقق وحفظ" onPress={save} loading={busy} testID="button-save-domain" /></View>
            <View style={{ flex: 1 }}><Btn title="إلغاء" onPress={onClose} kind="outline" /></View>
          </View>
        </Card>
      </View>
    </Modal>
  );
}