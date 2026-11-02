import Foundation
import CryptoKit

/// Immutable app-cache snapshots, scoped to exactly one native connection.
final class GatewayNativeUploads {
  typealias Completion = (Result<String, Error>) -> Void
  private struct Snapshot { let url: URL; let name: String; let type: String; let size: Int; let created: Date }
  private final class Waiter {
    let ready = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var result: Result<[String: Any], Error>?
    func finish(_ value: Result<[String: Any], Error>) { lock.lock(); if result == nil { result = value; ready.signal() }; lock.unlock() }
    func wait(_ timeout: TimeInterval) throws -> [String: Any] {
      guard ready.wait(timeout: .now() + timeout) == .success else { throw NativeGatewayFailure(code: "remote_request_timeout") }
      lock.lock(); defer { lock.unlock() }; return try result!.get()
    }
  }
  private final class Permit {
    let lock = NSLock(); var valid = true
    func invalidate() { lock.lock(); valid = false; lock.unlock() }
    func check() throws { lock.lock(); defer { lock.unlock() }; guard valid else { throw NativeGatewayFailure(code: "remote_upload_cancelled") } }
  }
  private let session: GatewayNativeSession
  private let progress: (String, String, Int, Int) -> Void
  private let worker = OperationQueue()
  private let lock = NSLock()
  private var files: [String: Snapshot] = [:]
  private var replies: [String: Waiter] = [:]
  private var closed = false
  private var cancelled = false
  private var activeTask = ""
  private var closeCode = "remote_client_closed"
  private var retained = 0
  private var activeBytes = 0
  private let prefix = "native-upload-" + UUID().uuidString + "-"
  private let directory = FileManager.default.temporaryDirectory.appendingPathComponent("gateway-images-" + UUID().uuidString, isDirectory: true)
  init(session: GatewayNativeSession, progress: @escaping (String, String, Int, Int) -> Void) {
    self.session = session; self.progress = progress
    worker.maxConcurrentOperationCount = 1; worker.qualityOfService = .utility
    session.consumeResponse = { [weak self] value in self?.response(value) ?? false }
  }
  private func check() throws { lock.lock(); defer { lock.unlock() }; if closed { throw NativeGatewayFailure(code: closeCode) }; if cancelled { throw NativeGatewayFailure(code: "remote_upload_cancelled") } }
  private func enqueue(_ completion: @escaping Completion, _ work: @escaping () throws -> String) {
    lock.lock(); let unavailable = closed || worker.operationCount >= 8; lock.unlock()
    guard !unavailable else { completion(.failure(NativeGatewayFailure(code: "remote_upload_capacity"))); return }
    worker.addOperation {
      do { completion(.success(try work())) } catch { completion(.failure(error)) }
    }
  }
  func register(path: String, name: String, type: String, completion: @escaping Completion) {
    enqueue(completion) {
      try self.check()
      guard !name.isEmpty, name.utf8.count <= 255, name != ".", name != "..", name.rangeOfCharacter(from: .controlCharacters) == nil, !name.contains("/"), !name.contains("\\") else { throw NativeGatewayFailure(code: "remote_upload_name_invalid") }
      guard type.range(of: "^image/[A-Za-z0-9!#$&^_.+-]{1,126}$", options: .regularExpression) != nil else { throw NativeGatewayFailure(code: "remote_upload_type_invalid") }
      let original = URL(fileURLWithPath: path)
      let values = try original.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
      let source = original.resolvingSymlinksInPath().standardizedFileURL
      let roots = [FileManager.default.temporaryDirectory] + FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
      let authorized = roots.contains { root in
        let base = root.resolvingSymlinksInPath().standardizedFileURL.path.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        return !base.isEmpty && source.path.hasPrefix(base + "/")
      }
      guard values.isSymbolicLink != true, values.isRegularFile == true, authorized else { throw NativeGatewayFailure(code: "remote_upload_source_invalid") }
      try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
      let target = self.directory.appendingPathComponent(UUID().uuidString + ".part")
      guard FileManager.default.createFile(atPath: target.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw NativeGatewayFailure(code: "remote_upload_source_invalid") }
      var keep = false
      defer { if !keep { try? FileManager.default.removeItem(at: target) } }
      let input = try FileHandle(forReadingFrom: source); defer { try? input.close() }
      let output = try FileHandle(forWritingTo: target); defer { try? output.close() }
      var size = 0
      while true {
        try self.check(); let bytes = try input.read(upToCount: 65536) ?? Data(); if bytes.isEmpty { break }
        size += bytes.count; guard size <= 25 * 1024 * 1024 else { throw NativeGatewayFailure(code: "remote_upload_size_invalid") }; try output.write(contentsOf: bytes)
      }
      guard size > 0 else { throw NativeGatewayFailure(code: "remote_upload_size_invalid") }
      let handle = UUID().uuidString
      self.lock.lock(); defer { self.lock.unlock() }
      let expired = self.files.filter { Date().timeIntervalSince($0.value.created) >= 600 }
      for (key, file) in expired { self.files.removeValue(forKey: key); self.retained -= file.size; try? FileManager.default.removeItem(at: file.url) }
      guard !self.closed, self.files.count < 8, self.retained + self.activeBytes + size <= 64 * 1024 * 1024 else { throw NativeGatewayFailure(code: "remote_upload_capacity") }
      self.files[handle] = Snapshot(url: target, name: name, type: type, size: size, created: Date()); self.retained += size; keep = true
      return handle
    }
  }
  func release(_ handle: String) { lock.lock(); let file = files.removeValue(forKey: handle); if let file { retained -= file.size }; lock.unlock(); if let file { try? FileManager.default.removeItem(at: file.url) } }
  func upload(handle: String, task: String, wrapped: Bool, completion: @escaping Completion) {
    lock.lock()
    guard !closed, activeTask.isEmpty, let file = files.removeValue(forKey: handle) else { lock.unlock(); completion(.failure(NativeGatewayFailure(code: "remote_upload_busy"))); return }
    retained -= file.size; activeBytes = file.size; activeTask = task; cancelled = false; lock.unlock()
    worker.addOperation {
      var uploadId = ""
      defer {
        try? FileManager.default.removeItem(at: file.url)
        self.lock.lock(); self.activeTask = ""; self.activeBytes = 0; self.cancelled = false; let removeDirectory = self.closed; self.lock.unlock()
        if removeDirectory { try? FileManager.default.removeItem(at: self.directory) }
      }
      do {
        try self.check(); self.progress(task, "hashing", 0, file.size)

        self.session.trace("upload_start", bytes: file.size)
        let input = try FileHandle(forReadingFrom: file.url); defer { try? input.close() }
        var hash = SHA256(); var total = 0
        while true { try self.check(); let bytes = try input.read(upToCount: 65536) ?? Data(); if bytes.isEmpty { break }; hash.update(data: bytes); total += bytes.count }
        guard total == file.size else { throw NativeGatewayFailure(code: "remote_upload_source_changed") }
        let sha = GatewayNativeCrypto.b64(Data(hash.finalize()))
        self.progress(task, "creating", 0, file.size)
        let begin = try self.rpc("attachment.begin", ["name": file.name, "type": file.type, "size": file.size, "sha256": sha], wrapped: wrapped)
        guard let upload = begin["upload"] as? [String: Any], let id = upload["uploadId"] as? String, id.range(of: "^[A-Za-z0-9._:-]{16,160}$", options: .regularExpression) != nil, upload["receivedBytes"] as? Int == 0, upload["nextChunkIndex"] as? Int == 0, let peer = upload["maxChunkBytes"] as? Int else { throw NativeGatewayFailure(code: "remote_upload_response_invalid") }
        uploadId = id; let adaptive = upload["adaptive"] as? Bool == true
        guard peer > 0, peer <= (adaptive ? 8 * 1024 * 1024 : 512 * 1024) else { throw NativeGatewayFailure(code: "remote_upload_response_invalid") }
        let sizing = Sizer(maximum: min(peer, 2 * 1024 * 1024)); var offset = 0; var index = 0
        try input.seek(toOffset: 0)
        while offset < file.size {
          try self.check(); let length = min(sizing.size, file.size - offset); let started = ProcessInfo.processInfo.systemUptime
          let bytes = try input.read(upToCount: length) ?? Data(); guard bytes.count == length else { throw NativeGatewayFailure(code: "remote_upload_source_changed") }
          let data = GatewayNativeCrypto.b64(bytes); let preparation = (ProcessInfo.processInfo.systemUptime - started) * 1000
          self.progress(task, index == 0 ? "waiting_first_ack" : "uploading", offset, file.size)
          let response = try self.rpc("attachment.chunk", ["uploadId": id, "index": index, "data": data], wrapped: wrapped)
          guard let ack = response["upload"] as? [String: Any], ack["uploadId"] as? String == id, ack["receivedBytes"] as? Int == offset + length, ack["nextChunkIndex"] as? Int == index + 1 else { throw NativeGatewayFailure(code: "remote_upload_response_invalid") }
          offset += length; index += 1
          if adaptive { sizing.observe(bytes: length, elapsed: (ProcessInfo.processInfo.systemUptime - started) * 1000, processing: preparation) }
          self.progress(task, "uploading", offset, file.size)
        }
        try self.check(); self.progress(task, "completing", file.size, file.size)
        let response = try self.rpc("attachment.complete", ["uploadId": id], wrapped: wrapped)
        guard let result = response["upload"] as? [String: Any], result["uploadId"] as? String == id, result["state"] as? String == "completed", result["size"] as? Int == file.size, result["receivedBytes"] as? Int == file.size, result["sha256"] as? String == sha else { throw NativeGatewayFailure(code: "remote_upload_response_invalid") }
        self.session.trace("upload_done", bytes: file.size)

        try self.check(); completion(.success(try GatewayNativeCrypto.json(result)))
      } catch {
        self.lock.lock(); let mayAbort = !self.closed; self.lock.unlock()
        self.session.trace("upload_failed", code: (error as? NativeGatewayFailure)?.code, bytes: file.size)

        if mayAbort && !uploadId.isEmpty { self.abort(uploadId, wrapped: wrapped) }
        completion(.failure(error))
      }
    }
  }
  private func rpc(_ method: String, _ params: [String: Any], wrapped: Bool) throws -> [String: Any] {
    try check(); let id = prefix + UUID().uuidString
    let waiter = Waiter(); let submission = Waiter(); let permit = Permit()
    let began = ProcessInfo.processInfo.systemUptime
    var acknowledged = false
    session.trace("rpc_" + method.replacingOccurrences(of: "attachment.", with: ""), bytes: (params["data"] as? String)?.utf8.count ?? 0)
    defer { if !acknowledged { session.trace("ack_failed", elapsed: (ProcessInfo.processInfo.systemUptime - began) * 1000) } }
    lock.lock(); replies[id] = waiter; lock.unlock()
    defer { permit.invalidate(); lock.lock(); replies.removeValue(forKey: id); lock.unlock() }
    let payload: [String: Any] = ["kind": "request", "requestId": id, "method": wrapped ? "transfer.request" : method, "params": wrapped ? ["method": method, "params": params] : params]
    session.send(try GatewayNativeCrypto.json(payload), check: { try permit.check(); try self.check() }, submitted: { submission.finish(.success([:])) }, completion: { result in
      if case .failure(let error) = result { submission.finish(.failure(error)); waiter.finish(.failure(error)) }
    })
    // Poll the submission waiter in small windows so cancel/close also settles
    // an upload whose request has not reached the native socket yet.
    let deadline = ProcessInfo.processInfo.systemUptime + 65
    while true {
      try check()
      do { _ = try submission.wait(0.1); break } catch let error as NativeGatewayFailure { if error.code != "remote_request_timeout" { throw error } }
      guard ProcessInfo.processInfo.systemUptime < deadline else { throw NativeGatewayFailure(code: "remote_request_timeout") }
    }
    let response = try waiter.wait(90); try check()
    guard response["ok"] as? Bool == true else { let error = response["error"] as? [String: Any]; throw NativeGatewayFailure(code: error?["code"] as? String ?? "remote_request_failed") }
    guard let result = response["result"] as? [String: Any] else { throw NativeGatewayFailure(code: "remote_upload_response_invalid") }
    acknowledged = true
    session.trace("ack", elapsed: (ProcessInfo.processInfo.systemUptime - began) * 1000)
    return result
  }
  private func abort(_ uploadId: String, wrapped: Bool) {
    let params: [String: Any] = ["uploadId": uploadId]
    let value: [String: Any] = ["kind": "request", "requestId": prefix + UUID().uuidString, "method": wrapped ? "transfer.request" : "attachment.abort", "params": wrapped ? ["method": "attachment.abort", "params": params] : params]
    if let text = try? GatewayNativeCrypto.json(value) { session.send(text) { _ in } }
  }
  private func response(_ value: [String: Any]) -> Bool {
    guard value["kind"] as? String == "response", let id = value["requestId"] as? String, id.hasPrefix(prefix) else { return false }
    lock.lock(); let waiter = replies[id]; lock.unlock(); waiter?.finish(.success(value)); return true
  }
  func cancel(_ task: String) { lock.lock(); if task != activeTask { lock.unlock(); return }; cancelled = true; let pending = Array(replies.values); lock.unlock(); for waiter in pending { waiter.finish(.failure(NativeGatewayFailure(code: "remote_upload_cancelled"))) } }
  func close(code: String = "remote_client_closed") {
    lock.lock(); if closed { lock.unlock(); return }; closed = true; closeCode = code
    let pending = Array(replies.values); let snapshots = Array(files.values); files.removeAll(); retained = 0; let idle = activeTask.isEmpty; lock.unlock()
    for waiter in pending { waiter.finish(.failure(NativeGatewayFailure(code: code))) }
    for file in snapshots { try? FileManager.default.removeItem(at: file.url) }
    if idle { worker.addOperation { try? FileManager.default.removeItem(at: self.directory) } }
  }
  private final class Sizer {
    var size: Int; var ceiling: Int; let maximum: Int; var samples = 0; var stable = 0; var baseline = 0.0; var probing = false
    init(maximum: Int) { self.maximum = maximum; ceiling = maximum; size = min(512 * 1024, maximum) }
    func observe(bytes: Int, elapsed: Double, processing: Double) {
      guard bytes == size else { return }; let rate = Double(bytes) / max(1, elapsed)
      if elapsed > 1500 || processing > 160 || baseline > 0 && rate < baseline * 0.75 { ceiling = max(512 * 1024, size / 2); size = max(min(512 * 1024, maximum), size / 2); stable = 0; samples = 0; probing = false; baseline = rate; return }
      samples += 1; if baseline == 0 { baseline = rate }
      if probing { if rate < baseline * 1.08 { size /= 2; ceiling = size; stable = 0 } else { baseline = rate; stable = 1 }; probing = false; samples = stable; return }
      if rate >= baseline * 0.9 { stable += 1 } else { stable = 0 }; baseline = baseline * 0.75 + rate * 0.25
      if ceiling < maximum && stable >= 6 && samples >= 6 { ceiling = min(maximum, size * 2); stable = 0; samples = 0 }
      if stable >= 2 && samples >= 2 && size * 2 <= ceiling { size *= 2; probing = true; stable = 0; samples = 0 }
    }
  }
}
