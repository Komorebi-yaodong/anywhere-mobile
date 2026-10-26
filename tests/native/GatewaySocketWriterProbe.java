package com.anywheremobile;

import okhttp3.*;
import okio.ByteString;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Real OkHttp 4.12 + production writer, synthetic loopback, no Android device. */
public final class GatewaySocketWriterProbe {
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
  private static void frame(OutputStream out, byte[] bytes, int opcode) throws IOException {
    synchronized (out) {out.write(0x80 | opcode); out.write(bytes.length); out.write(bytes); out.flush();}
  }
  private static Thread peer(ServerSocket server, int expected, long pauseMs, AtomicInteger received) {
    Thread thread = new Thread(() -> {
      try (Socket socket = server.accept()) {
        socket.setSoTimeout(25000);
        InputStream in = socket.getInputStream(); OutputStream out = socket.getOutputStream();
        ByteArrayOutputStream header = new ByteArrayOutputStream(); String headers = ""; int b;
        while ((b = in.read()) >= 0) {header.write(b); headers = header.toString("ISO-8859-1"); if (headers.endsWith("\r\n\r\n")) break;}
        String key = "";
        for (String line : headers.split("\r\n")) if (line.toLowerCase(Locale.ROOT).startsWith("sec-websocket-key:")) key = line.substring(line.indexOf(':') + 1).trim();
        String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.flush();
        Thread.sleep(pauseMs);
        while (received.get() < expected) {
          int first = in.read(), second = in.read(); if (first < 0 || second < 0) break;
          long length = second & 127;
          if (length == 126) length = ((long) in.read() << 8) | in.read();
          else if (length == 127) {length = 0; for (int i = 0; i < 8; i++) length = (length << 8) | in.read();}
          byte[] mask = (second & 128) != 0 ? in.readNBytes(4) : new byte[0];
          ByteArrayOutputStream ping = new ByteArrayOutputStream(); byte[] buffer = new byte[65536]; long offset = 0;
          while (offset < length) {
            int n = in.read(buffer, 0, (int) Math.min(buffer.length, length - offset)); if (n < 0) throw new EOFException();
            if ((first & 15) == 9) for (int i = 0; i < n; i++) ping.write(buffer[i] ^ mask[(int) ((offset + i) % 4)]);
            offset += n;
          }
          if ((first & 15) == 1) {received.incrementAndGet(); frame(out, new byte[]{1}, 1);}
          else if ((first & 15) == 9) frame(out, ping.toByteArray(), 10);
        }
        Thread.sleep(300);
      } catch (Exception ignored) { /* Negative control deliberately loses transport. */ }
    }, "synthetic-slow-peer");
    thread.setDaemon(true); thread.start(); return thread;
  }
  private static void loopback(boolean fixed, int frameBytes, int count) throws Exception {
    ServerSocket server = new ServerSocket(); server.setReceiveBufferSize(32768); server.bind(new InetSocketAddress("127.0.0.1", 0));
    AtomicInteger received = new AtomicInteger(), resolved = new AtomicInteger();
    CountDownLatch opened = new CountDownLatch(1), done = new CountDownLatch(1);
    AtomicReference<String> failure = new AtomicReference<>(); AtomicReference<GatewaySocketWriter> writer = new AtomicReference<>();
    Thread peer = peer(server, count, 12500, received);
    OkHttpClient.Builder builder = new OkHttpClient.Builder().connectTimeout(12, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).pingInterval(15, TimeUnit.SECONDS);
    if (fixed) builder.writeTimeout(60, TimeUnit.SECONDS);
    OkHttpClient client = builder.build(); long begin = System.nanoTime();
    WebSocket socket = client.newWebSocket(new Request.Builder().url("ws://127.0.0.1:" + server.getLocalPort() + "/").build(), new WebSocketListener() {
      int acks;
      public void onOpen(WebSocket ws, Response response) {
        GatewaySocketWriter sender = new GatewaySocketWriter(ws, () -> true); writer.set(sender);
        for (int i = 0; i < count; i++) {
          String text = "x".repeat(frameBytes);
          if (fixed) sender.send(text, resolved::incrementAndGet, code -> {failure.compareAndSet(null, code);done.countDown();});
          else if (!ws.send(text)) {failure.compareAndSet(null, "send_refused");done.countDown();}
        }
        opened.countDown();
      }
      public void onMessage(WebSocket ws, String text) {if (++acks == count) done.countDown();}
      public void onFailure(WebSocket ws, Throwable error, Response response) {if (done.getCount() > 0) {failure.compareAndSet(null, error.getClass().getSimpleName());done.countDown();}}
    });
    try {
      check(opened.await(3, TimeUnit.SECONDS), "must connect");
      if (fixed && frameBytes > 900000) {Thread.sleep(300);check(resolved.get() == 0, "send promise must wait for actual native drain");}
      check(done.await(24, TimeUnit.SECONDS), "probe deadline");
      long elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - begin);
      if (fixed || frameBytes < 200000) {check(failure.get() == null, "expected ACK, got " + failure.get());check(received.get() == count, "all frames received");}
      else check(failure.get() != null && elapsed < 12500, "default 10s writer must fail before peer resumes");
      System.out.println("{\"probe\":\"native-upload\",\"fixed\":" + fixed + ",\"frameBytes\":" + frameBytes + ",\"frames\":" + count + ",\"elapsedMs\":" + elapsed + ",\"received\":" + received.get() + ",\"failure\":\"" + failure.get() + "\"}");
    } finally {
      if (writer.get() != null) writer.get().close(); socket.cancel(); server.close();
      client.dispatcher().executorService().shutdownNow();client.connectionPool().evictAll();peer.join(1000);
    }
  }
  private static class FakeSocket implements WebSocket {
    final AtomicInteger sends = new AtomicInteger(); volatile long queued = 1; volatile boolean cancelled;
    public Request request() {return new Request.Builder().url("https://fixture.invalid").build();}
    public long queueSize() {return queued;}
    public boolean send(String text) {sends.incrementAndGet();return true;}
    public boolean send(ByteString bytes) {throw new AssertionError("text only");}
    public boolean close(int code, String reason) {return true;}
    public void cancel() {cancelled = true;}
  }
  private static void lifecycle() throws Exception {
    FakeSocket socket = new FakeSocket(); AtomicBoolean current = new AtomicBoolean(true);
    GatewaySocketWriter writer = new GatewaySocketWriter(socket, current::get);
    CountDownLatch cancelled = new CountDownLatch(2);AtomicInteger resolves = new AtomicInteger();
    writer.send("first", resolves::incrementAndGet, code -> cancelled.countDown());
    writer.send("second", resolves::incrementAndGet, code -> cancelled.countDown());
    Thread.sleep(100);check(socket.sends.get() == 1 && resolves.get() == 0, "second must not reach native queue early");
    current.set(false);check(cancelled.await(1, TimeUnit.SECONDS), "replacement rejects every pending promise");
    check(socket.sends.get() == 1, "old second frame never sent after replacement");writer.close();
    FakeSocket closed = new FakeSocket();GatewaySocketWriter cancelledWriter = new GatewaySocketWriter(closed, () -> true);
    CountDownLatch settled = new CountDownLatch(1);cancelledWriter.send("pending", () -> {throw new AssertionError();}, code -> settled.countDown());
    cancelledWriter.close();check(settled.await(1, TimeUnit.SECONDS), "disconnect rejects pending immediately");
    FakeSocket drained = new FakeSocket();drained.queued = 0;GatewaySocketWriter live = new GatewaySocketWriter(drained, () -> true);
    CountDownLatch finished = new CountDownLatch(2);live.send("a", finished::countDown, code -> {throw new AssertionError(code);});live.send("b", finished::countDown, code -> {throw new AssertionError(code);});
    check(finished.await(1, TimeUnit.SECONDS) && drained.sends.get() == 2, "ordered sends continue after drain");live.close();
    FakeSocket stuck = new FakeSocket();GatewaySocketWriter deadline = new GatewaySocketWriter(stuck, () -> true, 30);
    CountDownLatch expired = new CountDownLatch(1);AtomicReference<String> reason = new AtomicReference<>();
    deadline.send("stuck", () -> {throw new AssertionError();}, code -> {reason.set(code);expired.countDown();});
    check(expired.await(1, TimeUnit.SECONDS) && stuck.cancelled && "SOCKET_WRITE_TIMEOUT".equals(reason.get()), "bounded native drain deadline cancels once");

    System.out.println("{\"probe\":\"native-writer-lifecycle\",\"ok\":true}");
  }
  public static void main(String[] args) throws Exception {
    lifecycle();loopback(false, 114206, 1);loopback(false, 932495, 3);loopback(true, 932495, 3);loopback(true, 14913506, 1);
    System.out.println("{\"suite\":\"native-upload-backpressure\",\"ok\":true}");
  }
}
