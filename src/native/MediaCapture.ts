import {NativeModules, Platform} from 'react-native';
import {toByteArray} from 'base64-js';

export type AudioCapture = {captureId: string; name: string; type: string; size: number; durationMs: number};

type MediaCaptureModule = {
  startAudio(): Promise<void>;
  stopAudio(): Promise<AudioCapture>;
  cancelAudio(): Promise<void>;
  readCaptureChunk(captureId: string, offset: number, length: number): Promise<string>;
  deleteCapture(captureId: string): Promise<void>;
};

const module = NativeModules.MediaCapture as MediaCaptureModule | undefined;

function native(): MediaCaptureModule {
  if (!module) throw new Error(`录音功能在 ${Platform.OS} 当前构建中不可用。请重新编译 Android 应用。`);
  return module;
}

export const MediaCapture = {
  startAudio: () => native().startAudio(),
  stopAudio: () => native().stopAudio(),
  cancelAudio: () => native().cancelAudio(),
  deleteCapture: (captureId: string) => native().deleteCapture(captureId),
  async readChunk(captureId: string, offset: number, length: number): Promise<Uint8Array> {
    return toByteArray(await native().readCaptureChunk(captureId, offset, length));
  },
};
