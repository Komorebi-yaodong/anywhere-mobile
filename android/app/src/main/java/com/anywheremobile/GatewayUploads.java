package com.anywheremobile;

import java.io.*;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
import org.json.JSONObject;

/** Connection-owned immutable snapshots and sequential ACK uploads. No JS bytes. */
final class GatewayUploads implements AutoCloseable {
  static final long MAX_FILE = 25L * 1024 * 1024, MAX_TOTAL = 64L * 1024 * 1024;
  interface Progress {void report(String task, String stage, long bytes, long total);}
  private final GatewaySession session;
  private final File directory;
  private final File[] allowedRoots;
  private final Progress progress;

  interface Optimizer {Optimized optimize(File file,String name,String type) throws Exception;}
  static final class Optimized {final String name,type;Optimized(String name,String type){this.name=name;this.type=type;}}
  private final Optimizer optimizer;
  private final ExecutorService executor = new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(8),task -> {Thread t = new Thread(task, "gateway-picture-upload");t.setDaemon(true);return t;});
  private final Map<String, Snapshot> files = new HashMap<>();
  private final ConcurrentHashMap<String, CompletableFuture<JSONObject>> replies = new ConcurrentHashMap<>();
  private final String prefix = "native-upload-" + UUID.randomUUID() + "-";
  private volatile boolean closed, cancelled;
  private volatile String activeTask = "";
  private volatile String closeCode = "remote_client_closed";
  private long retained, activeBytes;
  private static final class Snapshot {
    final File file;final String name, type;final long size, created = System.nanoTime();
    Snapshot(File f, String n, String t, long s) {file=f;name=n;type=t;size=s;}
  }
  GatewayUploads(GatewaySession session, File directory, File[] allowedRoots, Progress progress) {
    this(session,directory,allowedRoots,progress,(file,name,type)->new Optimized(name,type));
  }
  GatewayUploads(GatewaySession session,File directory,File[] allowedRoots,Progress progress,Optimizer optimizer) {
    this.session=session;this.directory=directory;this.allowedRoots=allowedRoots;this.progress=progress;this.optimizer=optimizer;
    session.responseHandler(this::response);
  }
  private void check() {if (closed) throw new IllegalStateException(closeCode);if (cancelled || Thread.currentThread().isInterrupted()) throw new IllegalStateException("remote_upload_cancelled");}
  private synchronized void prune() {
    for (Iterator<Map.Entry<String,Snapshot>> it=files.entrySet().iterator();it.hasNext();) {
      Snapshot s=it.next().getValue();if (TimeUnit.NANOSECONDS.toMinutes(System.nanoTime()-s.created)>=10) {retained-=s.size;s.file.delete();it.remove();}
    }
  }
  void register(String path, String name, String type, Consumer<String> resolve, Consumer<String> reject) {
    synchronized(this) {prune();if(closed || files.size()>=8) {reject.accept("remote_upload_capacity");return;}}
    try {executor.execute(() -> {
      File copy=null;
      try {
        if(closed)throw new IllegalStateException(closeCode);
        if(name.isEmpty() || name.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>255 || name.equals(".") || name.equals("..") || name.matches(".*[\\\\/\\p{Cntrl}].*"))throw new IllegalArgumentException("remote_upload_name_invalid");
        if(!type.matches("image/[A-Za-z0-9!#$&^_.+-]{1,126}"))throw new IllegalArgumentException("remote_upload_type_invalid");
        File original=new File(path), source=original.getCanonicalFile();boolean allowed=false;
        for(File root:allowedRoots)if(root!=null && source.getPath().startsWith(root.getCanonicalPath()+File.separator)){allowed=true;break;}
        if(!allowed || !source.isFile() || Files.isSymbolicLink(original.toPath()))throw new IllegalArgumentException("remote_upload_source_invalid");
        if(!directory.isDirectory() && !directory.mkdirs())throw new IOException("snapshot directory");
        copy=File.createTempFile("image-", ".part", directory);
        long size=0;byte[] buffer=new byte[65536];
        try(InputStream in=new FileInputStream(source);OutputStream out=new FileOutputStream(copy)) {
          for(int n;(n=in.read(buffer))!=-1;) {if(closed)throw new IllegalStateException(closeCode);size+=n;if(size>MAX_FILE)throw new IllegalArgumentException("remote_upload_size_invalid");out.write(buffer,0,n);}
        }finally{Arrays.fill(buffer,(byte)0);}
        if(size<1)throw new IllegalArgumentException("remote_upload_size_invalid");
        Optimized optimized=optimizer.optimize(copy,name,type);size=copy.length();
        if(closed)throw new IllegalStateException(closeCode);

        String handle=UUID.randomUUID().toString();
        synchronized(this){if(closed || files.size()>=8 || retained+activeBytes+size>MAX_TOTAL)throw new IllegalStateException("remote_upload_capacity");files.put(handle,new Snapshot(copy,optimized.name,optimized.type,size));retained+=size;}
        copy=null;resolve.accept(handle);
      }catch(Exception error){reject.accept(code(error));}finally{if(copy!=null)copy.delete();}
    });}catch(RejectedExecutionException error){reject.accept(closeCode);}
  }
  void upload(String handle, String task, boolean wrapped, Consumer<JSONObject> resolve, Consumer<String> reject) {
    final Snapshot file;
    synchronized(this){prune();if(closed || !activeTask.isEmpty()){reject.accept(closed?closeCode:"remote_upload_busy");return;}file=files.remove(handle);if(file==null){reject.accept("remote_upload_source_invalid");return;}retained-=file.size;activeBytes=file.size;activeTask=task;cancelled=false;}
    try {executor.execute(() -> {
      String uploadId="";
      try {
        check();rpc("remote.image.binary.negotiate",new JSONObject(),false);
        progress.report(task,"hashing",0,file.size);

        MessageDigest hash=MessageDigest.getInstance("SHA-256");byte[] buffer=new byte[65536];long hashed=0;
        try(InputStream input=new FileInputStream(file.file)){for(int n;(n=input.read(buffer))!=-1;){check();hash.update(buffer,0,n);hashed+=n;}}finally{Arrays.fill(buffer,(byte)0);}
        if(hashed!=file.size)throw new IllegalStateException("remote_upload_source_changed");
        String sha=GatewayCrypto.base64(hash.digest());progress.report(task,"creating",0,file.size);
        JSONObject begin=rpc("attachment.begin",new JSONObject().put("name",file.name).put("type",file.type).put("size",file.size).put("sha256",sha),wrapped).getJSONObject("upload");
        uploadId=begin.getString("uploadId");
        if(!uploadId.matches("[A-Za-z0-9._:-]{16,160}") || begin.getLong("receivedBytes")!=0 || begin.getInt("nextChunkIndex")!=0)throw new IllegalStateException("remote_upload_response_invalid");
        int peer=begin.getInt("maxChunkBytes");boolean adaptive=begin.optBoolean("adaptive");
        if(peer<1 || peer>(adaptive?8*1024*1024:512*1024))throw new IllegalStateException("remote_upload_response_invalid");
        Sizer sizing=new Sizer(Math.min(peer,2*1024*1024));long offset=0;int index=0;
        try(RandomAccessFile input=new RandomAccessFile(file.file,"r")) {
          while(offset<file.size){check();int length=Math.min(sizing.size,(int)(file.size-offset));byte[] bytes=new byte[length];long start=System.nanoTime();
            input.readFully(bytes);
            long preparation=TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start);
            progress.report(task,index==0?"waiting_first_ack":"uploading",offset,file.size);
            JSONObject ack;
            try{ack=rpc("attachment.chunk",new JSONObject().put("uploadId",uploadId).put("index",index),wrapped,bytes).getJSONObject("upload");}finally{Arrays.fill(bytes,(byte)0);}
            if(!uploadId.equals(ack.getString("uploadId")) || ack.getLong("receivedBytes")!=offset+length || ack.getInt("nextChunkIndex")!=index+1)throw new IllegalStateException("remote_upload_response_invalid");
            offset+=length;index++;if(adaptive)sizing.observe(length,TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start),preparation);
            progress.report(task,"uploading",offset,file.size);
          }
        }
        check();progress.report(task,"completing",file.size,file.size);
        JSONObject result=rpc("attachment.complete",new JSONObject().put("uploadId",uploadId),wrapped).getJSONObject("upload");
        if(!uploadId.equals(result.getString("uploadId")) || !"completed".equals(result.getString("state")) || result.getLong("size")!=file.size || result.getLong("receivedBytes")!=file.size || !sha.equals(result.getString("sha256")))throw new IllegalStateException("remote_upload_response_invalid");

        check();resolve.accept(result);
      }catch(Exception error){
        if(!closed && !uploadId.isEmpty())sendAbort(uploadId,wrapped);

        reject.accept(code(error));
      }finally{file.file.delete();synchronized(this){activeTask="";activeBytes=0;cancelled=false;} }
    });}catch(RejectedExecutionException error){file.file.delete();synchronized(this){activeTask="";activeBytes=0;}reject.accept(closeCode);}
  }
  private JSONObject rpc(String method, JSONObject params, boolean wrapped) throws Exception {return rpc(method,params,wrapped,null);}
  private JSONObject rpc(String method, JSONObject params, boolean wrapped, byte[] bytes) throws Exception {

    check();String id=prefix+UUID.randomUUID();CompletableFuture<JSONObject> reply=new CompletableFuture<>();CompletableFuture<Void> submitted=new CompletableFuture<>();
    java.util.concurrent.atomic.AtomicBoolean valid = new java.util.concurrent.atomic.AtomicBoolean(true);
    replies.put(id,reply);

    reply.whenComplete((value,error)->{if(error!=null)submitted.completeExceptionally(error);});
    JSONObject request=new JSONObject().put("kind","request").put("requestId",id).put("method",wrapped?"transfer.request":method).put("params",wrapped?new JSONObject().put("method",method).put("params",params):params);
    Runnable permit=()->{if(!valid.get())throw new IllegalStateException("remote_upload_cancelled");check();};
    Consumer<String> failed=code->{submitted.completeExceptionally(new IllegalStateException(code));reply.completeExceptionally(new IllegalStateException(code));};
    if(bytes!=null)session.sendChunk(id,params.getString("uploadId"),params.getInt("index"),bytes,permit,()->submitted.complete(null),failed);
    else session.sendChecked(request.toString(),permit,()->submitted.complete(null),()->{},failed);
    try {
      // No ACK timer while waiting behind another native writer. Submission has
      // its own bounded wait; native submission starts the existing 90s ACK limit.
      submitted.get(65,TimeUnit.SECONDS);check();JSONObject response=reply.get(90,TimeUnit.SECONDS);check();
      if(!response.optBoolean("ok")){String failure=response.optJSONObject("error")==null?"remote_request_failed":response.getJSONObject("error").optString("code","remote_request_failed");throw new IllegalStateException(failure);}
      JSONObject result=response.getJSONObject("result");
      return result;
    } finally{valid.set(false);replies.remove(id);}
  }
  private void sendAbort(String uploadId, boolean wrapped) {
    try {JSONObject params=new JSONObject().put("uploadId",uploadId);session.send(new JSONObject().put("kind","request").put("requestId",prefix+UUID.randomUUID()).put("method",wrapped?"transfer.request":"attachment.abort").put("params",wrapped?new JSONObject().put("method","attachment.abort").put("params",params):params).toString(),()->{},code->{});}catch(Exception ignored){/* best effort only */}
  }
  private boolean response(JSONObject payload) {
    if(!"response".equals(payload.optString("kind")))return false;
    String id=payload.optString("requestId");if(!id.startsWith(prefix))return false;
    CompletableFuture<JSONObject> reply=replies.get(id);if(reply!=null)reply.complete(payload);return true;
  }
  synchronized void release(String handle) {Snapshot file=files.remove(handle);if(file!=null){retained-=file.size;file.file.delete();}}

  void cancel(String task) {if(task.equals(activeTask)){cancelled=true;for(CompletableFuture<JSONObject> value:replies.values())value.completeExceptionally(new IllegalStateException("remote_upload_cancelled"));}}
  void close(String code) {closeCode=code;close();}
  public synchronized void close() {if(closed)return;closed=true;for(CompletableFuture<JSONObject> value:replies.values())value.completeExceptionally(new IllegalStateException(closeCode));for(Snapshot file:files.values())file.file.delete();files.clear();retained=0;executor.shutdown();}
  private String code(Exception error) {
    Throwable cause=error;while(cause.getCause()!=null)cause=cause.getCause();
    if(closed)return closeCode;if(cancelled)return "remote_upload_cancelled";if(cause instanceof TimeoutException)return "remote_request_timeout";
    String code=cause.getMessage();return code!=null&&code.matches("remote_[a-z0-9_]+")?code:"remote_upload_failed";
  }
  /** End-to-end ACK timing, not socket queue drain, bounds image frame growth. */
  static final class Sizer {
    static final int INITIAL = 128 * 1024, MINIMUM = 64 * 1024;
    final int maximum, minimum;
    int size, stable;
    double rate;
    Sizer(int max) {maximum=max;minimum=Math.min(MINIMUM,max);size=Math.min(INITIAL,max);}
    void observe(int bytes,long elapsed,long processing) {
      if(bytes!=size)return; // A partial tail must not train the next full chunk.
      double sample=(double)bytes/Math.max(1,elapsed);
      rate=rate==0?sample:Math.min(sample,rate*.75+sample*.25);
      // Aim for <=6s ACKs with 25% headroom; no claim of a hard network deadline.
      double budget=rate*6000*.75;
      int safe=minimum;
      while(safe<=maximum/2 && safe*2<=budget)safe*=2;
      if(elapsed>8000 || size>safe) {size=Math.max(minimum,Math.min(safe,size/2));stable=0;return;}
      if(processing>160) {stable=0;return;}
      if(++stable>=2 && size<=maximum/2 && size*2<=safe) {size*=2;stable=0;}
    }
  }
}
