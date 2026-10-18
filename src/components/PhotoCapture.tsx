import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';

export function PhotoCapture({
  onCaptured,
  onCancel,
}: {
  onCaptured: (path: string) => void;
  onCancel: () => void;
}) {
  const camera = useRef<Camera>(null);
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!hasPermission) requestPermission().catch(() => undefined);
  }, [hasPermission, requestPermission]);
  const capture = async () => {
    if (!camera.current || busy) return;
    setBusy(true);
    try {
      onCaptured((await camera.current.takePhoto({ flash: 'auto' })).path);
    } catch {
      Alert.alert('拍照失败', '请检查相机权限并重试。');
    } finally {
      setBusy(false);
    }
  };
  if (!hasPermission || !device)
    return (
      <View style={styles.center}>
        <Text style={styles.text}>
          {hasPermission ? '未检测到后置相机。' : '正在请求相机权限…'}
        </Text>
        <Pressable style={styles.button} onPress={onCancel}>
          <Text style={styles.buttonText}>返回</Text>
        </Pressable>
      </View>
    );
  return (
    <View style={styles.root}>
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        photo
      />
      <View style={styles.overlay}>
        <Pressable style={styles.button} onPress={onCancel}>
          <Text style={styles.buttonText}>取消</Text>
        </Pressable>
        <Pressable style={styles.shutter} onPress={capture} disabled={busy}>
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <View style={styles.shutterInner} />
          )}
        </Pressable>
        <Text style={styles.hint}>拍摄后将作为加密图片附件发送</Text>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  overlay: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 28,
    paddingTop: 58,
    backgroundColor: 'rgba(0,0,0,0.12)',
  },
  button: {
    backgroundColor: 'rgba(255,255,255,0.22)',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 99,
    alignSelf: 'flex-start',
  },
  buttonText: { color: '#fff', fontWeight: '800' },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#fff',
  },
  hint: { color: '#fff', fontWeight: '700' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    backgroundColor: '#FAF8F3',
  },
  text: { color: '#292724' },
});
