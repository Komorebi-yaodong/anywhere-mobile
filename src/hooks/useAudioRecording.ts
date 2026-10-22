import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';
import { MediaCapture, type AudioCapture } from '../native/MediaCapture';

/** Owns press/permission/start races; never leaves a microphone active after release. */
export function useAudioRecording(
  onCapture: (capture: AudioCapture) => Promise<unknown>,
  onError: (message: string) => void,
) {
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const processingRef = useRef(false);
  const active = useRef(false);
  const held = useRef(false);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  const operation = useRef<Promise<void> | null>(null);
  const callbacks = useRef({ onCapture, onError });
  callbacks.current = { onCapture, onError };

  const cancel = useCallback(async () => {
    held.current = false;
    cancelled.current = true;
    await operation.current?.catch(() => undefined);
    if (active.current) {
      active.current = false;
      await MediaCapture.cancelAudio().catch(() => undefined);
    }
    if (mounted.current) setRecording(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') cancel().catch(() => undefined);
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      cancel().catch(() => undefined);
    };
  }, [cancel]);

  const start = useCallback(() => {
    if (held.current || operation.current || active.current || processingRef.current) return;
    held.current = true;
    cancelled.current = false;
    const pending = (async () => {
      const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
      const allowed =
        Platform.OS === 'ios' ||
        (await PermissionsAndroid.check(permission)) ||
        (await PermissionsAndroid.request(permission, {
          title: '允许录音',
          message: '用于录制语音消息。',
          buttonPositive: '允许',
          buttonNegative: '取消',
        })) === PermissionsAndroid.RESULTS.GRANTED;
      if (!allowed || !held.current || cancelled.current || !mounted.current)
        return;
      await MediaCapture.startAudio();
      active.current = true;
      if (!held.current || cancelled.current || !mounted.current) {
        active.current = false;
        await MediaCapture.cancelAudio();
        return;
      }
      setRecording(true);
    })()
      .catch(() => {
        if (mounted.current)
          callbacks.current.onError('无法开始录音，请检查麦克风权限。');
      })
      .finally(() => {
        if (operation.current === pending) operation.current = null;
      });
    operation.current = pending;
  }, []);

  const finish = useCallback(async () => {
    held.current = false;
    await operation.current?.catch(() => undefined);
    if (!active.current || processingRef.current) return;
    active.current = false;
    processingRef.current = true;
    if (mounted.current) {setRecording(false); setProcessing(true);}
    let capture: AudioCapture | null = null;
    try {
      if (cancelled.current || !mounted.current) {
        await MediaCapture.cancelAudio();
        return;
      }
      capture = await MediaCapture.stopAudio();
      if (cancelled.current || !mounted.current || capture.durationMs < 350) {
        await MediaCapture.deleteCapture(capture.captureId);
        return;
      }
      await callbacks.current.onCapture(capture);
    } catch {
      if (capture)
        await MediaCapture.deleteCapture(capture.captureId).catch(
          () => undefined,
        );
      if (mounted.current) callbacks.current.onError('录音处理失败，请重试。');
    } finally {
      processingRef.current = false;
      if (mounted.current) setProcessing(false);
    }
  }, []);

  return { recording, processing, start, finish, cancel };
}
