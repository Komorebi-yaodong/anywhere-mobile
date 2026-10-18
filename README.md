# Anywhere Mobile — Remote v2 原生伴侣

React Native 0.86.2 / React 19 / TypeScript。仅支持 Anywhere Desktop Remote v2，不保留 v1 Bearer token 或明文 RPC 兼容路径。

## 当前能力

- Remote 默认由 Desktop 用户主动开启；扫码/粘贴短期 QR 后单独输入六位验证码。
- P-256 ECDH + HKDF-SHA-256 + AES-256-GCM；pair-start 已加密，每次 WSS 使用临时 ECDH 与方向隔离的严格序号帧。
- LAN 固定 Desktop TLS 叶证书并验证 hostname；Tunnel 使用系统 TLS/CA，始终额外验证二维码 Desktop identity 与 E2EE ownership proof。
- 设备长期私钥及每桌面 root secret 仅保存于系统 Keychain/Keystore；没有 AsyncStorage、明文 token、业务正文日志或 Trust-All。
- 桌面列表、历史会话分页、消息历史分页、文本/思考流、取消生成、在 Desktop 显示、断线原 requestId 状态恢复。
- 纯文本消息编辑、消息删除、最后一条 assistant 重答、会话重命名/删除；破坏性操作须本地确认。
- 每会话模型、思考、voice、MCP、Skill、system prompt 与压缩配置；命令等 Desktop Writer 终态而非仅 ACK。
- 系统文档选择器上传附件：最多 25 MiB/文件，逐片 SHA-256 与最多 128 KiB E2EE 分片，进度/取消/移除；RPC 不含本地 URI/path。
- general/providers/prompts/mcpServers/tasks 业务分区完整 JSON 读写；默认隐藏业务秘密，保存本地确认 + expectedRevision，冲突不自动覆盖。

## 当前限制（不是正式发布验收）

- 已通过 TypeScript、ESLint、7 suites / 26 tests 合成 Jest、Android/iOS Metro JS 发布模式打包与四个安全/附件原生包的双平台自动链接检查。**Android arm64 Debug 原生编译已通过；独立 QA 安装包正在构建，iOS 原生编译及手机联调尚未通过**。
- Android SDK/adb 37.0.0、Java 17/21 已可用；本轮已补齐 API 36、NDK `27.1.12297006`、CMake `3.22.1`，并在线解决 Gradle foojay 缓存缺失，已成功生成 `android/app/build/outputs/apk/debug/app-debug.apk`（需 Metro），签名验证通过；正在构建包名 `com.anywheremobile.qa` 的独立内置 JS 测试包（不覆盖正式应用）。用户选择 USB 安卓手机联调，当前等待设备连接/授权。iOS 构建需 macOS + Xcode。Metro/Node 集成通过不等于 APK/IPA 或 TLS 实机验证成功。
- 已新增 `pnpm test:desktop-interop`：将相邻 `Anywhere_desktop` 的完整合成 HTTPS/WSS 网关测试切换为 Mobile TS 密码学实现；配对、RPC、业务配置、附件、流式恢复和撤销测试通过，不读取用户真实数据。
- 单个工作区目前只跟踪一个活动生成回合；仍有待完成/待恢复请求时不允许覆盖跟踪 ID。关闭/离开工作区后不持久化正文和活动回合；请重新打开历史确认 Desktop 执行结果，勿盲目重发。
- Renderer 命令未确认时显示原 requestId，并提供原请求查询；关闭面板可能让 Desktop 继续执行。
- 历史附件只显示脱敏元数据，尚未实现 Desktop 附件下载、图片/音频原生预览或完整 Markdown 排版。voice 控件控制 Desktop 会话配置，不是 Mobile 录音/播放能力。
- 老 JSON 会话需先在 Desktop 迁移。Mobile 不创建/管理 SQLite lease，不浏览 Desktop 本地文件系统。
- 业务配置当前是高级 JSON 编辑器，整分区替换；请保留完整字段。配对设备完全受信任，能读取业务秘密，请只配对自己的设备。
- v1 安全存储 namespace 不自动迁移，旧设备需重新扫描 v2 QR。Desktop 设备撤销仍在 Desktop 设置内操作。

## 工程结构

- `src/remote/`: strict protocol、密码学、配对事务、WSS/RPC、DTO、命令终态、附件分片。
- `src/native/PinnedGateway.ts`: opaque native transport bridge，禁止 JS 网络降级。
- `android/.../PinnedGatewayModule.kt`、`ios/AnywhereMobile/PinnedGateway.swift`: pinned/system TLS HTTPS/WSS；禁止自动 HTTP redirect。
- `src/services/secureStore.ts`: Keychain/Keystore identity、paired roots 和桌面索引。
- `src/hooks/`: 桌面连接/重连、会话状态机、附件队列。
- `src/components/`: QR、工作区、设置及本地危险操作确认。
- `__tests__/`: Desktop Node crypto 固定向量、拒绝路径、无 TextEncoder 运行时、流事件/恢复、附件、命令与管理 UI。

## 安装、检查与运行

仅使用 pnpm。Node >= 22.11。

```powershell
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm lint
pnpm exec jest --runInBand
```

在独立终端/后台启动 Metro：

```powershell
pnpm start
```

Android：安装匹配 React Native 工程要求的 JDK/Android SDK，设置 `ANDROID_HOME`，确认 `adb devices`，随后：

```powershell
pnpm android
```

iOS（仅 macOS，新增原生依赖后需重装 Pods）：

```sh
cd ios
bundle install
bundle exec pod install
cd ..
pnpm ios
```

只检查发布模式 JS 打包（不生成 APK/IPA）：

```powershell
New-Item -ItemType Directory -Force build/remote-v2-check | Out-Null
pnpm exec react-native bundle --platform android --dev false --entry-file index.js --bundle-output build/remote-v2-check/android.jsbundle --max-workers 2
pnpm exec react-native bundle --platform ios --dev false --entry-file index.js --bundle-output build/remote-v2-check/ios.jsbundle --max-workers 2
```

## USB 隔离联调

QA 包变体使用 `com.anywheremobile.qa`，调试签名但内置发布模式 JS/Hermes；仅供本地测试，不是正式发布签名。

```powershell
cd android
.\gradlew.bat :app:assembleQa --no-daemon -PreactNativeArchitectures=arm64-v8a --max-workers=2
cd ..
pnpm test:desktop-interop
# 手机 USB 调试授权后，安装前先确认目标设备/包名：
adb reverse tcp:17861 tcp:17861
pnpm test:phone-fixture
```

`phone-fixture` 只在 `127.0.0.1:17861` 启动真实 Desktop 网关，使用内存身份/业务配置及合成 Writer，不访问 Electron 用户目录、SQLite 或真实 AI。它生成两分钟有效的配对 HTML（只含公开 QR/验证码）；控制命令 `pair` 刷新、`devices` 只显示数量、`revoke` 撤销测试设备、`stop` 关闭。联调完成后执行 `stop` 与 `adb reverse --remove tcp:17861`。fixture 只能证明原生连接与协议/UI链路，不能替代真实 Electron Writer 验收。


## 真机验收清单

使用**专用合成测试会话、测试服务商配置和无敏感内容附件**，不要用真实用户历史或业务秘密做自动测试。

1. 同 LAN 开启 Desktop Remote，扫码 v2 QR；错误验证码/过期 QR/篡改 Desktop identity 必须拒绝。
2. LAN pin 模式：正确证书/hostname 可连，错误 pin、过期证书、hostname 不匹配必须拒绝；不能降级 Trust-All。
3. Tunnel system 模式：正常系统证书链可连，无效系统证书必须拒绝；代理只能看到 E2EE envelope，不得看到验证码、RPC、配置/附件正文。
4. App 重启后从 Keychain/Keystore 恢复；两桌面同时连接不得覆盖设备 identity；移除本机配对后 root secret 不再可用。
5. 历史分页/切换会话，打开窗口复用、隐藏 Writer 发送、文本/思考流、停止与桌面显示；断网后恢复原请求，不重复写入。
6. 消息编辑/删除/最后回复重答、会话重命名/删除：取消确认不发 RPC，保存等待 Writer 终态，Desktop 繁忙/冲突有明确错误。
7. 配置模型/工具/提示词/压缩，确认只影响目标会话；五业务分区 revision 冲突拒绝覆盖，不暴露 Remote 私钥/监听设置/本地路径。
8. 附件选择/取消/分片进度/错误 hash/超限/断网/撤销；原始文件不删除，临时缓存副本清理，Desktop 临时上传在 abort/撤销/停服后清理。
9. Desktop 撤销设备立即断连，重连拒绝；关闭 Remote 断开全部客户端并清理隐藏 Writer/上传。
10. Android/iOS 小屏布局、软键盘、系统返回键、后台切换、隐私编辑框、权限弹窗和内存压力测试。

## 安全约束

不得记录 RPC、聊天、附件、API Key、root secret 或私钥；不得把 Native 错误中的本地附件路径显示到 UI。加密 JS 字符串受 GC 管理，无法承诺内存物理抹除；byte buffers 尽可能及时清零。系统键盘/截图/已解锁设备不属于 E2EE 的保护范围。
