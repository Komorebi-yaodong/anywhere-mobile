package com.anywheremobile;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import okhttp3.WebSocket;

/** Opaque text only. A completed send means native queue drained, not peer ACK. */
final class GatewaySocketWriter {
  static final long DRAIN_TIMEOUT_MS = 65000;
  private static final int MAX_FRAME_BYTES = 16 * 1024 * 1024;
  private final WebSocket socket;
  private final long drainTimeoutMs;
  private final BooleanSupplier current;
  private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(task -> {
    Thread thread = new Thread(task, "gateway-socket-writer");
    thread.setDaemon(true);
    return thread;
  });
  private final ArrayDeque<Pending> queue = new ArrayDeque<>();
  private boolean closed;

  private static final class Pending {
    String text;
    final Runnable resolve;
    final Consumer<String> reject;
    long started;
    Pending(String text, Runnable resolve, Consumer<String> reject) {
      this.text = text; this.resolve = resolve; this.reject = reject;
    }
  }

  GatewaySocketWriter(WebSocket socket, BooleanSupplier current) {
    this(socket, current, DRAIN_TIMEOUT_MS);
  }

  GatewaySocketWriter(WebSocket socket, BooleanSupplier current, long drainTimeoutMs) {
    this.socket = socket; this.current = current; this.drainTimeoutMs = drainTimeoutMs;
  }

  synchronized void send(String text, Runnable resolve, Consumer<String> reject) {
    if (closed || !current.getAsBoolean()) {reject.accept("SOCKET_UNAVAILABLE"); return;}
    if (text.getBytes(StandardCharsets.UTF_8).length > MAX_FRAME_BYTES) {
      reject.accept("SOCKET_FRAME_TOO_LARGE"); return;
    }
    Pending pending = new Pending(text, resolve, reject);
    queue.add(pending);
    if (queue.size() == 1) executor.execute(() -> start(pending));
  }

  private synchronized void start(Pending pending) {
    if (closed || queue.peek() != pending || pending.started != 0) return;
    if (!current.getAsBoolean()) {close(); return;}
    pending.started = System.nanoTime();
    try {
      if (!socket.send(pending.text)) {close(); return;}
      pending.text = null;
      poll(pending);
    } catch (Exception error) {close();}
  }

  private synchronized void poll(Pending pending) {
    if (closed || queue.peek() != pending) return;
    if (!current.getAsBoolean()) {close(); return;}
    if (socket.queueSize() == 0) {
      queue.remove();
      pending.resolve.run();
      Pending next = queue.peek();
      if (next != null) executor.execute(() -> start(next));
    } else if (TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - pending.started) >= drainTimeoutMs) {
      socket.cancel();
      closeWith("SOCKET_WRITE_TIMEOUT");
    } else executor.schedule(() -> poll(pending), 10, TimeUnit.MILLISECONDS);
  }

  synchronized void close() {closeWith("SOCKET_UNAVAILABLE");}

  synchronized void close(String code) {closeWith(code);}

  private void closeWith(String code) {
    if (closed) return;
    closed = true;
    for (Pending pending : queue) {pending.text = null; pending.reject.accept(code);}
    queue.clear();
    executor.shutdownNow();
  }
}
