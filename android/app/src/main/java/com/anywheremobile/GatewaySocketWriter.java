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

  private int queuedBytes;

  interface Observer {void record(String event, String code, long bytes, long elapsedMs);}
  private Observer observer = (event, code, bytes, elapsed) -> {};
  synchronized void observe(Observer value) {observer = value;}
  synchronized long queuedSize() {return Math.max(queuedBytes, socket.queueSize());}


  private static final class Pending {

    java.util.concurrent.Callable<String> prepare;
    String text;

    okio.ByteString binary;
    java.util.concurrent.Callable<okio.ByteString> prepareBinary;
    final Runnable resolve;
    final Consumer<String> reject;
    long started;

    int weight;

    Runnable submitted = () -> {};

    long enqueued = System.nanoTime();
    int frameBytes;
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

    if (queue.size() >= 32) {reject.accept("remote_send_capacity");return;}
    if (closed || !current.getAsBoolean()) {reject.accept("SOCKET_UNAVAILABLE"); return;}
    if (text.getBytes(StandardCharsets.UTF_8).length > MAX_FRAME_BYTES) {
      reject.accept("SOCKET_FRAME_TOO_LARGE"); return;
    }
    int weight = text.length() * 2;
    if (queuedBytes + weight > 32 * 1024 * 1024) {reject.accept("remote_send_capacity");return;}
    Pending pending = new Pending(text, resolve, reject);pending.weight = weight;queuedBytes += weight;
    queue.add(pending);
    observer.record("queued",null,queuedBytes,0);
    if (queue.size() == 1) executor.execute(() -> start(pending));
  }

  synchronized void sendPrepared(java.util.concurrent.Callable<String> prepare, int weight, Runnable resolve, Consumer<String> reject) {
    sendPrepared(prepare, weight, () -> {}, resolve, reject);
  }
  synchronized void sendPrepared(java.util.concurrent.Callable<String> prepare, int weight, Runnable submitted, Runnable resolve, Consumer<String> reject) {
    if (closed || !current.getAsBoolean()) {reject.accept("SOCKET_UNAVAILABLE");return;}
    if (queue.size() >= 32) {reject.accept("remote_send_capacity");return;}
    if (weight < 1 || queuedBytes + weight > 32 * 1024 * 1024) {reject.accept("remote_send_capacity");return;}
    Pending pending = new Pending(null, resolve, reject);pending.prepare = prepare;pending.submitted = submitted;pending.weight = weight;queuedBytes += weight;queue.add(pending);
    observer.record("queued",null,queuedBytes,0);
    if (queue.size() == 1) executor.execute(() -> start(pending));
  }


  synchronized void sendBinary(java.util.concurrent.Callable<okio.ByteString> prepare, int weight, Runnable submitted, Runnable success, Consumer<String> reject) {
    if(closed || !current.getAsBoolean()){reject.accept("SOCKET_UNAVAILABLE");return;}
    if(queue.size()>=32 || weight<1 || queuedBytes+weight>32*1024*1024){reject.accept("remote_send_capacity");return;}
    Pending item=new Pending(null,success,reject);item.prepareBinary=prepare;item.weight=weight;item.submitted=submitted;queue.add(item);queuedBytes+=weight;
    observer.record("queued",null,queuedBytes,0);if(queue.size()==1)executor.execute(()->start(item));
  }


  private synchronized void start(Pending pending) {
    if (closed || queue.peek() != pending || pending.started != 0) return;
    if (!current.getAsBoolean()) {close(); return;}
    if (pending.prepare != null || pending.prepareBinary != null) {
      try {if(pending.prepareBinary!=null){pending.binary=pending.prepareBinary.call();pending.prepareBinary=null;}else{pending.text = pending.prepare.call();pending.prepare = null;}}
      catch (Exception error) {
        pending.prepare = null;pending.prepareBinary=null;pending.binary=null;queue.remove();queuedBytes -= pending.weight;pending.reject.accept(error.getMessage() != null && error.getMessage().startsWith("remote_") ? error.getMessage() : "remote_encrypt_failed");
        Pending next = queue.peek();if (next != null) executor.execute(() -> start(next));return;
      }
    }

    pending.started = System.nanoTime();

    pending.frameBytes = pending.binary!=null?pending.binary.size():pending.text.getBytes(StandardCharsets.UTF_8).length;
    try {
      if (!(pending.binary!=null?socket.send(pending.binary):socket.send(pending.text))) {close(); return;}

      pending.submitted.run();

      observer.record("submitted",null,pending.frameBytes,TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-pending.enqueued));
      pending.text = null;pending.binary=null;pending.prepareBinary=null;
      poll(pending);
    } catch (Exception error) {close();}
  }

  private synchronized void poll(Pending pending) {
    if (closed || queue.peek() != pending) return;
    if (!current.getAsBoolean()) {close(); return;}
    if (socket.queueSize() == 0) {
      queue.remove();queuedBytes -= pending.weight;
      observer.record("drained",null,pending.frameBytes,TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-pending.started));

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

    observer.record("failure",code,queuedSize(),queue.peek()==null?0:TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-queue.peek().enqueued));
    for (Pending pending : queue) {pending.text = null;pending.binary=null;pending.prepareBinary=null; pending.prepare = null; pending.reject.accept(code);}
    queue.clear();queuedBytes = 0;
    executor.shutdownNow();
  }
}
