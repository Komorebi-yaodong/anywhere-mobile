package com.anywheremobile;

import java.util.ArrayDeque;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.function.Predicate;
import org.json.JSONObject;

/** All receive/install work shares one lane, independent of OkHttp's pong reader. */
final class GatewaySession implements AutoCloseable {
  // Process lifetime only. Rows cannot contain caller-supplied paths or payloads.
  private static final ArrayDeque<JSONObject> TRACE = new ArrayDeque<>();
  private static final long TRACE_START = System.nanoTime();
  private static final java.util.concurrent.atomic.AtomicLong GENERATIONS = new java.util.concurrent.atomic.AtomicLong();
  private final long generation = GENERATIONS.incrementAndGet();
  static synchronized String diagnostics() {return new org.json.JSONArray(TRACE).toString();}
  void trace(String event, String code, long bytes, long elapsedMs) {
    if (!event.matches("connection|closed|failure|queued|submitted|drained|rejected|upload_start|upload_done|upload_failed|rpc_begin|rpc_chunk|rpc_complete|rpc_abort|ack|ack_failed")) return;
    try {
      JSONObject row = new JSONObject().put("atMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-TRACE_START)).put("generation",generation).put("event",event);
      if (code != null) row.put("code", code.matches("remote_(pong_timeout|write_timeout|request_timeout|client_closed|upload_cancelled|upload_response_invalid|upload_failed|send_capacity|transport_error)|SOCKET_(WRITE_TIMEOUT|PONG_TIMEOUT|UNAVAILABLE)") ? code : "other");
      row.put("bytes",Math.max(0,bytes)).put("elapsedMs",Math.max(0,elapsedMs));
      synchronized(GatewaySession.class) {TRACE.add(row);while(TRACE.size()>256)TRACE.remove();}
    } catch (org.json.JSONException ignored) { /* diagnostics never affect transport */ }
  }

  private final GatewaySocketWriter writer;
  private final Consumer<String> plaintext, failure;
  private final ThreadPoolExecutor receiver = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(32), task -> {Thread thread = new Thread(task, "gateway-crypto-reader");thread.setDaemon(true);return thread;});
  private final ArrayDeque<String> beforeKeys = new ArrayDeque<>();
  private final AtomicInteger queuedBytes = new AtomicInteger();
  private final AtomicBoolean closed = new AtomicBoolean();
  private volatile GatewayCrypto crypto;
  private volatile Predicate<JSONObject> responses = payload -> false;
  GatewaySession(GatewaySocketWriter writer, Consumer<String> plaintext, Consumer<String> failure) {this.writer = writer; this.plaintext = plaintext; this.failure = failure;writer.observe(this::trace);trace("connection",null,0,0);}
  void responseHandler(Predicate<JSONObject> handler) {responses = handler;}
  boolean active() {return !closed.get() && crypto != null;}
  void install(String id, String send, String receive, Runnable success, Consumer<String> reject) {
    final byte[] a, b;
    try {a = GatewayCrypto.decode(send, 32, 32);}
    catch (Exception error) {reject.accept("remote_session_key_invalid");fail("remote_session_key_invalid");return;}
    try {b = GatewayCrypto.decode(receive, 32, 32);}
    catch (Exception error) {java.util.Arrays.fill(a, (byte)0);reject.accept("remote_session_key_invalid");fail("remote_session_key_invalid");return;}
    try {receiver.execute(() -> {
      try {
        if (closed.get() || crypto != null) throw new IllegalStateException("remote_session_state_invalid");
        synchronized (GatewaySession.this) {
          if (closed.get()) throw new IllegalStateException("remote_session_closed");
          crypto = new GatewayCrypto(id, a, b);
        }
        while (!beforeKeys.isEmpty() && !closed.get()) decrypt(beforeKeys.remove());
        if (closed.get()) reject.accept("remote_client_closed");else success.run();
      } catch (Exception error) {reject.accept("remote_session_state_invalid");fail("remote_session_state_invalid");}
      finally {java.util.Arrays.fill(a, (byte)0);java.util.Arrays.fill(b, (byte)0);}
    });} catch (java.util.concurrent.RejectedExecutionException error) {java.util.Arrays.fill(a, (byte)0);java.util.Arrays.fill(b, (byte)0);reject.accept("remote_receive_capacity");fail("remote_receive_capacity");}
  }
  void adaptive() {GatewayCrypto current = crypto;if (current == null || closed.get()) throw new IllegalStateException("remote_session_state_invalid");current.enableAdaptive();}
  void receive(String text) {
    if (closed.get()) return;
    int size = text.length();
    if (size > GatewayCrypto.MAX_FRAME || queuedBytes.addAndGet(size) > 32 * 1024 * 1024) {fail("remote_receive_capacity");return;}
    try {receiver.execute(() -> {
      if (closed.get()) return;
      if (crypto != null) {decrypt(text);return;}
      try {
        JSONObject frame = new JSONObject(text);
        if ("remote.encrypted".equals(frame.optString("type"))) {
          if (beforeKeys.size() >= 8) {fail("remote_receive_capacity");return;}
          beforeKeys.add(text);return;
        }
        if (!"remote.session.accept".equals(frame.optString("type")) || text.length() > 65536) {fail("remote_session_accept_invalid");return;}
        queuedBytes.addAndGet(-size);plaintext.accept(text);
      } catch (Exception error) {fail("remote_frame_invalid");}
    });} catch (java.util.concurrent.RejectedExecutionException error) {fail("remote_receive_capacity");}
  }
  private void decrypt(String text) {
    try {
      String value = crypto.decrypt(text);
      queuedBytes.addAndGet(-text.length());
      if (!closed.get() && !responses.test(new JSONObject(value))) plaintext.accept(value);
    } catch (Exception error) {
      String code = error instanceof javax.crypto.AEADBadTagException ? "remote_frame_auth_failed" : error.getMessage();
      fail(code != null && code.matches("remote_[a-z0-9_]+") ? code : "remote_frame_invalid");
    }
  }
  void send(String payload, Runnable success, Consumer<String> reject) {
    sendChecked(payload, () -> {}, () -> {}, success, reject);
  }
  void sendChecked(String payload, Runnable check, Runnable submitted, Runnable success, Consumer<String> reject) {
    GatewayCrypto current = crypto;
    if (closed.get() || current == null) {reject.accept("remote_client_closed");return;}
    writer.sendPrepared(() -> {
      if (closed.get()) throw new IllegalStateException("remote_client_closed");
      check.run();
      return current.encrypt(payload);
    }, payload.length() * 2, submitted, success, code -> {
      reject.accept(code);
      if (code.startsWith("SOCKET_")) {
        // Writer callbacks hold the writer monitor. Never acquire the socket
        // lifecycle lock from this callback; close notifications run elsewhere.
        java.util.concurrent.ForkJoinPool.commonPool().execute(() -> fail(
          "SOCKET_WRITE_TIMEOUT".equals(code) ? "remote_write_timeout" :
          "SOCKET_PONG_TIMEOUT".equals(code) ? "remote_pong_timeout" : "remote_transport_error"));
      }
    });
  }
  void sendChunk(String id,String uploadId,int index,byte[] bytes,Runnable check,Runnable submitted,Consumer<String> reject) {
    GatewayCrypto current=crypto;
    if(closed.get()||current==null){reject.accept("remote_client_closed");return;}
    final byte[] owned=bytes.clone();
    writer.sendBinary(()->{try{if(closed.get())throw new IllegalStateException("remote_client_closed");check.run();return current.encryptBinary(id,uploadId,index,owned);}finally{java.util.Arrays.fill(owned,(byte)0);}},bytes.length*2+2048,submitted,()->{},code->{java.util.Arrays.fill(owned,(byte)0);reject.accept(code);if(code.startsWith("SOCKET_"))java.util.concurrent.ForkJoinPool.commonPool().execute(()->fail("remote_transport_error"));});
  }

  private void fail(String code) {if (closed.get()) return;trace("failure",code,writer.queuedSize(),0);close();failure.accept(code);}
  public void close() {
    GatewayCrypto current;
    synchronized (this) {if (!closed.compareAndSet(false, true)) return;current = crypto;}
    if (current != null) current.close();

    trace("closed",null,writer.queuedSize(),0);
    // Drain callbacks (not ciphertext) so queued key imports settle and zeroize.
    try {receiver.execute(() -> {beforeKeys.clear();queuedBytes.set(0);});} catch (java.util.concurrent.RejectedExecutionException ignored) { /* closing */ }
    receiver.shutdown();
  }
}
