package com.anywheremobile;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.*;
import okhttp3.*;
import org.json.JSONObject;

/** Interactive driver of production native classes; only synthetic temp files. */
public final class GatewayImageProbe {
  private static synchronized void output(JSONObject value) {System.out.println(value.toString());System.out.flush();}
  private static void queuedCancellation() throws Exception {
    java.util.concurrent.atomic.AtomicInteger sends = new java.util.concurrent.atomic.AtomicInteger();
    java.util.concurrent.atomic.AtomicBoolean permit = new java.util.concurrent.atomic.AtomicBoolean(true);
    java.util.concurrent.atomic.AtomicLong queued = new java.util.concurrent.atomic.AtomicLong(1);
    WebSocket fake = new WebSocket() {
      public Request request(){return new Request.Builder().url("https://fixture.invalid").build();}
      public long queueSize(){return queued.get();}
      public boolean send(String text){sends.incrementAndGet();return true;}
      public boolean send(okio.ByteString text){throw new AssertionError("text only");}
      public boolean close(int code,String reason){return true;}public void cancel(){}
    };
    GatewaySocketWriter writer = new GatewaySocketWriter(fake, () -> true);
    CountDownLatch rejected = new CountDownLatch(1);
    try {
      writer.send("first", () -> {}, code -> {});
      for(int i=0;i<100&&sends.get()==0;i++)Thread.sleep(5);
      writer.sendPrepared(() -> {if(!permit.get())throw new IllegalStateException("remote_upload_cancelled");return "must-not-send";},128,()->{throw new AssertionError("cancelled submission");},code->{if(!"remote_upload_cancelled".equals(code))throw new AssertionError(code);rejected.countDown();});
      permit.set(false);queued.set(0);
      if(!rejected.await(2,TimeUnit.SECONDS)||sends.get()!=1)throw new AssertionError("cancelled queued request sent");
    }finally{writer.close();}
  }

  public static void main(String[] args) throws Exception {
    queuedCancellation();

    // Trust exactly the generated fixture certificate; retain hostname checking.
    CertificateFactory certificates = CertificateFactory.getInstance("X.509");
    KeyStore trust = KeyStore.getInstance(KeyStore.getDefaultType());trust.load(null,null);
    try(InputStream cert = new FileInputStream(args[1])){trust.setCertificateEntry("fixture",certificates.generateCertificate(cert));}
    TrustManagerFactory managers=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());managers.init(trust);
    X509TrustManager manager=(X509TrustManager)managers.getTrustManagers()[0];
    SSLContext tls=SSLContext.getInstance("TLS");tls.init(null,new TrustManager[]{manager},null);
    OkHttpClient client=new OkHttpClient.Builder().sslSocketFactory(tls.getSocketFactory(),manager).pingInterval(1,TimeUnit.SECONDS).readTimeout(0,TimeUnit.SECONDS).writeTimeout(60,TimeUnit.SECONDS).build();
    CountDownLatch opened=new CountDownLatch(1);
    AtomicReference<GatewaySession> sessions=new AtomicReference<>();
    AtomicReference<GatewayUploads> uploads=new AtomicReference<>();
    AtomicReference<WebSocket> sockets=new AtomicReference<>();
    AtomicReference<GatewaySocketWriter> writers=new AtomicReference<>();
    WebSocket socket=client.newWebSocket(new Request.Builder().url(args[0]).build(),new WebSocketListener(){
      public void onOpen(WebSocket ws,Response response){
        sockets.set(ws);
        GatewaySocketWriter writer=new GatewaySocketWriter(ws,()->sockets.get()==ws);writers.set(writer);
        GatewaySession session=new GatewaySession(writer,text->{try{output(new JSONObject().put("event","payload").put("value",new JSONObject(text)));}catch(Exception e){throw new RuntimeException(e);}},code->{try{output(new JSONObject().put("event","failure").put("code",code));}catch(Exception e){throw new RuntimeException(e);}});sessions.set(session);
        GatewayUploads transfer=new GatewayUploads(session,new File(args[2],"snapshots"),new File[]{new File(args[2])},(task,stage,bytes,total)->{try{output(new JSONObject().put("event","progress").put("task",task).put("stage",stage).put("bytes",bytes).put("total",total));}catch(Exception e){throw new RuntimeException(e);}});uploads.set(transfer);opened.countDown();
      }
      public void onMessage(WebSocket ws,String text){GatewaySession session=sessions.get();if(session!=null)session.receive(text);}
      public void onFailure(WebSocket ws,Throwable error,Response response){try{output(new JSONObject().put("event","socket-failure").put("code",error.getClass().getSimpleName()));}catch(Exception ignored){}opened.countDown();}
    });
    try {
      if(!opened.await(10,TimeUnit.SECONDS)||sessions.get()==null)throw new IllegalStateException("fixture socket failed");
      output(new JSONObject().put("event","ready"));
      try(BufferedReader input=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8))){
        for(String line;(line=input.readLine())!=null;){
          JSONObject command=new JSONObject(line);String op=command.getString("op"),id=command.getString("id");
          java.util.function.Consumer<String> ok=value->{try{output(new JSONObject().put("id",id).put("ok",true).put("value",value));}catch(Exception e){throw new RuntimeException(e);}};
          java.util.function.Consumer<String> fail=code->{try{output(new JSONObject().put("id",id).put("ok",false).put("code",code));}catch(Exception e){throw new RuntimeException(e);}};
          switch(op){
            case "install":sessions.get().install(command.getString("session"),command.getString("send"),command.getString("receive"),()->ok.accept(""),fail);break;
            case "adaptive":sessions.get().adaptive();ok.accept("");break;
            case "register":uploads.get().register(command.getString("path"),command.optString("name","synthetic.jpg"),"image/jpeg",ok,fail);break;
            case "upload":uploads.get().upload(command.getString("handle"),command.getString("task"),true,value->ok.accept(value.toString()),fail);break;
            case "cancel":uploads.get().cancel(command.getString("task"));ok.accept("");break;
            case "ping":sessions.get().send(new JSONObject().put("kind","request").put("requestId",id).put("method","remote.ping").put("params",new JSONObject()).toString(),()->ok.accept(""),fail);break;
            case "close":uploads.get().close("remote_client_closed");sessions.get().close();writers.get().close();socket.cancel();ok.accept("");break;
            default:fail.accept("unknown");
          }
        }
      }
    }finally{if(uploads.get()!=null)uploads.get().close();if(sessions.get()!=null)sessions.get().close();if(writers.get()!=null)writers.get().close();sockets.set(null);socket.cancel();client.dispatcher().executorService().shutdownNow();client.connectionPool().evictAll();}
  }
}
