import {ActivityIndicator} from './ThemedNative';

import {useThemedStyles} from './theme';
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Camera,
  useCameraDevice,

  useCameraFormat,
  useCameraPermission,
} from 'react-native-vision-camera';

export function PhotoCapture({
  onCaptured,
  onCancel,
}: {
  onCaptured: (path: string) => void;
  onCancel: () => void;
}) {
  const themed = useThemedStyles(styles);
  const camera = useRef<Camera>(null);
  const device = useCameraDevice('back', {physicalDevices: ['wide-angle-camera']});
  const format = useCameraFormat(device, [{photoResolution: 'max'}, {videoResolution: {width: 1920, height: 1080}}]);
  const { hasPermission, requestPermission } = useCameraPermission();
  const [busy, setBusy] = useState(false);

  const [ready, setReady] = useState(false);
  const capturing = useRef(false);
  const focusTask = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const tap = useRef<{x: number; y: number; at: number} | null>(null);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  useEffect(() => {
    if (!hasPermission) requestPermission().catch(() => undefined);
  }, [hasPermission, requestPermission]);
  const capture = async () => {
    if (!camera.current || !ready || capturing.current) return;
    capturing.current = true;
    setBusy(true);
    try {
      await focusTask.current;
      if (!mounted.current) return;
      const photo = await camera.current.takePhoto({flash: device?.hasFlash ? 'auto' : 'off'});
      if (mounted.current) onCaptured(photo.path);
    } catch {
      if (mounted.current) Alert.alert('拍照失败', '请检查相机权限并重试。');
    } finally {
      capturing.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const focusAt = (x: number, y: number) => {
    if (!ready || !device?.supportsFocus || !camera.current || capturing.current) return;
    focusTask.current = camera.current.focus({x, y}).catch(() => undefined);
  };
  if (!hasPermission || !device)
    return (
      <View style={themed.center}>
        <Text style={themed.text}>
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
        format={format}
        isActive
        photo
        photoQualityBalance="quality"
        enableZoomGesture
        accessibilityLabel="相机取景区域，轻点对焦"
        onTouchStart={event => {const {touches, locationX: x, locationY: y} = event.nativeEvent; tap.current = touches.length === 1 ? {x, y, at: Date.now()} : null;}}
        onTouchMove={event => {const start = tap.current; if (start && (event.nativeEvent.touches.length !== 1 || Math.hypot(event.nativeEvent.locationX - start.x, event.nativeEvent.locationY - start.y) > 12)) tap.current = null;}}
        onTouchEnd={() => {const start = tap.current; tap.current = null; if (start && Date.now() - start.at < 350) focusAt(start.x, start.y);}}
        onTouchCancel={() => {tap.current = null;}}
        onInitialized={() => setReady(true)}
        onError={() => {setReady(false); Alert.alert('相机不可用', '请重新打开相机后重试。');}}
      />
      <View pointerEvents="box-none" style={styles.overlay}>
        <Pressable style={styles.button} onPress={onCancel}>
          <Text style={styles.buttonText}>取消</Text>
        </Pressable>
        <Pressable accessibilityLabel="拍照" style={styles.shutter} onPress={capture} disabled={busy || !ready}>
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <View style={styles.shutterInner} />
          )}
        </Pressable>
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
