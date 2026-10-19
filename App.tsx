import {useEffect, useRef, useState} from 'react';
import {
  Alert,
  Animated,
  Image,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {MathJaxRenderer, MathRenderer, type MathJaxRendererRef} from 'react-native-latex-text';

import { QrScanner } from './src/components/QrScanner';
import { WorkspaceShell } from './src/components/WorkspaceShell';
import { useThemedStyles } from './src/components/theme';
import {
  ensureAvatarResource,
  isAvatarCacheValid,
  removeAvatarCache,
} from './src/services/avatarResourceCache';
import {cacheRemoteHttpsResource} from './src/services/remoteImageCache';
import {
  parsePairingPayload,
  PairedDesktop,
  PairingPayload,
} from './src/domain/pairing';
import type {WorkspaceBootstrap} from './src/remote/api';
import { useDesktops } from './src/hooks/useDesktops';

function App() {
  const {
    desktops,
    pair,
    rename,
    updateProfile,
    remove,
    request,
    requestTracked,
    subscribeEvents,
  } = useDesktops();
  const [activeDesktopId, setActiveDesktopId] = useState('');
  const [showHome, setShowHome] = useState(true);
  const styles = useThemedStyles(baseStyles);
  const [showScanner, setShowScanner] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [rawPayload, setRawPayload] = useState('');
  const [candidate, setCandidate] = useState<PairingPayload | null>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [isPairing, setIsPairing] = useState(false);
  const [renamingDesktop, setRenamingDesktop] = useState<PairedDesktop | null>(null);
  const [nextDesktopName, setNextDesktopName] = useState('');
  const mathJaxRef = useRef<MathJaxRendererRef>(null);
  MathRenderer.Init(mathJaxRef);

  useEffect(() => {
    let cancelled = false;
    for (const desktop of desktops) {
      if (desktop.status !== '在线') continue;
      request<WorkspaceBootstrap>(desktop.id, 'workspace.bootstrap.get')
        .then(async bootstrap => {
          if (cancelled) return;
          const currentCache = desktop.avatarCache;
          let avatarCache = currentCache;
          if (bootstrap.profile.avatar) {
            try {
              avatarCache = await ensureAvatarResource({
                desktopId: desktop.id,
                resource: bootstrap.profile.avatar,
                request,
                previous: currentCache,
                displayName: bootstrap.profile.displayName,
              });
            } catch {
              // The home card stays usable when an individual avatar is unavailable.
              avatarCache = undefined;
            }
          } else if (/^https:\/\//i.test(bootstrap.profile.avatarUrl || '')) {
            try {
              avatarCache = await cacheRemoteHttpsResource({
                url: bootstrap.profile.avatarUrl,
                namespace: 'avatar',
                maxBytes: 512 * 1024,
              });
            } catch {
              avatarCache = currentCache;
            }
          } else if (currentCache) {
            await removeAvatarCache(currentCache);
            avatarCache = undefined;
          }
          const profileChanged = bootstrap.profile.displayName !== desktop.profileName;
          const avatarChanged =
            avatarCache?.version !== currentCache?.version ||
            avatarCache?.uri !== currentCache?.uri;
          if (!cancelled && (profileChanged || avatarChanged)) {
            await updateProfile(desktop.id, {
              profileName: bootstrap.profile.displayName,
              avatarCache,
            });
          }
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [desktops, request, updateProfile]);


  const normalizedCode = pairingCode.replace(/\D/g, '').slice(0, 6);
  const canPair =
    candidate !== null && normalizedCode.length === 6 && !isPairing;

  const presentCandidate = (payload: PairingPayload) => {
    setCandidate(payload);
    setPairingCode('');
    setShowScanner(false);
    setShowPaste(false);
  };

  const parseRaw = () => {
    try {
      presentCandidate(parsePairingPayload(rawPayload));
    } catch (error) {
      Alert.alert(
        '无法解析二维码内容',
        error instanceof Error ? error.message : '请检查二维码内容。',
      );
    }
  };

  const confirmPair = async () => {
    if (!candidate || normalizedCode.length !== 6) return;
    setIsPairing(true);
    try {
      await pair(candidate, normalizedCode);
      setCandidate(null);
      setRawPayload('');
      setPairingCode('');
      Alert.alert('连接成功', '正在连接你的Anywhere。');
    } catch (error) {
      Alert.alert(
        '配对失败',
        error instanceof Error
          ? error.message
          : '请确认验证码后重试。',
      );
    } finally {
      setIsPairing(false);
    }
  };

  const removeDesktop = (desktop: PairedDesktop) => {
    Alert.alert(
      '移除此桌面？',
      `将断开“${desktop.name}”并移除本机保存的连接信息。桌面端的设备记录仍可由桌面用户撤销。`, 
      [
        { text: '取消', style: 'cancel' },
        {
          text: '移除',
          style: 'default',
          onPress: () =>
            remove(desktop).catch(error =>
              Alert.alert('移除失败', String(error)),
            ),
        },
      ],
    );
  };

  const activeDesktop = desktops.find(item => item.id === activeDesktopId);
  const retainedWorkspace = activeDesktop ? (
    <View
      key={activeDesktop.id}
      style={showHome ? styles.hidden : styles.workspace}
    >
      <WorkspaceShell
        desktop={activeDesktop}
        request={request}
        requestTracked={requestTracked}
        subscribeEvents={subscribeEvents}
        updateProfile={updateProfile}
        visible={!showHome}
        onHome={() => setShowHome(true)}
      />
    </View>
  ) : null;
  if (activeDesktop && !showHome) {
    return <SafeAreaProvider><MathJaxRenderer ref={mathJaxRef} maxCacheSize={120} />{retainedWorkspace}</SafeAreaProvider>;
  }

  return (
    <SafeAreaProvider>
      <MathJaxRenderer ref={mathJaxRef} maxCacheSize={120} />
      {retainedWorkspace}
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="dark-content" />
        <ScrollView contentContainerStyle={styles.page}>
          <Text style={styles.brand}>你的Anywhere空间</Text>
          <Text style={styles.subtitle}>连接你的Anywhere，随时随地使用Agent</Text>

          <View style={styles.actions}>
            <Pressable
              style={styles.primaryButton}
              onPress={() => setShowScanner(true)}
            >
              <Text style={styles.primaryText}>＋ 扫描桌面二维码</Text>
            </Pressable>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => setShowPaste(true)}
            >
              <Text style={styles.secondaryText}>粘贴二维码内容</Text>
            </Pressable>
          </View>

          <Text style={styles.sectionTitle}>我的桌面</Text>
          {desktops.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                尚未配对桌面。请先在 Desktop 明确开启
                Remote，再扫描两分钟内有效的二维码。
              </Text>
            </View>
          ) : (
            desktops.map(desktop => {
              const canEnter = desktop.status === '在线';
              const avatarUri = isAvatarCacheValid(desktop.avatarCache)
                ? desktop.avatarCache?.uri
                : '';
              const avatarLabel = desktop.profileName || desktop.name || 'A';
              return (
                <View style={styles.desktopCard} key={desktop.id}>
                  <DesktopAvatar uri={avatarUri} label={avatarLabel} />
                  <View style={styles.desktopCardMiddle}>
                    <View style={styles.desktopNameLine}>
                      <Text numberOfLines={1} style={styles.desktopName}>{desktop.name}</Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`修改 ${desktop.name} 的连接名称`}
                        style={styles.renameButton}
                        onPress={() => {
                          setRenamingDesktop(desktop);
                          setNextDesktopName(desktop.name);
                        }}
                      >
                        <Text style={styles.renameText}>编辑</Text>
                      </Pressable>
                    </View>
                    <View style={styles.desktopMetaLine}>
                      <Text style={styles.desktopStatus}>{desktop.status}</Text>
                      <Pressable onPress={() => removeDesktop(desktop)}>
                        <Text style={styles.removeText}>移除</Text>
                      </Pressable>
                    </View>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{disabled: !canEnter}}
                    disabled={!canEnter}
                    style={[styles.enterDesktopButton, canEnter ? styles.enterOnline : styles.enterOffline]}
                    onPress={() => {
                      setActiveDesktopId(desktop.id);
                      setShowHome(false);
                    }}
                  >
                    <Text style={[styles.enterDesktopText, !canEnter && styles.enterOfflineText]}>
                      进入桌面
                    </Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </ScrollView>

        <Modal
          visible={renamingDesktop !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setRenamingDesktop(null)}
        >
          <KeyboardSheet>
            <Text style={styles.modalTitle}>连接名称</Text>
            <Text style={styles.confirmText}>此名称仅保存在本机，用于区分已配对的桌面。</Text>
            <TextInput
              value={nextDesktopName}
              onChangeText={setNextDesktopName}
              maxLength={80}
              autoFocus
              style={styles.input}
              placeholder="例如：书房 Desktop"
              placeholderTextColor="#8290a7"
            />
            <Pressable
              style={[styles.primaryButton, !nextDesktopName.trim() && styles.disabled]}
              disabled={!nextDesktopName.trim()}
              onPress={() => {
                const desktop = renamingDesktop;
                if (!desktop) return;
                rename(desktop.id, nextDesktopName)
                  .then(() => {
                    setRenamingDesktop(null);
                    setNextDesktopName('');
                  })
                  .catch(error => Alert.alert('无法修改名称', String(error)));
              }}
            >
              <Text style={styles.primaryText}>保存</Text>
            </Pressable>
            <Pressable style={styles.secondaryButton} onPress={() => setRenamingDesktop(null)}>
              <Text style={styles.secondaryText}>取消</Text>
            </Pressable>
          </KeyboardSheet>
        </Modal>


        <Modal
          visible={showScanner}
          animationType="slide"
          onRequestClose={() => setShowScanner(false)}
        >
          <QrScanner
            onScanned={value => {
              setRawPayload(value);
              try {
                presentCandidate(parsePairingPayload(value));
              } catch (error) {
                setShowScanner(false);
                Alert.alert(
                  '二维码无法使用',
                  error instanceof Error ? error.message : '请重新生成二维码。',
                );
              }
            }}
            onCancel={() => setShowScanner(false)}
          />
        </Modal>

        <Modal
          visible={showPaste}
          animationType="slide"
          transparent
          onRequestClose={() => setShowPaste(false)}
        >
          <KeyboardSheet>
            <Text style={styles.modalTitle}>粘贴二维码内容</Text>
            <TextInput
              value={rawPayload}
              onChangeText={setRawPayload}
              multiline
              style={[styles.input, styles.multiline]}
              placeholder="Desktop 二维码中的 JSON"
              placeholderTextColor="#8290a7"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable style={styles.primaryButton} onPress={parseRaw}>
              <Text style={styles.primaryText}>验证并继续</Text>
            </Pressable>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => setShowPaste(false)}
            >
              <Text style={styles.secondaryText}>取消</Text>
            </Pressable>
          </KeyboardSheet>
        </Modal>

        <PairingConfirmation
          candidate={candidate}
          pairingCode={normalizedCode}
          isPairing={isPairing}
          canPair={canPair}
          onCodeChange={setPairingCode}
          onConfirm={confirmPair}
          onCancel={() => setCandidate(null)}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function KeyboardSheet({children}: {children: React.ReactNode}) {
  const styles = useThemedStyles(baseStyles);
  const keyboardOffset = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      event => {
        const height = Math.max(0, event.endCoordinates?.height || 0);
        Animated.timing(keyboardOffset, {
          toValue: -height,
          duration: Platform.OS === 'ios' ? event.duration || 220 : 180,
          useNativeDriver: true,
        }).start();
      },
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      event => {
        Animated.timing(keyboardOffset, {
          toValue: 0,
          duration: Platform.OS === 'ios' ? event?.duration || 180 : 160,
          useNativeDriver: true,
        }).start();
      },
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, [keyboardOffset]);
  return (
    <View style={styles.modalBackdrop}>
      <Animated.View style={[styles.modalSheet, {transform: [{translateY: keyboardOffset}]}]}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.keyboardSheetContent}>
          {children}
        </ScrollView>
      </Animated.View>
    </View>
  );
}


function DesktopAvatar({uri, label}: {uri?: string; label: string}) {
  const styles = useThemedStyles(baseStyles);
  const [failed, setFailed] = useState(false);
  const initial = label.trim().slice(0, 1).toUpperCase() || 'A';
  if (!uri || failed) {
    return (
      <View style={styles.desktopAvatarFallback}>
        <Text style={styles.desktopAvatarText}>{initial}</Text>
      </View>
    );
  }
  return (
    <Image
      source={{uri}}
      style={styles.desktopAvatar}
      onError={() => setFailed(true)}
    />
  );
}


function PairingConfirmation({
  candidate,
  pairingCode,
  isPairing,
  canPair,
  onCodeChange,
  onConfirm,
  onCancel,
}: {
  candidate: PairingPayload | null;
  pairingCode: string;
  isPairing: boolean;
  canPair: boolean;
  onCodeChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const styles = useThemedStyles(baseStyles);
  return (
    <Modal
      visible={candidate !== null}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={[styles.modalBackdrop, styles.confirmBackdrop]}>
        <View style={styles.confirmSheet}>
          <Text style={styles.modalTitle}>连接验证</Text>
          <Text style={styles.confirmText}>
            输入远程桌面上显示的六位验证码以确认连接。
          </Text>
          <Text numberOfLines={2} style={styles.deviceName}>
            {candidate?.desktopName || '远程桌面'}
          </Text>
          <Text style={styles.confirmLabel}>六位验证码</Text>
          <TextInput
            value={pairingCode}
            onChangeText={onCodeChange}
            keyboardType={Platform.OS === 'ios' ? 'number-pad' : 'numeric'}
            maxLength={6}
            style={[styles.input, styles.codeInput]}
            placeholder="000000"
            placeholderTextColor="#8290a7"
          />
          <Pressable
            style={[styles.primaryButton, !canPair && styles.disabled]}
            disabled={!canPair}
            onPress={onConfirm}
          >
            <Text style={styles.primaryText}>{isPairing ? '正在连接…' : '确认连接'}</Text>
          </Pressable>
          <Pressable
            style={styles.secondaryButton}
            disabled={isPairing}
            onPress={onCancel}
          >
            <Text style={styles.secondaryText}>取消</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
const baseStyles = StyleSheet.create({
  hidden: { display: 'none' },
  workspace: { flex: 1 },
  safe: { flex: 1, backgroundColor: '#FAF8F3' },
  page: { padding: 22, paddingBottom: 48 },
  brand: {
    color: '#292724',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -1,
  },
  subtitle: { color: '#79746C', fontSize: 16, marginTop: 5 },
  actions: { gap: 10, marginTop: 28 },
  primaryButton: {
    backgroundColor: '#C96849',
    minHeight: 50,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 14,
    marginTop: 10,
  },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  secondaryButton: {
    backgroundColor: '#F2F0E9',
    minHeight: 46,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 14,
    marginTop: 10,
  },
  secondaryText: { color: '#504B43', fontWeight: '700' },
  sectionTitle: {
    color: '#292724',
    fontSize: 21,
    fontWeight: '800',
    marginTop: 32,
    marginBottom: 12,
  },
  empty: { padding: 20, backgroundColor: '#F2F0E9', borderRadius: 20 },
  emptyText: { color: '#79746C', lineHeight: 21 },
  desktopCard: {
    minHeight: 104,
    flexDirection: 'row',
    alignItems: 'stretch',
    overflow: 'hidden',
    borderRadius: 22,
    marginBottom: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E7E1D8',
  },
  desktopAvatar: {width: 64, height: 64, borderRadius: 32, margin: 16},
  desktopAvatarFallback: {
    width: 64,
    height: 64,
    margin: 16,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F9E5DB',
  },
  desktopAvatarText: {color: '#C96849', fontSize: 27, fontWeight: '800'},
  desktopCardMiddle: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    paddingVertical: 16,
    paddingRight: 10,
    gap: 8,
  },
  desktopNameLine: {flexDirection: 'row', alignItems: 'center', gap: 5},
  desktopName: {flex: 1, color: '#292724', fontWeight: '800', fontSize: 16},
  renameButton: {paddingVertical: 3, paddingHorizontal: 4},
  renameText: {color: '#79746C', fontSize: 12, fontWeight: '700'},
  desktopMetaLine: {flexDirection: 'row', alignItems: 'center', gap: 12},
  desktopStatus: {color: '#79746C', fontSize: 13},
  detail: {color: '#79746C', fontSize: 11},
  removeText: {color: '#79746C', fontSize: 12, fontWeight: '700'},
  enterDesktopButton: {
    width: 106,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: '#E7E1D8',
    paddingHorizontal: 8,
  },
  enterOnline: {backgroundColor: '#478561'},
  enterOffline: {backgroundColor: '#F2F0E9'},
  enterDesktopText: {color: '#FFFFFF', fontSize: 15, fontWeight: '800'},
  enterOfflineText: {color: '#9A958D'},
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(39,36,31,0.34)',
  },
  modalSheet: {
    backgroundColor: '#FAF8F3',
    padding: 20,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  confirmBackdrop: { justifyContent: 'center', alignItems: 'center', padding: 20 },

  confirmSheet: {
    backgroundColor: '#FAF8F3',
    margin: 16,
    borderRadius: 20,
    padding: 20,
  },
  modalTitle: {
    color: '#292724',
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 12,
  },
  input: {
    color: '#292724',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E7E1D8',
    borderRadius: 14,
    paddingHorizontal: 12,
    minHeight: 46,
  },
  multiline: { minHeight: 110, textAlignVertical: 'top', paddingTop: 12 },
  codeInput: { fontSize: 24, letterSpacing: 8, textAlign: 'center' },
  disabled: { opacity: 0.5 },
  keyboardSheetScroll: {flex: 1},
  keyboardSheetContent: {flexGrow: 1, justifyContent: 'flex-end'},
  deviceName: {
    color: '#292724',
    fontSize: 20,
    fontWeight: '800',
    marginTop: 16,
    marginBottom: 6,
  },

  confirmText: { color: '#504B43', lineHeight: 21 },
  confirmLabel: { color: '#79746C', fontWeight: '800', marginTop: 17 },
  confirmValue: { color: '#292724', marginTop: 5, lineHeight: 20 },
  row: { gap: 8 },
  choice: {
    borderWidth: 1,
    borderColor: '#E7E1D8',
    borderRadius: 12,
    padding: 10,
    marginTop: 7,
    backgroundColor: '#FFFFFF',
  },
  choiceActive: { borderColor: '#C96849', backgroundColor: '#F9E5DB' },
  choiceText: { color: '#504B43' },
});

export default App;
