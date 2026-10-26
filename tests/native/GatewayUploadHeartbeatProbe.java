package com.anywheremobile;

import okhttp3.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Locale;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Sustained rate-limited uplink, real OkHttp ping + production native writer.
 * 256 KiB raw uploads have ~466.5 KB E2EE text frames. The peer treats these as
 * opaque text: AEAD/actual attachment correctness is covered by SDK/WSS tests.
 * No Android device, application data, public endpoint or trusted TLS bypass.
 */
public final class GatewayUploadHeartbeatProbe {
  private static final int FRAME_BYTES = 466512;
  private static final int FRAMES = 8;
  private static final int RATE_BYTES = 64 * 1024;
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
  private static void reply(OutputStream out, byte[] bytes, int opcode) throws IOException {
    out.write(0x80 | opcode);out.write(bytes.length);out.write(bytes);out.flush();
  }
  public static void main(String[] args) throws Exception {
    final boolean largeControl = args.length > 0 && args[0].equals("--large-control");
    final int frameBytes = largeControl ? 14913506 : FRAME_BYTES;
    final int frameCount = largeControl ? 1 : FRAMES;
    ServerSocket listener = new ServerSocket();listener.setReceiveBufferSize(32768);
    listener.bind(new InetSocketAddress("127.0.0.1", 0));
    AtomicInteger received = new AtomicInteger(), pings = new AtomicInteger(), peak = new AtomicInteger();
    AtomicReference<Throwable> peerError = new AtomicReference<>();
    Thread peer = new Thread(() -> {
      try (Socket socket = listener.accept()) {
        socket.setSoTimeout(90000);
        InputStream in = socket.getInputStream();OutputStream out = socket.getOutputStream();
        ByteArrayOutputStream head = new ByteArrayOutputStream();String headers = "";int b;
        while ((b = in.read()) >= 0) {head.write(b);headers = head.toString("ISO-8859-1");if (headers.endsWith("\r\n\r\n")) break;}
        String key = "";
        for (String line : headers.split("\r\n")) if (line.toLowerCase(Locale.ROOT).startsWith("sec-websocket-key:")) key = line.substring(line.indexOf(':') + 1).trim();
        String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));out.flush();
        while (received.get() < frameCount) {
          int first = in.read(), second = in.read();if (first < 0 || second < 0) throw new EOFException();
          long length = second & 127;
          if (length == 126) length = ((long) in.read() << 8) | in.read();
          else if (length == 127) {length = 0;for (int i = 0; i < 8; i++) length = (length << 8) | in.read();}
          check((second & 128) != 0, "client frames must be masked");
          byte[] mask = in.readNBytes(4);byte[] buffer = new byte[8192];
          ByteArrayOutputStream control = new ByteArrayOutputStream();long offset = 0;
          long frameStart = System.nanoTime();
          while (offset < length) {
            int n = in.read(buffer, 0, (int) Math.min(buffer.length, length - offset));if (n < 0) throw new EOFException();
            if ((first & 15) == 9) {
              for (int i = 0; i < n; i++) control.write(buffer[i] ^ mask[(int) ((offset + i) % 4)]);
            }
            offset += n;
            if ((first & 15) == 1) {
              long target = frameStart + offset * 1000000000L / RATE_BYTES;
              long remaining = target - System.nanoTime();
              if (remaining > 0) TimeUnit.NANOSECONDS.sleep(remaining);
            }
          }
          if ((first & 15) == 1) {
            check(length == frameBytes, "256 KiB upload envelope stays bounded");
            received.incrementAndGet();reply(out, new byte[]{1}, 1);
          } else if ((first & 15) == 9) {pings.incrementAndGet();reply(out, control.toByteArray(), 10);}
          else throw new AssertionError("unexpected opcode");
        }
        Thread.sleep(300);
      } catch (Throwable error) {peerError.set(error);}
    }, "rate-limited-upload-peer");
    peer.setDaemon(true);peer.start();
    AtomicReference<GatewaySocketWriter> writer = new AtomicReference<>();
    AtomicReference<String> failure = new AtomicReference<>();
    AtomicInteger submitted = new AtomicInteger(), acknowledged = new AtomicInteger();
    CountDownLatch done = new CountDownLatch(1);
    OkHttpClient client = new OkHttpClient.Builder().connectTimeout(12, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.SECONDS).writeTimeout(60, TimeUnit.SECONDS).pingInterval(15, TimeUnit.SECONDS).build();
    long started = System.nanoTime();
    WebSocket socket = client.newWebSocket(new Request.Builder().url("ws://127.0.0.1:" + listener.getLocalPort() + "/").build(), new WebSocketListener() {
      private void sendNext() {
        if (submitted.get() >= frameCount) return;
        int inFlight = submitted.incrementAndGet() - acknowledged.get();peak.accumulateAndGet(inFlight, Math::max);
        writer.get().send("x".repeat(frameBytes), () -> {}, code -> {failure.compareAndSet(null, code);done.countDown();});
      }
      public void onOpen(WebSocket ws, Response response) {
        writer.set(new GatewaySocketWriter(ws, () -> true));
        // Three application receipts in flight, native drain remains serialized.
        sendNext();sendNext();sendNext();
      }
      public void onMessage(WebSocket ws, String text) {
        if (acknowledged.incrementAndGet() == frameCount) done.countDown();else sendNext();
      }
      public void onFailure(WebSocket ws, Throwable error, Response response) {
        if (done.getCount() > 0) {failure.compareAndSet(null, error.toString());done.countDown();}
      }
    });
    try {
      check(done.await(80, TimeUnit.SECONDS), "sustained upload deadline");
      long elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
      if (largeControl) {
        check(failure.get() != null && (failure.get().contains("sent ping") || failure.get().equals("SOCKET_WRITE_TIMEOUT")), "large-frame control must not silently complete on this rate: " + failure.get());
        check(acknowledged.get() == 0 && pings.get() == 0, "ping remains behind unfinished data frame");
        System.out.println("{\"suite\":\"large-frame-slow-uplink-control\",\"ok\":true,\"frameBytes\":" + frameBytes + ",\"rateBytesPerSecond\":" + RATE_BYTES + ",\"elapsedMs\":" + elapsed + ",\"failure\":\"" + failure.get() + "\",\"pingsAnswered\":" + pings.get() + "}");
        return;
      }

      check(failure.get() == null, "native failure: " + failure.get());
      check(peerError.get() == null, "peer failure: " + peerError.get());
      check(acknowledged.get() == FRAMES && received.get() == FRAMES, "all chunks acknowledged");
      check(peak.get() == 3, "three, not one or unlimited, application receipts in flight");
      check(elapsed > 45000 && pings.get() >= 2, "must exercise multiple actual heartbeat cycles");
      System.out.println("{\"suite\":\"sustained-upload-heartbeat\",\"ok\":true,\"frameBytes\":" + FRAME_BYTES + ",\"rateBytesPerSecond\":" + RATE_BYTES + ",\"frames\":" + FRAMES + ",\"peakInFlight\":" + peak.get() + ",\"pingsAnswered\":" + pings.get() + ",\"elapsedMs\":" + elapsed + "}");
    } finally {
      if (writer.get() != null) writer.get().close();socket.cancel();listener.close();
      client.dispatcher().executorService().shutdownNow();client.connectionPool().evictAll();peer.join(1000);
    }
  }
}
