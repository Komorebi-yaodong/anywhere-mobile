import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {Dirs, FileSystem} from 'react-native-file-access';
import Video, {type VideoRef} from 'react-native-video';
import {NativeMarkdown} from './NativeMarkdown';
import {extractedFileNotice} from './conversationFileNotice';

import type {RemoteRequest} from '../remote/api';
import {getConversationMediaCache} from '../services/conversationMediaCache';
import {cacheRemoteHttpsResource} from '../services/remoteImageCache';
import {
  hasRenderableConversationContent,
  parseConversationContent,
  type ConversationMedia,
} from './conversationMediaMarkup';

export {hasRenderableConversationContent};

const C = {
  text: '#292724',
  muted: '#79746C',
  mutedSurface: '#F2F0E9',
  primary: '#C96849',
  primarySoft: '#F9E5DB',
  danger: '#B84E52',
  darkMedia: '#302B27',
};
const maxExportBytes = 25 * 1024 * 1024;

type MediaState = {uri: string; mimeType: string};

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = safe % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function extensionForImage(uri: string, mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/png') return 'png';
  const pathname = uri.split(/[?#]/, 1)[0].toLowerCase();
  const match = /\.(png|jpe?g|webp|gif|bmp|heic)$/.exec(pathname);
  return match?.[1] === 'jpeg' ? 'jpg' : match?.[1] || 'png';
}

function nativePath(uri: string): string {
  const value = uri.replace(/^file:\/\//, '');
  try { return decodeURIComponent(value); } catch { return value; }
}

async function exportImageToPictures(uri: string, mimeType: string): Promise<void> {
  const extension = extensionForImage(uri, mimeType);
  const targetName = `Anywhere-${Date.now()}.${extension}`;
  let temporary = '';
  try {
    let source = '';
    if (uri.startsWith('file://')) {
      source = nativePath(uri);
    } else if (/^https:\/\//i.test(uri)) {
      const directory = `${Dirs.CacheDir}/anywhere-image-export`;
      if (!(await FileSystem.exists(directory))) await FileSystem.mkdir(directory);
      temporary = `${directory}/${Date.now().toString(36)}.${extension}`;
      const result = await FileSystem.fetch(uri, {path: temporary});
      const stat = await FileSystem.stat(temporary).catch(() => null);
      if (!result.ok || result.status >= 400 || !stat || stat.size < 1 || stat.size > maxExportBytes) {
        throw new Error('image_export_download_failed');
      }
      source = temporary;
    } else {
      throw new Error('image_export_source_invalid');
    }
    await FileSystem.cpExternal(source, targetName, 'images');
  } finally {
    if (temporary) await FileSystem.unlink(temporary).catch(() => undefined);
  }
}

const minPreviewScale = 1;
const maxPreviewScale = 4;

type Point = {x: number; y: number};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function touchPoint(touch?: {pageX: number; pageY: number}): Point {
  return {x: Number(touch?.pageX) || 0, y: Number(touch?.pageY) || 0};
}

function touchDistance(touches: ReadonlyArray<{pageX: number; pageY: number}>): number {
  if (touches.length < 2) return 0;
  const first = touchPoint(touches[0]);
  const second = touchPoint(touches[1]);
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function ImagePreview({state, onError}: {state: MediaState; onError: () => void}) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(minPreviewScale);
  const [saving, setSaving] = useState(false);
  const [viewport, setViewport] = useState({width: 0, height: 0});
  const scale = useRef(new Animated.Value(minPreviewScale)).current;
  const pan = useRef(new Animated.ValueXY({x: 0, y: 0})).current;
  const zoomRef = useRef(minPreviewScale);
  const panRef = useRef<Point>({x: 0, y: 0});
  const lastTapAt = useRef(0);
  const gesture = useRef({
    mode: 'idle' as 'idle' | 'pan' | 'pinch',
    startScale: minPreviewScale,
    startDistance: 0,
    startPan: {x: 0, y: 0},
    startTouch: {x: 0, y: 0},
    moved: false,
  });

  const applyTransform = useCallback((nextScale: number, nextPan: Point, animated = false) => {
    const boundedScale = clamp(nextScale, minPreviewScale, maxPreviewScale);
    const maximumX = viewport.width > 0 ? Math.max(0, (viewport.width * (boundedScale - 1)) / 2) : 0;
    const maximumY = viewport.height > 0 ? Math.max(0, (viewport.height * (boundedScale - 1)) / 2) : 0;
    const boundedPan = boundedScale <= minPreviewScale
      ? {x: 0, y: 0}
      : {x: clamp(nextPan.x, -maximumX, maximumX), y: clamp(nextPan.y, -maximumY, maximumY)};
    zoomRef.current = boundedScale;
    panRef.current = boundedPan;
    setZoom(current => Math.abs(current - boundedScale) >= 0.01 ? boundedScale : current);
    const changes = [
      Animated.timing(scale, {toValue: boundedScale, duration: animated ? 160 : 0, useNativeDriver: true}),
      Animated.timing(pan, {toValue: boundedPan, duration: animated ? 160 : 0, useNativeDriver: true}),
    ];
    if (animated) Animated.parallel(changes).start();
    else {
      scale.setValue(boundedScale);
      pan.setValue(boundedPan);
    }
  }, [pan, scale, viewport.height, viewport.width]);

  const resetTransform = useCallback((animated = false) => {
    applyTransform(minPreviewScale, {x: 0, y: 0}, animated);
  }, [applyTransform]);

  const panResponder = useMemo(() => PanResponder.create({
    // Android Image can otherwise become the responder before the canvas;
    // capture both starts and moves so pinch/pan stay on this gesture surface.
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderGrant: event => {
      const touches = event.nativeEvent.touches;
      const next = gesture.current;
      next.moved = false;
      next.startPan = panRef.current;
      next.startScale = zoomRef.current;
      if (touches.length >= 2) {
        next.mode = 'pinch';
        next.startDistance = touchDistance(touches);
      } else {
        next.mode = 'pan';
        next.startTouch = touchPoint(touches[0]);
      }
    },
    onPanResponderMove: event => {
      const touches = event.nativeEvent.touches;
      const next = gesture.current;
      if (touches.length >= 2) {
        if (next.mode !== 'pinch') {
          next.mode = 'pinch';
          next.startScale = zoomRef.current;
          next.startPan = panRef.current;
          next.startDistance = touchDistance(touches);
        }
        const distance = touchDistance(touches);
        if (next.startDistance > 0 && distance > 0) {
          next.moved = true;
          applyTransform(next.startScale * (distance / next.startDistance), next.startPan);
        }
        return;
      }
      if (touches.length !== 1) return;
      const point = touchPoint(touches[0]);
      if (next.mode !== 'pan') {
        next.mode = 'pan';
        next.startTouch = point;
        next.startPan = panRef.current;
        return;
      }
      const deltaX = point.x - next.startTouch.x;
      const deltaY = point.y - next.startTouch.y;
      if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) next.moved = true;
      if (zoomRef.current > minPreviewScale) {
        applyTransform(zoomRef.current, {x: next.startPan.x + deltaX, y: next.startPan.y + deltaY});
      }
    },
    onPanResponderRelease: () => {
      const wasTap = gesture.current.mode === 'pan' && !gesture.current.moved;
      gesture.current.mode = 'idle';
      if (zoomRef.current <= minPreviewScale + 0.01) resetTransform(false);
      if (!wasTap) return;
      const now = Date.now();
      if (now - lastTapAt.current <= 280) {
        lastTapAt.current = 0;
        resetTransform(true);
      } else {
        lastTapAt.current = now;
      }
    },
    onPanResponderTerminate: () => { gesture.current.mode = 'idle'; },
  }), [applyTransform, resetTransform]);

  const close = () => { resetTransform(false); setOpen(false); };
  const save = () => {
    Alert.alert('保存图片', '将把当前图片保存到系统图片目录。', [
      {text: '取消', style: 'cancel'},
      {
        text: saving ? '正在保存…' : '保存',
        onPress: () => {
          setSaving(true);
          exportImageToPictures(state.uri, state.mimeType)
            .then(() => Alert.alert('已保存', '图片已保存到系统图片目录。'))
            .catch(() => Alert.alert('保存失败', '暂时无法保存图片，请检查网络或存储空间。'))
            .finally(() => setSaving(false));
        },
      },
    ]);
  };
  return <>
    <Pressable
      accessibilityLabel="打开图片预览"
      onPress={() => { resetTransform(false); setOpen(true); }}
      onLongPress={save}
      delayLongPress={420}
      style={styles.imagePress}
    >
      <Image accessibilityLabel="聊天图片" source={{uri: state.uri}} resizeMode="contain" style={styles.image} onError={onError} />
      <View pointerEvents="none" style={styles.imageHint}><Text style={styles.imageHintText}>点击放大 · 长按保存</Text></View>
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.imageModal}>
        <View style={styles.imageModalTop}>
          <Pressable accessibilityLabel="缩小图片" style={styles.zoomButton} onPress={() => applyTransform(zoomRef.current - 0.5, panRef.current, true)}><Text style={styles.zoomButtonText}>−</Text></Pressable>
          <Text style={styles.zoomLabel}>{Math.round(zoom * 100)}%</Text>
          <Pressable accessibilityLabel="放大图片" style={styles.zoomButton} onPress={() => applyTransform(zoomRef.current + 0.5, panRef.current, true)}><Text style={styles.zoomButtonText}>＋</Text></Pressable>
          <Pressable accessibilityLabel="保存当前图片" style={styles.saveButton} onPress={save}><Text style={styles.saveButtonText}>{saving ? '保存中' : '保存'}</Text></Pressable>
          <Pressable accessibilityLabel="关闭图片预览" style={styles.closeButton} onPress={close}><Text style={styles.closeButtonText}>关闭</Text></Pressable>
        </View>
        <Text style={styles.imageGestureHint}>按钮缩放 · 放大后拖动 · 双击复位</Text>
        <View accessibilityLabel="图片预览画布" onLayout={event => setViewport({width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height})} style={styles.imageGestureSurface} {...panResponder.panHandlers}>
          <View pointerEvents="none" style={styles.imageFullscreen}>
            <Animated.Image source={{uri: state.uri}} resizeMode="contain" style={[styles.imageFullscreen, {transform: [{translateX: pan.x}, {translateY: pan.y}, {scale}]}]} onError={onError} />
          </View>
        </View>
      </View>
    </Modal>
  </>;
}

function AudioPlayer({state, opaque, onError}: {state: MediaState; opaque: boolean; onError: () => void}) {
  const ref = useRef<VideoRef>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const toggle = () => {
    setPlaying(current => {
      if (current) ref.current?.pause();
      else ref.current?.resume();
      return !current;
    });
  };
  const seekRelative = (seconds: number) => {
    const next = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, position + seconds));
    ref.current?.seek(next);
    setPosition(next);
  };
  const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  return <View style={styles.audioCard}>
    <Video
      ref={ref}
      source={{uri: state.uri}}
      paused={!playing}
      controls={false}
      playInBackground={false}
      style={styles.audioEngine}
      onLoad={event => setDuration(event.duration || 0)}
      onProgress={event => setPosition(event.currentTime || 0)}
      onEnd={() => { setPlaying(false); setPosition(0); }}
      onError={onError}
    />
    <View style={styles.audioHeader}><View><Text style={styles.audioEyebrow}>{opaque ? '受限缓存音频' : 'HTTPS 音频'}</Text><Text style={styles.audioTitle}>音频播放</Text></View><Text style={styles.audioTime}>{formatTime(position)} / {formatTime(duration)}</Text></View>
    <View style={styles.audioProgressTrack}><View style={[styles.audioProgressFill, {width: `${progress}%`}]} /></View>
    <View style={styles.audioControls}>
      <Pressable accessibilityLabel="音频后退十秒" style={styles.skipButton} onPress={() => seekRelative(-10)}><Text style={styles.skipButtonText}>−10</Text></Pressable>
      <Pressable accessibilityLabel={playing ? '暂停音频' : '播放音频'} style={styles.playButton} onPress={toggle}><Text style={styles.playButtonText}>{playing ? 'Ⅱ' : '▶'}</Text></Pressable>
      <Pressable accessibilityLabel="音频前进十秒" style={styles.skipButton} onPress={() => seekRelative(10)}><Text style={styles.skipButtonText}>+10</Text></Pressable>
    </View>
  </View>;
}

function VideoPlayer({state, opaque, onError}: {state: MediaState; opaque: boolean; onError: () => void}) {
  const ref = useRef<VideoRef>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const toggle = () => {
    setPlaying(current => {
      if (current) ref.current?.pause();
      else ref.current?.resume();
      return !current;
    });
  };
  const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  return <View style={styles.videoCard}>
    <Video
      ref={ref}
      source={{uri: state.uri}}
      paused={!playing}
      controls={false}
      resizeMode="contain"
      style={styles.video}
      onLoad={event => setDuration(event.duration || 0)}
      onProgress={event => setPosition(event.currentTime || 0)}
      onEnd={() => { setPlaying(false); setPosition(0); }}
      onError={onError}
    />
    <Pressable accessibilityLabel={playing ? '暂停视频' : '播放视频'} style={styles.videoTapLayer} onPress={toggle}>
      {!playing ? <View style={styles.videoPlayBadge}><Text style={styles.videoPlayText}>▶</Text></View> : null}
    </Pressable>
    <View style={styles.videoFooter}>
      <View style={styles.videoFooterCopy}><Text style={styles.videoEyebrow}>{opaque ? '受限缓存视频' : 'HTTPS 视频'}</Text><View style={styles.videoProgressTrack}><View style={[styles.videoProgressFill, {width: `${progress}%`}]} /></View><Text style={styles.videoTime}>{formatTime(position)} / {formatTime(duration)}</Text></View>
      <Pressable accessibilityLabel="视频全屏播放" style={styles.fullscreenButton} onPress={() => ref.current?.presentFullscreenPlayer()}><Text style={styles.fullscreenButtonText}>全屏</Text></Pressable>
    </View>
  </View>;
}

function MediaPreview({media, desktopId, conversationId, request}: {media: ConversationMedia; desktopId: string; conversationId: string; request: RemoteRequest}) {
  const [state, setState] = useState<MediaState | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    setState(null);
    if (!media.opaque) {
      cacheRemoteHttpsResource({url: media.uri, namespace: 'media'})
        .then(value => { if (active) setState(value); })
        .catch(() => { if (active) setError('媒体暂不可用'); });
      return () => { active = false; };
    }
    getConversationMediaCache({desktopId, conversationId, mediaId: media.uri.match(/^anywhere-media:\/\/([A-Za-z0-9_-]{16,160})/)?.[1] || '', request})
      .then(value => { if (active) setState(value); })
      .catch(() => { if (active) setError('媒体暂不可用'); });
    return () => { active = false; };
  }, [conversationId, desktopId, media.opaque, media.uri, request]);
  if (error) return <View style={styles.mediaPlaceholder}><Text style={styles.mediaError}>{error}</Text></View>;
  if (!state) return <View style={styles.mediaPlaceholder}><ActivityIndicator color={C.primary} /><Text style={styles.mediaHint}>正在验证并获取加密媒体…</Text></View>;
  if (media.kind === 'image') return <ImagePreview state={state} onError={() => setError('图片加载失败')} />;
  if (media.kind === 'video') return <VideoPlayer state={state} opaque={media.opaque} onError={() => setError('视频播放失败')} />;
  return <AudioPlayer state={state} opaque={media.opaque} onError={() => setError('音频播放失败')} />;
}

/** Render constrained Markdown/HTML media. Direct media is HTTPS-only; local Desktop media must use opaque IDs. */
export function ConversationMarkdown({value, desktopId, conversationId, request, color}: {value: string; desktopId: string; conversationId: string; request: RemoteRequest; color?: string}) {
  const file = extractedFileNotice(value);
  const blocks = useMemo(() => file ? [] : parseConversationContent(value), [file, value]);
  if (file) return <View style={styles.root}><Text selectable style={{color: color || C.text}}>{file}</Text></View>;
  return <View style={styles.root}>{blocks.map(block => block.kind === 'text'
    ? <NativeMarkdown key={`text-${block.value.slice(0, 32)}-${blocks.indexOf(block)}`} value={block.value} color={color} />
    : <MediaPreview key={block.media.key} media={block.media} desktopId={desktopId} conversationId={conversationId} request={request} />,
  )}</View>;
}

const styles = StyleSheet.create({
  root: {gap: 9, minWidth: 0, maxWidth: '100%', flexShrink: 1},
  mediaPlaceholder: {minHeight: 68, alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 14, backgroundColor: C.mutedSurface},
  mediaHint: {fontSize: 12, color: C.muted},
  mediaError: {fontSize: 12, color: C.danger},
  imagePress: {position: 'relative'},
  image: {width: '100%', height: 220, borderRadius: 16, backgroundColor: C.mutedSurface},
  imageHint: {position: 'absolute', right: 9, bottom: 9, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 5, backgroundColor: 'rgba(41,39,36,0.68)'},
  imageHintText: {fontSize: 11, color: '#FFF9F2', fontWeight: '700'},
  imageModal: {flex: 1, backgroundColor: 'rgba(24,22,20,0.96)'},
  imageModalTop: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 52, paddingBottom: 14},
  zoomButton: {width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: '#3F3933'},
  zoomButtonText: {color: '#FFF9F2', fontSize: 22, fontWeight: '800'},
  zoomLabel: {minWidth: 46, textAlign: 'center', color: '#FFF9F2', fontSize: 13, fontWeight: '700'},
  saveButton: {marginLeft: 'auto', borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9, backgroundColor: C.primary},
  saveButtonText: {color: '#FFF9F2', fontSize: 12, fontWeight: '800'},
  closeButton: {borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9, backgroundColor: '#3F3933'},
  closeButtonText: {color: '#FFF9F2', fontSize: 12, fontWeight: '800'},
  imageGestureHint: {paddingHorizontal: 18, paddingBottom: 8, textAlign: 'center', color: '#CFC6BC', fontSize: 11, fontWeight: '700'},
  imageGestureSurface: {flex: 1, minHeight: 0, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', padding: 18},
  imageFullscreen: {width: '100%', height: '100%'},
  audioCard: {overflow: 'hidden', gap: 12, padding: 14, borderRadius: 18, borderWidth: 1, borderColor: '#ECDACE', backgroundColor: '#FFF8F1'},
  audioEngine: {width: 1, height: 1, opacity: 0},
  audioHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10},
  audioEyebrow: {fontSize: 11, lineHeight: 15, color: '#9A6A55', fontWeight: '700'},
  audioTitle: {marginTop: 1, fontSize: 16, color: C.text, fontWeight: '800'},
  audioTime: {paddingTop: 6, color: C.muted, fontSize: 12, fontVariant: ['tabular-nums']},
  audioProgressTrack: {height: 5, overflow: 'hidden', borderRadius: 3, backgroundColor: '#F0D8CA'},
  audioProgressFill: {height: '100%', borderRadius: 3, backgroundColor: C.primary},
  audioControls: {flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 22},
  skipButton: {minWidth: 44, paddingHorizontal: 8, paddingVertical: 10, alignItems: 'center'},
  skipButtonText: {color: '#8A5B47', fontSize: 13, fontWeight: '800'},
  playButton: {width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, backgroundColor: C.primary},
  playButtonText: {marginLeft: 2, color: '#FFF9F2', fontSize: 20, fontWeight: '900'},
  videoCard: {overflow: 'hidden', borderRadius: 18, borderWidth: 1, borderColor: '#E8DCD1', backgroundColor: C.darkMedia},
  video: {width: '100%', aspectRatio: 16 / 9, backgroundColor: '#201C19'},
  videoTapLayer: {...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center'},
  videoPlayBadge: {width: 54, height: 54, alignItems: 'center', justifyContent: 'center', borderRadius: 27, backgroundColor: 'rgba(255,249,242,0.90)'},
  videoPlayText: {marginLeft: 3, color: C.primary, fontSize: 22, fontWeight: '900'},
  videoFooter: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#403832'},
  videoFooterCopy: {flex: 1, gap: 5},
  videoEyebrow: {color: '#F3D8C7', fontSize: 11, fontWeight: '700'},
  videoProgressTrack: {height: 4, overflow: 'hidden', borderRadius: 2, backgroundColor: '#6C5C51'},
  videoProgressFill: {height: '100%', backgroundColor: '#E8906D'},
  videoTime: {color: '#E8DDD5', fontSize: 11, fontVariant: ['tabular-nums']},
  fullscreenButton: {borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: '#5A4A3F'},
  fullscreenButtonText: {color: '#FFF9F2', fontSize: 12, fontWeight: '800'},
});
