import Foundation

import CoreFoundation
import CryptoKit
import Security

struct NativeGatewayFailure: Error { let code: String }

/// One key/sequence owner per socket. No root secret or persistent storage.
final class GatewayNativeCrypto {
  private let id: String
  private var sendKey: Data
  private var receiveKey: Data
  private var sendSequence: UInt64 = 1
  private var receiveSequence: UInt64 = 1
  private var nonceCounter: UInt64 = 1
  private var prefix = Data(count: 4)
  private var maximum = 1024 * 1024
  private var closed = false
  init(id: String, send: Data, receive: Data) throws {
    guard id.range(of: "^[A-Za-z0-9._:-]{16,128}$", options: .regularExpression) != nil, send.count == 32, receive.count == 32 else { throw NativeGatewayFailure(code: "remote_session_key_invalid") }
    self.id = id; sendKey = send; receiveKey = receive
    let status = prefix.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 4, $0.baseAddress!) }
    guard status == errSecSuccess else { throw NativeGatewayFailure(code: "remote_random_failed") }
  }
  static func b64(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
  static func decode(_ text: String, min: Int, max: Int) throws -> Data {
    guard text.utf8.count <= (max * 4 / 3 + 4), text.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw NativeGatewayFailure(code: "remote_invalid_base64url") }
    let padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - text.count % 4) % 4)
    guard let data = Data(base64Encoded: padded), (min...max).contains(data.count), b64(data) == text else { throw NativeGatewayFailure(code: "remote_invalid_base64url") }
    return data
  }
  static func object(_ text: String) throws -> [String: Any] {
    guard let data = text.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeGatewayFailure(code: "remote_frame_payload_invalid") }
    return value
  }
  static func json(_ object: [String: Any]) throws -> String {
    let bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    guard let text = String(data: bytes, encoding: .utf8) else { throw NativeGatewayFailure(code: "remote_invalid_utf8") }
    return text
  }
  private func aad(_ sequence: UInt64, _ direction: String) throws -> Data {
    Data(try Self.json(["direction": direction, "sequence": sequence, "sessionId": id, "type": "remote.encrypted", "v": 2]).utf8)
  }
  func adaptive() throws { guard !closed else { throw NativeGatewayFailure(code: "remote_session_closed") }; maximum = 16 * 1024 * 1024 }
  func encrypt(_ text: String) throws -> String {
    guard !closed else { throw NativeGatewayFailure(code: "remote_session_closed") }
    guard sendSequence <= 9007199254740991, nonceCounter < UInt64.max else { throw NativeGatewayFailure(code: "remote_sequence_invalid") }
    _ = try Self.object(text)
    var bytes = Data(text.utf8); defer { bytes.resetBytes(in: 0..<bytes.count) }
    guard !bytes.isEmpty, bytes.count <= maximum else { throw NativeGatewayFailure(code: "remote_payload_size_invalid") }
    var counter = nonceCounter.bigEndian
    var nonceData = prefix; withUnsafeBytes(of: &counter) { nonceData.append(contentsOf: $0) }; nonceCounter += 1
    let sealed = try AES.GCM.seal(bytes, using: SymmetricKey(data: sendKey), nonce: AES.GCM.Nonce(data: nonceData), authenticating: aad(sendSequence, "client-to-desktop"))
    let frame = try Self.json(["v": 2, "type": "remote.encrypted", "sessionId": id, "sequence": sendSequence, "nonce": Self.b64(nonceData), "ciphertext": Self.b64(sealed.ciphertext), "tag": Self.b64(sealed.tag)])
    guard frame.utf8.count <= maximum else { throw NativeGatewayFailure(code: "remote_payload_size_invalid") }
    sendSequence += 1; return frame
  }
  func encryptBinary(_ metadata: String, data: Data) throws -> Data {
    guard !closed, sendSequence <= 9007199254740991, nonceCounter < UInt64.max else {throw NativeGatewayFailure(code: "remote_session_closed")}
    let meta = Data(metadata.utf8)
    guard meta.count >= 2, meta.count <= 1024, data.count > 0, data.count <= 2 * 1024 * 1024 else {throw NativeGatewayFailure(code: "remote_binary_frame_invalid")}
    var length = UInt32(meta.count).bigEndian
    var plain = withUnsafeBytes(of: &length) {Data($0)}; plain.append(meta); plain.append(data)
    defer {plain.resetBytes(in: 0..<plain.count)}
    var counter = nonceCounter.bigEndian; var nonce = prefix; withUnsafeBytes(of: &counter) {nonce.append(contentsOf: $0)}; nonceCounter += 1
    let auth = Data(try Self.json(["direction": "client-to-desktop", "sequence": sendSequence, "sessionId": id, "type": "remote.binary", "v": 2]).utf8)
    let sealed = try AES.GCM.seal(plain, using: SymmetricKey(data: sendKey), nonce: AES.GCM.Nonce(data: nonce), authenticating: auth)
    var sequence = sendSequence.bigEndian
    var frame = Data("AWB1".utf8); withUnsafeBytes(of: &sequence) {frame.append(contentsOf: $0)}; frame.append(nonce); frame.append(sealed.ciphertext); frame.append(sealed.tag)
    guard frame.count <= maximum else {throw NativeGatewayFailure(code: "remote_payload_size_invalid")}
    sendSequence += 1; return frame
  }

  func decrypt(_ text: String) throws -> String {
    guard !closed else { throw NativeGatewayFailure(code: "remote_session_closed") }
    guard text.utf8.count <= maximum else { throw NativeGatewayFailure(code: "remote_payload_size_invalid") }
    let frame = try Self.object(text)
    guard frame["type"] as? String == "remote.encrypted", frame["v"] as? Int == 2 else { throw NativeGatewayFailure(code: "remote_frame_invalid") }
    guard frame["sessionId"] as? String == id else { throw NativeGatewayFailure(code: "remote_session_mismatch") }
    guard let sequence = frame["sequence"] as? NSNumber, CFGetTypeID(sequence) != CFBooleanGetTypeID(), sequence.doubleValue >= 1, sequence.doubleValue <= 9007199254740991, sequence.doubleValue.rounded() == sequence.doubleValue else { throw NativeGatewayFailure(code: "remote_sequence_invalid") }
    guard sequence.uint64Value == receiveSequence else { throw NativeGatewayFailure(code: sequence.uint64Value < receiveSequence ? "remote_frame_replayed" : "remote_frame_out_of_order") }
    let nonce = try Self.decode(frame["nonce"] as? String ?? "", min: 12, max: 12)
    let ciphertext = try Self.decode(frame["ciphertext"] as? String ?? "", min: 1, max: maximum)
    let tag = try Self.decode(frame["tag"] as? String ?? "", min: 16, max: 16)
    let sealed = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ciphertext, tag: tag)
    var plain: Data
    do { plain = try AES.GCM.open(sealed, using: SymmetricKey(data: receiveKey), authenticating: aad(receiveSequence, "desktop-to-client")) }
    catch { throw NativeGatewayFailure(code: "remote_frame_auth_failed") }
    defer { plain.resetBytes(in: 0..<plain.count) }
    guard let result = String(data: plain, encoding: .utf8) else { throw NativeGatewayFailure(code: "remote_invalid_utf8") }
    _ = try Self.object(result); receiveSequence += 1; return result
  }
  func close() { closed = true; sendKey.resetBytes(in: 0..<sendKey.count); receiveKey.resetBytes(in: 0..<receiveKey.count) }
}

/// The serial state queue owns AEAD state; URLSession callbacks only enqueue.
final class GatewayNativeSession {
  typealias Reply = (Result<String, Error>) -> Void

  private struct Write { let value: String; let encrypted: Bool; let check: () throws -> Void; let submitted: () -> Void; let reply: Reply; let raw: Data? }
  private let queue = DispatchQueue(label: "gateway.native-session")
  private let lock = NSLock()
  private var closed = false
  private var queuedReceiveBytes = 0
  private var crypto: GatewayNativeCrypto?
  private var beforeKeys: [String] = []
  private var writes: [Write] = []
  private var writing = false
  private var bytes = 0
  private let sendText: (String, @escaping (Error?) -> Void) -> Void
  private let sendData: (Data, @escaping (Error?) -> Void) -> Void
  private let deliver: (String) -> Void
  private let failure: (String) -> Void
  var consumeResponse: ([String: Any]) -> Bool = { _ in false }
  init(send: @escaping (String, @escaping (Error?) -> Void) -> Void, binary: @escaping (Data, @escaping (Error?) -> Void) -> Void, deliver: @escaping (String) -> Void, failure: @escaping (String) -> Void) { sendText = send; sendData = binary; self.deliver = deliver; self.failure = failure }
  private func isClosed() -> Bool { lock.lock(); defer { lock.unlock() }; return closed }
  func install(id: String, send: String, receive: String, completion: @escaping Reply) {
    queue.async {
      do {
        guard !self.isClosed(), self.crypto == nil else { throw NativeGatewayFailure(code: "remote_session_state_invalid") }
        var a = try GatewayNativeCrypto.decode(send, min: 32, max: 32)
        defer { a.resetBytes(in: 0..<a.count) }
        var b = try GatewayNativeCrypto.decode(receive, min: 32, max: 32)
        defer { b.resetBytes(in: 0..<b.count) }
        self.crypto = try GatewayNativeCrypto(id: id, send: a, receive: b)
        let pending = self.beforeKeys; self.beforeKeys.removeAll()
        for text in pending { try self.decrypt(text) }
        completion(.success(""))
      } catch { completion(.failure(error)); self.fail(error) }
    }
  }
  func adaptive(_ completion: @escaping Reply) { queue.async { do { guard !self.isClosed(), let crypto = self.crypto else { throw NativeGatewayFailure(code: "remote_session_closed") }; try crypto.adaptive(); completion(.success("")) } catch { completion(.failure(error)) } } }
  func receive(_ text: String) {
    lock.lock(); if closed { lock.unlock(); return }; queuedReceiveBytes += text.utf8.count; let over = queuedReceiveBytes > 32 * 1024 * 1024 || text.utf8.count > 16 * 1024 * 1024; lock.unlock()
    if over { fail(NativeGatewayFailure(code: "remote_receive_capacity")); return }
    queue.async {
      guard !self.isClosed() else { return }
      do {
        if self.crypto != nil { try self.decrypt(text) }
        else {
          let frame = try GatewayNativeCrypto.object(text)
          if frame["type"] as? String == "remote.encrypted" {
            guard self.beforeKeys.count < 8 else { throw NativeGatewayFailure(code: "remote_receive_capacity") }; self.beforeKeys.append(text)
          } else {
            guard text.utf8.count <= 65536, frame["type"] as? String == "remote.session.accept" else { throw NativeGatewayFailure(code: "remote_session_accept_invalid") }
            self.unaccount(text); self.deliver(text)
          }
        }
      } catch { self.fail(error) }
    }
  }
  private func unaccount(_ text: String) { lock.lock(); queuedReceiveBytes -= text.utf8.count; lock.unlock() }
  private func decrypt(_ text: String) throws {
    guard !isClosed(), let crypto else { throw NativeGatewayFailure(code: "remote_session_closed") }
    let plain = try crypto.decrypt(text); unaccount(text)
    if !consumeResponse(try GatewayNativeCrypto.object(plain)) { deliver(plain) }
  }
  func send(_ value: String, encrypted: Bool = true, check: @escaping () throws -> Void = {}, submitted: @escaping () -> Void = {}, raw: Data? = nil, completion: @escaping Reply) {
    guard value.utf8.count <= 16 * 1024 * 1024 else { completion(.failure(NativeGatewayFailure(code: "remote_payload_size_invalid"))); return }
    queue.async {
      guard !self.isClosed() else { completion(.failure(NativeGatewayFailure(code: "remote_client_closed"))); return }
      guard self.writes.count < 32, self.bytes + (value.utf8.count * 2 + (raw?.count ?? 0)) <= 32 * 1024 * 1024 else { completion(.failure(NativeGatewayFailure(code: "remote_send_capacity"))); return }
      self.writes.append(Write(value: value, encrypted: encrypted, check: check, submitted: submitted, reply: completion, raw: raw))
      self.bytes += (value.utf8.count * 2 + (raw?.count ?? 0))
      self.pump()
    }
  }
  private func pump() {
    guard !writing, !writes.isEmpty, !isClosed() else { return }
    let item = writes[0]
    let text: String
    var binaryFrame: Data?
    do {
      try item.check()
      if item.encrypted { guard let crypto else { throw NativeGatewayFailure(code: "remote_session_state_invalid") }; if let raw = item.raw {binaryFrame = try crypto.encryptBinary(item.value, data: raw);text = ""} else {text = try crypto.encrypt(item.value)} }
      else { text = item.value }
    } catch { writes.removeFirst(); bytes -= (item.value.utf8.count * 2 + (item.raw?.count ?? 0)); item.reply(.failure(error)); pump(); return }
    writing = true; item.submitted()

    let timeout = DispatchWorkItem { [weak self] in self?.fail(NativeGatewayFailure(code: "remote_write_timeout")) }
    queue.asyncAfter(deadline: .now() + 65, execute: timeout)
    let send: (@escaping (Error?) -> Void) -> Void = { completion in
      if let frame = binaryFrame {self.sendData(frame, completion)} else {self.sendText(text, completion)}
    }
    send { error in self.queue.async {
      timeout.cancel(); guard !self.isClosed() else { return }
      if let error { self.fail(error); return }
      guard !self.writes.isEmpty else { return }

      self.writes.removeFirst(); self.bytes -= (item.value.utf8.count * 2 + (item.raw?.count ?? 0)); self.writing = false; item.reply(.success("")); self.pump()
    } }
  }
  private func fail(_ error: Error) { let code = (error as? NativeGatewayFailure)?.code ?? "remote_transport_error"; close(code: code); failure(code) }
  func close(code: String = "remote_client_closed") {

    lock.lock(); if closed { lock.unlock(); return }; closed = true; lock.unlock()
    queue.async {
      self.crypto?.close(); self.crypto = nil; self.beforeKeys.removeAll()
      self.lock.lock(); self.queuedReceiveBytes = 0; self.lock.unlock()
      let pending = self.writes; self.writes.removeAll(); self.bytes = 0; self.writing = false
      for item in pending { item.reply(.failure(NativeGatewayFailure(code: code))) }
    }
  }
}
