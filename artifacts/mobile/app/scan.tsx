import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { emitScan } from '@/lib/scanBus';
import { useColors } from '@/hooks/useColors';
import { Btn } from '@/components/ui';

export default function Scan() {
  const router = useRouter();
  const c = useColors();
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  const onBarcode = ({ data }: { data: string }) => {
    if (scannedRef.current || !data) return;
    scannedRef.current = true;
    emitScan(data);
    router.back();
  };

  if (Platform.OS === 'web' || manual || (permission && !permission.granted && !permission.canAskAgain)) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 }}>
        <Feather name="camera-off" size={36} color={c.mutedForeground} />
        <Text style={{ color: c.foreground, fontSize: 15, textAlign: 'center' }}>
          {Platform.OS === 'web'
            ? 'مسح الباركود متاح على الجوال عبر تطبيق Expo Go'
            : 'لم يتم منح إذن الكاميرا — فعّله من إعدادات الجهاز'}
        </Text>
        <Btn title="رجوع" onPress={() => router.back()} kind="outline" />
      </View>
    );
  }

  if (!permission?.granted) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 }}>
        <Text style={{ color: '#fff', fontSize: 15, textAlign: 'center' }}>نحتاج إذن الكاميرا لمسح الباركود</Text>
        <Btn title="منح الإذن" onPress={() => requestPermission()} />
        <Btn title="رجوع" onPress={() => router.back()} kind="ghost" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ['ean13', 'ean8', 'code128', 'code39', 'upc_a', 'upc_e', 'qr'],
        }}
        onBarcodeScanned={onBarcode}
      />
      <View style={{ position: 'absolute', top: 60, left: 0, right: 0, alignItems: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 15, backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999 }}>
          وجّه الكاميرا نحو الباركود
        </Text>
      </View>
      <Pressable
        onPress={() => router.back()}
        style={{ position: 'absolute', bottom: 50, alignSelf: 'center', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 999, padding: 16 }}
      >
        <Feather name="x" size={24} color="#fff" />
      </Pressable>
    </View>
  );
}
