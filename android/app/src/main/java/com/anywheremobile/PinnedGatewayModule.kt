package com.anywheremobile

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Opaque HTTPS/WSS transport for Remote v2. The native layer never receives a
 * root secret or interprets pairing/RPC plaintext. LAN connections pin the
 * exact Desktop leaf certificate while retaining OkHttp hostname verification;
 * tunnel connections use the unmodified platform trust store and hostname
 * verifier. There is deliberately no Trust-All fallback.
 */
class PinnedGatewayModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  private data class SocketRecord(val socket: WebSocket, val client: OkHttpClient)

  private val sockets = ConcurrentHashMap<String, SocketRecord>()
  private val socketLock = Any()
  @Volatile private var invalidated = false

  override fun getName(): String = "PinnedGateway"

  @ReactMethod
  fun postJson(options: ReadableMap, promise: Promise) {
    try {
      val endpoint = requireEndpoint(options)
      val path = requirePath(options)
      val bodyText = requireRawString(options, "body")
      val client = transportClient(options, endpoint)
      val request = Request.Builder()
        .url(buildHttpsUrl(endpoint, path))
        .post(bodyText.toRequestBody(JSON_MEDIA_TYPE))
        .build()

      Thread {
        try {
          client.newCall(request).execute().use { response ->
            val responseText = readLimitedBody(response)
            val result = Arguments.createMap().apply {
              putInt("status", response.code)
              putString("body", responseText)
            }
            promise.resolve(result)
          }
        } catch (error: Exception) {
          promise.reject("HTTPS_REQUEST_FAILED", safeError(error), error)
        }
      }.start()
    } catch (error: Exception) {
      promise.reject("INVALID_TRANSPORT_OPTIONS", safeError(error), error)
    }
  }

  @ReactMethod
  fun connectSocket(options: ReadableMap, promise: Promise) {
    try {
      val connectionId = requireString(options, "connectionId")
      val endpoint = requireEndpoint(options)
      val path = requirePath(options)
      val client = transportClient(options, endpoint, webSocket = true)
      val request = Request.Builder().url(buildWebSocketUrl(endpoint, path)).build()

      synchronized(socketLock) {
        check(!invalidated) { "Transport module closed" }
        sockets.remove(connectionId)?.socket?.cancel()
        val socket = client.newWebSocket(request, gatewayListener(connectionId))
        sockets[connectionId] = SocketRecord(socket, client)
      }
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("SOCKET_CONNECT_FAILED", safeError(error), error)
    }
  }

  @ReactMethod
  fun sendText(connectionId: String, text: String, promise: Promise) {
    val record = sockets[connectionId]
    if (record != null && record.socket.send(text)) {
      promise.resolve(null)
    } else {
      promise.reject("SOCKET_UNAVAILABLE", "桌面连接不可用。")
    }
  }

  @ReactMethod
  fun disconnect(connectionId: String, promise: Promise) {
    synchronized(socketLock) {
      sockets.remove(connectionId)?.socket?.cancel()
    }
    promise.resolve(null)
  }

  // Required by React Native's NativeEventEmitter contract.
  @ReactMethod
  fun addListener(eventName: String) = Unit

  @ReactMethod
  fun removeListeners(count: Int) = Unit

  private fun transportClient(options: ReadableMap, endpoint: String, webSocket: Boolean = false): OkHttpClient {
    val builder = OkHttpClient.Builder()
      .followRedirects(false)
      .followSslRedirects(false)
      .connectTimeout(12, TimeUnit.SECONDS)
      .readTimeout(if (webSocket) 0 else 20, TimeUnit.SECONDS)

    if (webSocket) {
      // A WebSocket may be legitimately silent between E2EE RPCs. Do not turn
      // normal idle time into a disconnect; transport ping owns liveness.
      builder.pingInterval(15, TimeUnit.SECONDS)
    }

    return when (requireString(options, "tlsMode")) {
      "system" -> builder.build()
      "pinned" -> {
        val fingerprint = requireFingerprint(requireString(options, "certificateFingerprint"))
        val trustManager = pinnedTrustManager(fingerprint)
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, arrayOf<TrustManager>(trustManager), null)
        // OkHttp's default hostname verifier remains enabled.
        builder.sslSocketFactory(sslContext.socketFactory, trustManager).build()
      }
      else -> throw IllegalArgumentException("tlsMode 必须是 pinned 或 system。")
    }.also {
      // Parse once before any network operation so malformed endpoints fail locally.
      URI(endpoint).host ?: throw IllegalArgumentException("桌面端地址缺少主机名。")
    }
  }

  private fun pinnedTrustManager(expectedFingerprint: String): X509TrustManager =
    object : X509TrustManager {
      override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
        throw CertificateException("客户端证书不受支持。")
      }

      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("服务端未提供证书。")
        leaf.checkValidity()
        val actual = MessageDigest.getInstance("SHA-256")
          .digest(leaf.encoded)
          .joinToString("") { "%02X".format(it.toInt() and 0xFF) }
        if (!actual.equals(expectedFingerprint, ignoreCase = true)) {
          throw CertificateException("桌面证书指纹不匹配，已拒绝连接。")
        }
      }
    }

  private fun gatewayListener(connectionId: String) = object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      synchronized(socketLock) {
        if (sockets[connectionId]?.socket === webSocket) emit(connectionId, "connected")
      }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      synchronized(socketLock) {
        if (sockets[connectionId]?.socket !== webSocket) return
        if (text.toByteArray(Charsets.UTF_8).size > MAX_SOCKET_BYTES) {
          webSocket.cancel()
          emit(connectionId, "error", "桌面帧超过大小限制。")
        } else {
          emit(connectionId, "message", text)
        }
      }
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      webSocket.close(1003, "Text frames required")
      emit(connectionId, "error", "桌面发送了不受支持的二进制帧。")
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(code, null)
    }


    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      if (removeSocketIfCurrent(connectionId, webSocket)) {
        emit(connectionId, "disconnected", "连接已关闭。")
      }
    }

    override fun onFailure(webSocket: WebSocket, throwable: Throwable, response: Response?) {
      if (removeSocketIfCurrent(connectionId, webSocket)) {
        emit(connectionId, "error", safeError(throwable))
      }
    }
  }

  private fun removeSocketIfCurrent(connectionId: String, webSocket: WebSocket): Boolean =
    synchronized(socketLock) {
      val record = sockets[connectionId]
      record != null && record.socket === webSocket && sockets.remove(connectionId, record)
    }

  override fun invalidate() {
    synchronized(socketLock) {
      invalidated = true
      sockets.values.forEach { it.socket.cancel() }
      sockets.clear()
    }
    super.invalidate()
  }


  private fun emit(connectionId: String, type: String, message: String? = null) {
    if (invalidated) return
    val event = Arguments.createMap().apply {
      putString("connectionId", connectionId)
      putString("type", type)
      message?.let { putString("message", it) }
    }
    context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(EVENT_NAME, event)
  }

  private fun requireEndpoint(map: ReadableMap): String {
    val endpoint = requireString(map, "endpoint").trimEnd('/')
    val uri = URI(endpoint)
    if (
      !uri.scheme.equals("https", ignoreCase = true) ||
      uri.host.isNullOrBlank() ||
      uri.userInfo != null ||
      uri.query != null ||
      uri.fragment != null
    ) {
      throw IllegalArgumentException("桌面端地址必须是无凭据、查询或片段的 HTTPS 地址。")
    }
    return endpoint
  }

  private fun requirePath(map: ReadableMap): String {
    val path = requireString(map, "path")
    if (!path.startsWith('/') || path.startsWith("//") || path.contains("?") || path.contains("#") || path.split('/').any { it == ".." }) {
      throw IllegalArgumentException("请求路径无效。")
    }
    return path
  }

  private fun buildHttpsUrl(endpoint: String, path: String): String = "$endpoint$path"

  private fun buildWebSocketUrl(endpoint: String, path: String): String {
    val uri = URI(buildHttpsUrl(endpoint, path))
    return URI("wss", null, uri.host, uri.port, uri.rawPath, null, null).toString()
  }

  private fun readLimitedBody(response: Response): String {
    val body = response.body ?: return ""
    body.source().use { source ->
      source.request(MAX_RESPONSE_BYTES + 1L)
      if (source.buffer.size > MAX_RESPONSE_BYTES) {
        throw IllegalStateException("桌面响应超过大小限制。")
      }
      return source.readUtf8()
    }
  }

  private fun requireString(map: ReadableMap, key: String): String =
    map.getString(key)?.trim()?.takeIf { it.isNotEmpty() }
      ?: throw IllegalArgumentException("缺少字段：$key")

  private fun requireRawString(map: ReadableMap, key: String): String =
    map.getString(key) ?: throw IllegalArgumentException("缺少字段：$key")

  private fun requireFingerprint(input: String): String {
    val hexadecimal = input.replace(Regex("[^A-Fa-f0-9]"), "")
    if (!hexadecimal.matches(Regex("[A-Fa-f0-9]{64}"))) {
      throw IllegalArgumentException("证书指纹必须是 SHA-256 十六进制值。")
    }
    return hexadecimal.uppercase(Locale.ROOT)
  }

  private fun safeError(error: Throwable): String =
    error.message?.take(300) ?: "安全连接失败。"

  companion object {
    private const val EVENT_NAME = "AnywhereGatewayEvent"
    private const val MAX_RESPONSE_BYTES = 512L * 1024L
    private const val MAX_SOCKET_BYTES = 512 * 1024
    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
  }
}
