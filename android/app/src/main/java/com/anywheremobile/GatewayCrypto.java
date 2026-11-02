package com.anywheremobile;

import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import okio.ByteString;
import org.json.JSONObject;

/** One owner per socket. No root secret, storage, network or business authority. */
final class GatewayCrypto implements AutoCloseable {
  static final int MAX_FRAME = 16 * 1024 * 1024;
  private final String sessionId;
  private byte[] sendKey, receiveKey;
  private long sendSequence = 1, receiveSequence = 1, nonceCounter = 1;
  private int maximum = 1024 * 1024;
  private final byte[] noncePrefix = new byte[4];
  GatewayCrypto(String id, byte[] send, byte[] receive) {
    if (!id.matches("[A-Za-z0-9._:-]{16,128}") || send.length != 32 || receive.length != 32) throw new IllegalArgumentException("remote_session_key_invalid");
    sessionId = id; sendKey = send.clone(); receiveKey = receive.clone();
    new SecureRandom().nextBytes(noncePrefix);
  }
  static String base64(byte[] value) {return ByteString.of(value).base64Url().replace("=", "");}
  static byte[] decode(String value, int min, int max) {
    if (value == null || value.length() > ((long) max * 4 + 2) / 3 || !value.matches("[A-Za-z0-9_-]+")) throw new IllegalArgumentException("remote_invalid_base64url");
    ByteString decoded = ByteString.decodeBase64(value);
    if (decoded == null || decoded.size() < min || decoded.size() > max || !base64(decoded.toByteArray()).equals(value)) throw new IllegalArgumentException("remote_invalid_base64url");
    return decoded.toByteArray();
  }
  synchronized void enableAdaptive() {check(); maximum = MAX_FRAME;}
  private void check() {if (sendKey == null) throw new IllegalStateException("remote_session_closed");}
  private byte[] aad(long sequence, String direction) {
    return ("{\"direction\":" + JSONObject.quote(direction) + ",\"sequence\":" + sequence + ",\"sessionId\":" + JSONObject.quote(sessionId) + ",\"type\":\"remote.encrypted\",\"v\":2}").getBytes(StandardCharsets.UTF_8);
  }
  synchronized String encrypt(String payload) throws Exception {
    check();
    if (sendSequence > 9007199254740991L) throw new IllegalStateException("remote_sequence_invalid");
    new JSONObject(payload);
    byte[] plaintext = payload.getBytes(StandardCharsets.UTF_8);
    if (nonceCounter == Long.MAX_VALUE) throw new IllegalStateException("remote_sequence_invalid");
    byte[] nonce = ByteBuffer.allocate(12).put(noncePrefix).putLong(nonceCounter++).array();
    byte[] encrypted = null;
    try {
      if (plaintext.length < 1 || plaintext.length > maximum) throw new IllegalArgumentException("remote_payload_size_invalid");
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(sendKey, "AES"), new GCMParameterSpec(128, nonce));
      cipher.updateAAD(aad(sendSequence, "client-to-desktop"));
      encrypted = cipher.doFinal(plaintext);
      JSONObject frame = new JSONObject().put("v", 2).put("type", "remote.encrypted").put("sessionId", sessionId).put("sequence", sendSequence)
        .put("nonce", base64(nonce)).put("ciphertext", base64(Arrays.copyOf(encrypted, encrypted.length - 16))).put("tag", base64(Arrays.copyOfRange(encrypted, encrypted.length - 16, encrypted.length)));
      String text = frame.toString();
      if (text.getBytes(StandardCharsets.UTF_8).length > maximum) throw new IllegalArgumentException("remote_payload_size_invalid");
      sendSequence++;
      return text;
    } finally {Arrays.fill(plaintext, (byte)0); if (encrypted != null) Arrays.fill(encrypted, (byte)0);}
  }
  synchronized ByteString encryptBinary(String requestId, String uploadId, int index, byte[] bytes) throws Exception {
    check();
    if (!requestId.matches("[A-Za-z0-9._:-]{8,160}") || !uploadId.matches("[A-Za-z0-9._:-]{16,160}") || index<0 || bytes.length<1 || bytes.length>2*1024*1024) throw new IllegalArgumentException("remote_binary_frame_invalid");
    if(sendSequence>9007199254740991L || nonceCounter==Long.MAX_VALUE)throw new IllegalStateException("remote_sequence_invalid");
    byte[] meta=new JSONObject().put("requestId",requestId).put("uploadId",uploadId).put("index",index).toString().getBytes(StandardCharsets.UTF_8);
    byte[] plain=ByteBuffer.allocate(4+meta.length+bytes.length).putInt(meta.length).put(meta).put(bytes).array();
    byte[] nonce=ByteBuffer.allocate(12).put(noncePrefix).putLong(nonceCounter++).array();
    byte[] encrypted=null;
    try {
      String aadText="{\"direction\":\"client-to-desktop\",\"sequence\":"+sendSequence+",\"sessionId\":"+JSONObject.quote(sessionId)+",\"type\":\"remote.binary\",\"v\":2}";
      Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(sendKey,"AES"),new GCMParameterSpec(128,nonce));cipher.updateAAD(aadText.getBytes(StandardCharsets.UTF_8));encrypted=cipher.doFinal(plain);
      byte[] frame=ByteBuffer.allocate(24+encrypted.length).put(new byte[]{65,87,66,49}).putLong(sendSequence).put(nonce).put(encrypted).array();
      if(frame.length>maximum)throw new IllegalArgumentException("remote_payload_size_invalid");
      sendSequence++;return ByteString.of(frame);
    }finally{Arrays.fill(plain,(byte)0);if(encrypted!=null)Arrays.fill(encrypted,(byte)0);}
  }


  synchronized String decrypt(String text) throws Exception {
    check();
    if (text.getBytes(StandardCharsets.UTF_8).length > maximum) throw new IllegalArgumentException("remote_payload_size_invalid");
    JSONObject frame = new JSONObject(text);
    if (!"remote.encrypted".equals(frame.optString("type")) || frame.optInt("v") != 2) throw new IllegalArgumentException("remote_frame_invalid");
    if (!sessionId.equals(frame.optString("sessionId"))) throw new IllegalArgumentException("remote_session_mismatch");
    Object rawSequence = frame.get("sequence");
    if (!(rawSequence instanceof Number) || ((Number)rawSequence).doubleValue() != Math.rint(((Number)rawSequence).doubleValue()) || ((Number)rawSequence).doubleValue() < 1 || ((Number)rawSequence).doubleValue() > 9007199254740991L) throw new IllegalArgumentException("remote_sequence_invalid");
    if (((Number)rawSequence).longValue() != receiveSequence) throw new IllegalArgumentException(((Number)rawSequence).longValue() < receiveSequence ? "remote_frame_replayed" : "remote_frame_out_of_order");
    byte[] nonce = decode(frame.getString("nonce"), 12, 12), body = decode(frame.getString("ciphertext"), 1, maximum), tag = decode(frame.getString("tag"), 16, 16);
    byte[] combined = new byte[body.length + 16], plain = null;
    try {
      System.arraycopy(body, 0, combined, 0, body.length); System.arraycopy(tag, 0, combined, body.length, 16);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(receiveKey, "AES"), new GCMParameterSpec(128, nonce));
      cipher.updateAAD(aad(receiveSequence, "desktop-to-client"));
      plain = cipher.doFinal(combined);
      String value = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(plain)).toString();
      new JSONObject(value);
      receiveSequence++;
      return value;
    } finally {Arrays.fill(body, (byte)0); Arrays.fill(combined, (byte)0); if (plain != null) Arrays.fill(plain, (byte)0);}
  }
  public synchronized void close() {if (sendKey != null) {Arrays.fill(sendKey, (byte)0); Arrays.fill(receiveKey, (byte)0); sendKey = null; receiveKey = null;}}
}
