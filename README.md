# Anywhere Mobile

> Anywhere Desktop 的移动端伴侣。把你已配对的 Anywhere 工作空间带到 Android 或 iPhone / iPad：查看和继续会话、使用 Agent、管理常用配置，并在需要时明确接管或交还 Desktop 会话。

<p align="center">
  <a href="https://github.com/Komorebi-yaodong/anywhere-mobile">
    <img src="https://img.shields.io/badge/GitHub-anywhere--mobile-black?style=flat-square&logo=github" alt="Anywhere Mobile repository">
  </a>
  <a href="https://github.com/Komorebi-yaodong/anywheredesktop">
    <img src="https://img.shields.io/badge/Desktop-Anywhere%20Desktop-2F7D63?style=flat-square" alt="Anywhere Desktop repository">
  </a>
  <a href="https://github.com/Komorebi-yaodong/anywhere_doc">
    <img src="https://img.shields.io/badge/Docs-anywhere__doc-blue?style=flat-square&logo=readme" alt="Anywhere documentation">
  </a>
</p>

## 概览

Anywhere Mobile 不是独立的云端聊天服务。它与用户主动开启并明确配对的 Anywhere Desktop 协作：Desktop 保持本地会话、工具与数据的权威控制，Mobile 通过经过验证的加密连接进行查看、操作和继续工作。

适合以下场景：

- 在外出时查看 Desktop 已保存或已打开的会话；
- 继续已授权接管的对话，或把控制权交还给 Desktop；
- 使用 Agent、新建聊天、管理项目与常用业务配置；
- 在手机上发送文本、图片、文件或语音附件，并追踪生成、工具交互和任务状态。

## 核心体验

### 会话与工作区

- 项目分组、会话搜索、历史分页与已打开会话入口；
- 点击“已打开会话”中的会话标题可直接在 Mobile 查看对应聊天；**查看不会自动接管**；
- 接管和交还是明确的独立操作：接管后 Desktop 进入只读观察状态，交还后恢复 Desktop 控制；
- 支持流式回复、思考内容、工具调用卡、交互式选择、任务面板、会话配置、重答、编辑和删除；
- Desktop Renderer 仍是唯一 SQLite 写入者，Mobile 不直接读写 Desktop 数据库或本地文件系统。

### Agent 与配置

- Agent 路由、搜索、标签、启停和受限编辑；
- 服务商、MCP、Skill、定时任务、通用设置与关于页的移动端界面；
- Provider、MCP、Skill 等配置采用受限 DTO 和字段级更新：Mobile 不会收到本地路径、进程命令、Remote 根密钥或 TLS 私钥；
- 破坏性操作保留本地确认与版本冲突保护。

### 附件与媒体

- 可选择并加密上传图片、文档和语音附件；
- 附件分片具备大小、顺序和 SHA-256 校验；
- 已渲染媒体通过会话绑定的受限引用访问，避免将 Desktop 本地路径暴露给 Mobile。

## 安全设计

- 配对由 Desktop 主动发起：扫描二维码后仍需人工核对六位验证码；
- 每个连接使用临时密钥协商，业务请求、响应、事件和附件内容均受应用层端到端加密保护；
- 局域网连接固定 Desktop TLS 叶证书，同时保留主机名验证；Tunnel 连接使用系统 TLS 信任链；
- 不使用 Trust-All、明文 Bearer token 或 JavaScript 网络降级；
- Mobile 的设备身份与每台 Desktop 的配对秘密仅保存在系统 Keychain / Keystore，不写入普通 AsyncStorage；
- 已配对设备代表完全信任。请只配对自己控制的设备；测试结束后可在 Desktop 中撤销设备。

> 不要分享二维码、验证码、配对页面、会话内容、附件、API Key、设备秘密或私钥。

## 快速开始

1. 在 Anywhere Desktop 中启用移动端连接功能，并确认 Desktop 正在运行。
2. 在 Android 或 iOS 上安装 Anywhere Mobile。
3. 在 Mobile 中扫描 Desktop 显示的二维码，或粘贴二维码内容。
4. 在两端核对六位验证码后确认配对。
5. 从首页进入已配对的 Desktop；首次使用请从侧边栏检查会话、已打开会话和 Agent 路由。

如果 Mobile 显示连接错误，请先确认 Desktop 仍在运行、网络可达且未撤销该设备。不要通过关闭证书验证或重新使用旧二维码来绕过安全检查。

## 平台支持与构建

### 开发环境

- Node.js `>= 22.11`
- 包管理器：`pnpm`
- Android：Android SDK、JDK 17、NDK / CMake（依赖 React Native 配置）
- iOS：macOS、Xcode、Ruby / CocoaPods

安装依赖并运行质量检查：

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm lint
pnpm test --runInBand
```

### Android

连接 Android 设备后可运行开发构建：

```bash
pnpm android
```

构建封闭测试 APK：

```powershell
Set-Location android
.\gradlew.bat :app:assembleQa --no-daemon -PreactNativeArchitectures=arm64-v8a
```

`qa` 变体使用独立包名和调试签名，适用于受控测试，不是公开商店或正式发布签名。对外分发前，请在 GitHub Releases 中提供 APK、版本说明和 SHA-256 校验值。

### iOS

iOS 原生构建必须在 macOS 上完成：

```bash
cd ios
bundle install
bundle exec pod install
cd ..
pnpm ios
```

将应用安装到自己的设备可使用 Xcode 的开发签名。若要通过 TestFlight 或 App Store 向测试成员分发，需要 Apple Developer Program、有效签名与相应审核流程。

## 测试

项目使用 Jest 覆盖加密会话、连接恢复、配对、会话状态、管理界面和 Android 品牌资源等关键边界：

```bash
pnpm test --runInBand
```

在进行真实设备测试前，请使用专用测试会话、测试服务商与无敏感内容附件。不要将真实聊天、凭据或个人文件用于自动化测试。

## 当前限制

- Mobile 依赖已开启并运行的 Anywhere Desktop，不能作为独立 AI 后端使用；
- iOS 原生构建与面向测试组的签名分发需要 macOS / Xcode；
- 单个加密响应帧受大小上限保护。若提示 Desktop 返回数据过大，连接会保持，但该请求的数据暂未完整加载；分页与受限分块传输正在完善；
- 请在公开发布前确认项目许可证、隐私政策和适用的分发条款。

## 项目结构

```text
Anywhere_mobile/
├── android/                 # Android 原生工程与安全传输模块
├── ios/                     # iOS 原生工程与安全传输模块
├── src/
│   ├── components/          # 页面、会话与设置界面
│   ├── domain/              # 配对与数据模型
│   ├── hooks/               # 连接、会话和附件状态机
│   ├── native/              # Native bridge 类型边界
│   ├── remote/              # 加密、配对、RPC 与协议
│   └── services/            # Keychain / Keystore 与本地缓存
├── __tests__/               # 合成回归测试
├── App.tsx                  # 应用入口
└── package.json
```

## 贡献

欢迎提交 Issue 和 Pull Request。请在提交前：

1. 不要提交密钥、二维码、验证码、设备秘密、真实会话、附件或本地配置；
2. 使用 `pnpm`，不要混用 npm / yarn；
3. 运行 TypeScript、lint 和 Jest；
4. 对安全边界、传输协议或配对逻辑的修改，请同时补充回归测试与说明。

## 相关项目

- [Anywhere Desktop](https://github.com/Komorebi-yaodong/anywheredesktop)
- [Anywhere 文档](https://github.com/Komorebi-yaodong/anywhere_doc)

---

**Anywhere Mobile** 让你的 Anywhere Desktop 工作空间在移动设备上保持可访问、可控且可追溯。
