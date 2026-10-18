import CryptoKit
import Foundation
import React
import Security


import AVFoundation

@objc(MediaCapture)
final class MediaCapture: NSObject, RCTBridgeModule {
  static func moduleName() -> String! { "MediaCapture" }
  static func requiresMainQueueSetup() -> Bool { true }
  private var recorder: AVAudioRecorder?
  private var recordingURL: URL?
  private var generation = 0
  private let root = FileManager.default.temporaryDirectory

  @objc(startAudio:rejecter:)
  func startAudio(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard self.recorder == nil else {reject("MEDIA_BUSY", "录音正在进行。", nil);return}
      self.generation += 1
      let token = self.generation
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        DispatchQueue.main.async {
          guard granted, token == self.generation else {reject("MEDIA_PERMISSION", "麦克风权限未允许或录音已取消。", nil);return}
          do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
            let url = self.root.appendingPathComponent("remote-audio-\(UUID().uuidString).wav")
            self.recordingURL = url
            let recorder = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false])
            self.recorder = recorder
            guard recorder.record(forDuration: 120) else {throw NSError(domain: "MediaCapture", code: 1)}
            resolve(nil)
          } catch {self.cleanup();reject("MEDIA_RECORD_START_FAILED", "无法开始录音。", nil)}
        }
      }
    }
  }
  @objc(stopAudio:rejecter:)
  func stopAudio(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard let recorder=self.recorder, let url=self.recordingURL else {reject("MEDIA_NOT_RECORDING", "没有录音。", nil);return}
      let duration=recorder.currentTime * 1000
      recorder.stop();self.recorder=nil;self.recordingURL=nil
      try? AVAudioSession.sharedInstance().setActive(false)
      do {
        let size=(try FileManager.default.attributesOfItem(atPath:url.path)[.size] as? NSNumber)?.intValue ?? 0
        guard size>44, size<5*1024*1024 else {throw NSError(domain:"MediaCapture",code:2)}
        resolve(["captureId":url.lastPathComponent,"name":"语音消息.wav","type":"audio/wav","size":size,"durationMs":duration])
      }catch{try? FileManager.default.removeItem(at:url);reject("MEDIA_RECORD_STOP_FAILED","录音处理失败。",nil)}
    }
  }
  @objc(cancelAudio:rejecter:)
  func cancelAudio(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {DispatchQueue.main.async {self.generation += 1;self.cleanup();resolve(nil)}}
  private func capture(_ id: String) throws -> URL {
    guard id.range(of:"^remote-audio-[0-9a-fA-F-]{36}\\.wav$",options:.regularExpression) != nil else {throw NSError(domain:"MediaCapture",code:3)}
    let url=root.appendingPathComponent(id)
    let values=try url.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey])
    guard values.isRegularFile==true,values.isSymbolicLink != true else {throw NSError(domain:"MediaCapture",code:4)}
    return url
  }
  @objc(readCaptureChunk:offset:length:resolver:rejecter:)
  func readCaptureChunk(_ id: String, offset: Double, length: Double, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    do {
      guard offset.isFinite,length.isFinite,offset>=0,length>0,length<=131072,offset.rounded()==offset,length.rounded()==length else {throw NSError(domain:"MediaCapture",code:5)}
      let file=try FileHandle(forReadingFrom:capture(id));defer{try? file.close()}
      try file.seek(toOffset:UInt64(offset))
      let data=try file.read(upToCount:Int(length)) ?? Data()
      guard data.count==Int(length) else {throw NSError(domain:"MediaCapture",code:6)}
      resolve(data.base64EncodedString())
    }catch{reject("MEDIA_READ_FAILED","录音读取失败。",nil)}
  }
  @objc(deleteCapture:resolver:rejecter:)
  func deleteCapture(_ id:String,resolver resolve:RCTPromiseResolveBlock,rejecter reject:RCTPromiseRejectBlock) {do{try FileManager.default.removeItem(at:capture(id));resolve(nil)}catch{reject("MEDIA_DELETE_FAILED","录音清理失败。",nil)}}
  private func cleanup(){recorder?.stop();recorder=nil;if let url=recordingURL{try? FileManager.default.removeItem(at:url)};recordingURL=nil;try? AVAudioSession.sharedInstance().setActive(false)}
  deinit {cleanup()}
}

@objc(PinnedGateway)
final class PinnedGateway: RCTEventEmitter, URLSessionDelegate, URLSessionWebSocketDelegate {
  private enum TLSPolicy {
    case system
    case pinned(fingerprint: String, host: String)
  }

  private struct SocketContext {
    let connectionId: String
    let session: URLSession
    let pingTimer: DispatchSourceTimer
  }

  private let stateLock = NSLock()
  private var sessionPolicies: [ObjectIdentifier: TLSPolicy] = [:]
  private var sockets: [String: URLSessionWebSocketTask] = [:]
  private var socketContexts: [ObjectIdentifier: SocketContext] = [:]

  override static func requiresMainQueueSetup() -> Bool { false }
  override func supportedEvents() -> [String] { [Self.eventName] }

  @objc(postJson:resolver:rejecter:)
  func postJson(
    _ options: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      let endpoint = try normalizedEndpoint(try required(options, "endpoint"))
      let path = try normalizedPath(try required(options, "path"))
      let body = try rawString(options, "body")
      let policy = try tlsPolicy(options, endpoint: endpoint)
      guard let url = joinedURL(endpoint: endpoint, path: path) else {
        throw GatewayError.invalid("HTTPS 请求地址无效。")
      }

      var request = URLRequest(url: url)
      request.httpMethod = "POST"
      request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
      request.httpBody = Data(body.utf8)

      let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
      setPolicy(policy, for: session)
      let task = session.dataTask(with: request) { [weak self, weak session] data, response, error in
        if let session {
          self?.removePolicy(for: session)
          session.finishTasksAndInvalidate()
        }
        if let error {
          reject("HTTPS_REQUEST_FAILED", self?.safeError(error) ?? "安全连接失败。", error)
          return
        }
        guard let http = response as? HTTPURLResponse else {
          reject("HTTPS_REQUEST_FAILED", "桌面未返回有效 HTTP 响应。", nil)
          return
        }
        let responseData = data ?? Data()
        guard responseData.count <= Self.maxResponseBytes else {
          reject("HTTPS_RESPONSE_TOO_LARGE", "桌面响应超过大小限制。", nil)
          return
        }
        guard let responseBody = String(data: responseData, encoding: .utf8) else {
          reject("HTTPS_RESPONSE_INVALID", "桌面响应不是有效 UTF-8。", nil)
          return
        }
        resolve(["status": http.statusCode, "body": responseBody])
      }
      task.resume()
    } catch {
      reject("INVALID_TRANSPORT_OPTIONS", safeError(error), error)
    }
  }

  @objc(connectSocket:resolver:rejecter:)
  func connectSocket(
    _ options: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      let connectionId = try required(options, "connectionId")
      let endpoint = try normalizedEndpoint(try required(options, "endpoint"))
      let path = try normalizedPath(try required(options, "path"))
      let policy = try tlsPolicy(options, endpoint: endpoint)
      guard let httpsURL = joinedURL(endpoint: endpoint, path: path),
            var components = URLComponents(url: httpsURL, resolvingAgainstBaseURL: false) else {
        throw GatewayError.invalid("WebSocket 地址无效。")
      }
      components.scheme = "wss"
      guard let socketURL = components.url else {
        throw GatewayError.invalid("WebSocket 地址无效。")
      }

      closeSocket(connectionId, code: .goingAway)
      let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
      setPolicy(policy, for: session)
      let socket = session.webSocketTask(with: socketURL)
      let pingTimer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
      pingTimer.schedule(deadline: .now() + .seconds(15), repeating: .seconds(15))
      pingTimer.setEventHandler { [weak socket] in
        socket?.sendPing { _ in
          // A failed ping is followed by URLSession receive/delegate failure.
          // Let the shared close path emit exactly one transport event.
        }
      }
      withStateLock {
        sockets[connectionId] = socket
        socketContexts[ObjectIdentifier(socket)] = SocketContext(
          connectionId: connectionId,
          session: session,
          pingTimer: pingTimer
        )
      }
      pingTimer.resume()
      socket.resume()
      receiveNext(socket, connectionId: connectionId)
      resolve(nil)
    } catch {
      reject("SOCKET_CONNECT_FAILED", safeError(error), error)
    }
  }

  @objc(sendText:text:resolver:rejecter:)
  func sendText(
    _ connectionId: String,
    text: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let socket = withStateLock({ sockets[connectionId] }) else {
      reject("SOCKET_UNAVAILABLE", "桌面连接不可用。", nil)
      return
    }
    socket.send(.string(text)) { error in
      if let error {
        reject("SOCKET_SEND_FAILED", self.safeError(error), error)
      } else {
        resolve(nil)
      }
    }
  }

  @objc(disconnect:resolver:rejecter:)
  func disconnect(
    _ connectionId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    closeSocket(connectionId, code: .normalClosure)
    resolve(nil)
  }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    handleChallenge(session: session, challenge: challenge, completionHandler: completionHandler)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    handleChallenge(session: session, challenge: challenge, completionHandler: completionHandler)
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    guard let context = withStateLock({ socketContexts[ObjectIdentifier(webSocketTask)] }) else { return }
    emit(context.connectionId, type: "connected")
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    guard let context = removeSocket(webSocketTask) else { return }
    context.pingTimer.cancel()
    context.session.finishTasksAndInvalidate()
    removePolicy(for: context.session)
    emit(context.connectionId, type: "disconnected", message: "连接已关闭。")
  }

  private func receiveNext(_ socket: URLSessionWebSocketTask, connectionId: String) {
    socket.receive { [weak self, weak socket] result in
      guard let self, let socket else { return }
      switch result {
      case .success(let message):
        switch message {
        case .string(let text):
          self.emit(connectionId, type: "message", message: text)
          self.receiveNext(socket, connectionId: connectionId)
        case .data:
          socket.cancel(with: .unsupportedData, reason: nil)
          self.emit(connectionId, type: "error", message: "桌面发送了不受支持的二进制帧。")
        @unknown default:
          socket.cancel(with: .unsupportedData, reason: nil)
          self.emit(connectionId, type: "error", message: "桌面发送了未知帧类型。")
        }
      case .failure(let error):
        if let context = self.removeSocket(socket) {
          context.pingTimer.cancel()
          context.session.invalidateAndCancel()
          self.removePolicy(for: context.session)
          self.emit(connectionId, type: "error", message: self.safeError(error))
        }
      }
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    // Remote endpoints are identity-bound. Never forward pairing proofs via redirects.
    completionHandler(nil)
  }


  private func handleChallenge(
    session: URLSession,
    challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    guard let policy = withStateLock({ sessionPolicies[ObjectIdentifier(session)] }) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    switch policy {
    case .system:
      completionHandler(.performDefaultHandling, nil)
    case .pinned(let fingerprint, let host):
      guard let trust = challenge.protectionSpace.serverTrust,
            challenge.protectionSpace.host.caseInsensitiveCompare(host) == .orderedSame,
            pinnedTrustMatches(trust, fingerprint: fingerprint, host: host) else {
        completionHandler(.cancelAuthenticationChallenge, nil)
        return
      }
      completionHandler(.useCredential, URLCredential(trust: trust))
    }
  }

  private func pinnedTrustMatches(_ trust: SecTrust, fingerprint: String, host: String) -> Bool {
    guard let certificate = SecTrustGetCertificateAtIndex(trust, 0) else { return false }
    let certificateData = SecCertificateCopyData(certificate) as Data
    guard sha256(certificateData) == fingerprint else { return false }

    // Trust only the pinned leaf while still enforcing its validity period and
    // the SSL hostname policy. This supports Desktop self-signed certificates
    // without accepting any other untrusted certificate.
    SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
    SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
    SecTrustSetAnchorCertificatesOnly(trust, true)
    return SecTrustEvaluateWithError(trust, nil)
  }

  private func tlsPolicy(_ options: NSDictionary, endpoint: URL) throws -> TLSPolicy {
    switch try required(options, "tlsMode") {
    case "system":
      return .system
    case "pinned":
      guard let host = endpoint.host else { throw GatewayError.invalid("桌面端地址缺少主机名。") }
      return .pinned(
        fingerprint: try normalizedFingerprint(try required(options, "certificateFingerprint")),
        host: host
      )
    default:
      throw GatewayError.invalid("tlsMode 必须是 pinned 或 system。")
    }
  }

  private func normalizedEndpoint(_ input: String) throws -> URL {
    guard let components = URLComponents(string: input),
          components.scheme?.lowercased() == "https",
          components.host != nil,
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil,
          let url = components.url else {
      throw GatewayError.invalid("桌面端地址必须是无凭据、查询或片段的 HTTPS 地址。")
    }
    return url
  }

  private func normalizedPath(_ path: String) throws -> String {
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    guard path.hasPrefix("/"),
          !path.hasPrefix("//"),
          !path.contains("?"),
          !path.contains("#"),
          !segments.contains(where: { $0 == ".." }) else {
      throw GatewayError.invalid("请求路径无效。")
    }
    return path
  }

  private func joinedURL(endpoint: URL, path: String) -> URL? {
    guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
    let basePath = components.percentEncodedPath.hasSuffix("/")
      ? String(components.percentEncodedPath.dropLast())
      : components.percentEncodedPath
    components.percentEncodedPath = basePath + path
    components.query = nil
    components.fragment = nil
    return components.url
  }

  private func closeSocket(_ connectionId: String, code: URLSessionWebSocketTask.CloseCode) {
    let record: (URLSessionWebSocketTask, SocketContext)? = withStateLock {
      guard let socket = sockets.removeValue(forKey: connectionId),
            let context = socketContexts.removeValue(forKey: ObjectIdentifier(socket)) else { return nil }
      return (socket, context)
    }
    guard let (socket, context) = record else { return }
    context.pingTimer.cancel()
    socket.cancel(with: code, reason: nil)
    context.session.invalidateAndCancel()
    removePolicy(for: context.session)
  }

  private func removeSocket(_ socket: URLSessionWebSocketTask) -> SocketContext? {
    withStateLock {
      guard let context = socketContexts.removeValue(forKey: ObjectIdentifier(socket)) else { return nil }
      if sockets[context.connectionId] === socket {
        sockets.removeValue(forKey: context.connectionId)
      }
      return context
    }
  }

  private func setPolicy(_ policy: TLSPolicy, for session: URLSession) {
    withStateLock { sessionPolicies[ObjectIdentifier(session)] = policy }
  }

  private func removePolicy(for session: URLSession) {
    withStateLock { sessionPolicies.removeValue(forKey: ObjectIdentifier(session)) }
  }

  private func withStateLock<T>(_ action: () -> T) -> T {
    stateLock.lock()
    defer { stateLock.unlock() }
    return action()
  }

  private func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02X", $0) }.joined()
  }

  private func required(_ map: NSDictionary, _ key: String) throws -> String {
    guard let value = map[key] as? String,
          !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw GatewayError.invalid("缺少字段：\(key)")
    }
    return value.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func rawString(_ map: NSDictionary, _ key: String) throws -> String {
    guard let value = map[key] as? String else {
      throw GatewayError.invalid("缺少字段：\(key)")
    }
    return value
  }

  private func normalizedFingerprint(_ input: String) throws -> String {
    let hex = input.filter { $0.isHexDigit }.uppercased()
    guard hex.range(of: "^[A-F0-9]{64}$", options: .regularExpression) != nil else {
      throw GatewayError.invalid("证书指纹必须是 SHA-256 十六进制值。")
    }
    return hex
  }

  private func safeError(_ error: Error) -> String {
    String(error.localizedDescription.prefix(300))
  }

  private func emit(_ connectionId: String, type: String, message: String? = nil) {
    var body: [String: Any] = ["connectionId": connectionId, "type": type]
    if let message { body["message"] = message }
    sendEvent(withName: Self.eventName, body: body)
  }

  private enum GatewayError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
      if case .invalid(let text) = self { return text }
      return nil
    }
  }

  private static let eventName = "AnywhereGatewayEvent"
  private static let maxResponseBytes = 512 * 1024
}
