import {ActivityIndicator} from './ThemedNative';
import {useEffect, useRef} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Camera, useCameraDevice, useCameraPermission, useCodeScanner} from 'react-native-vision-camera';

type Props = {
  onScanned: (value: string) => void;
  onCancel: () => void;
};

export function QrScanner({onScanned, onCancel}: Props) {
  const device = useCameraDevice('back');
  const {hasPermission, requestPermission} = useCameraPermission();
  const consumed = useRef(false);

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  const scanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: codes => {
      const value = codes[0]?.value;
      if (value && !consumed.current) {
        consumed.current = true;
        onScanned(value);
      }
    },
  });

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#8ab4ff" />
        <Text style={styles.text}>正在请求相机权限…</Text>
        <Pressable style={styles.secondaryButton} onPress={onCancel}><Text style={styles.buttonText}>返回</Text></Pressable>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>未检测到可用后置相机。</Text>
        <Pressable style={styles.secondaryButton} onPress={onCancel}><Text style={styles.buttonText}>返回</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Camera style={StyleSheet.absoluteFill} device={device} isActive codeScanner={scanner} />
      <View style={styles.overlay}>
        <Text style={styles.title}>扫描桌面端配对二维码</Text>
        <Text style={styles.text}>仅扫描配对信息，不访问桌面文件或会话内容。</Text>
        <View style={styles.frame} />
        <Pressable style={styles.secondaryButton} onPress={onCancel}><Text style={styles.buttonText}>取消扫描</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#07111f'},
  overlay: {flex: 1, alignItems: 'center', justifyContent: 'space-around', padding: 28, backgroundColor: 'rgba(7,17,31,0.35)'},
  frame: {width: 250, height: 250, borderWidth: 3, borderColor: '#8ab4ff', borderRadius: 18},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, backgroundColor: '#07111f', padding: 28},
  title: {color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center'},
  text: {color: '#d5e2ff', fontSize: 15, textAlign: 'center', lineHeight: 22},
  secondaryButton: {backgroundColor: '#23334d', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10},
  buttonText: {color: '#fff', fontWeight: '600'},
});
