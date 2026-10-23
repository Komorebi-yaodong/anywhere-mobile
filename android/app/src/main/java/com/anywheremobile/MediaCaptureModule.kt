package com.anywheremobile

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import com.facebook.react.bridge.*
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

/** App-private, bounded PCM WAV capture. Never accepts an arbitrary path. */
class MediaCaptureModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private var recorder: AudioRecord? = null
  private var output: File? = null
  private var worker: Thread? = null
  @Volatile private var running = false
  @Volatile private var failed = false
  private val lock = Any()
  override fun getName() = "MediaCapture"

  @ReactMethod fun startAudio(promise: Promise) = synchronized(lock) {
    if (recorder != null) {promise.reject("MEDIA_BUSY", "录音正在进行。");return@synchronized}
    try {
      val size = maxOf(AudioRecord.getMinBufferSize(16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT),4096)
      val next = AudioRecord(MediaRecorder.AudioSource.MIC,16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT,size)
      recorder = next
      if(next.state != AudioRecord.STATE_INITIALIZED) throw IllegalStateException()
      val file=File(context.cacheDir,"remote-audio-${UUID.randomUUID()}.wav")
      output=file; failed=false
      RandomAccessFile(file,"rw").use {it.write(ByteArray(44))}
      next.startRecording();running=true
      worker=Thread {
        try {
          RandomAccessFile(file,"rw").use {sink ->
            sink.seek(44);val bytes=ByteArray(size);var count=0L
            while(running && count<16000L*2*120) {
              val read=next.read(bytes,0,minOf(bytes.size,(16000L*2*120-count).toInt()))
              if(read<0){if(running)throw IllegalStateException() else break}
              if(read>0){sink.write(bytes,0,read);count+=read}
            }
            bytes.fill(0)
          }
        }catch(_:Exception){failed=true}finally{running=false;try{next.stop()}catch(_:Exception){}}
      }.also{it.start()}
      promise.resolve(null)
    } catch(_:Exception){cleanup(true);promise.reject("MEDIA_RECORD_START_FAILED","无法开始录音。")}
  }
  @ReactMethod fun stopAudio(promise: Promise) = synchronized(lock) {
    val file=output
    if(recorder==null||file==null){promise.reject("MEDIA_NOT_RECORDING","没有录音。");return@synchronized}
    try {
      running=false
      try{recorder?.stop()}catch(_:Exception){}
      worker?.join(2000)
      if(worker?.isAlive==true||failed)throw IllegalStateException()
      recorder?.release();recorder=null;worker=null;output=null
      val data=(file.length()-44).toInt()
      if(data<2)throw IllegalStateException()
      val header=ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      header.put("RIFF".toByteArray()).putInt(data+36).put("WAVEfmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(16000).putInt(32000).putShort(2).putShort(16).put("data".toByteArray()).putInt(data)
      RandomAccessFile(file,"rw").use{it.seek(0);it.write(header.array())}
      promise.resolve(Arguments.createMap().apply{putString("captureId",file.name);putString("name","语音消息.wav");putString("type","audio/wav");putDouble("size",file.length().toDouble());putDouble("durationMs",data/32.0)})
    }catch(_:Exception){cleanup(true);file.delete();promise.reject("MEDIA_RECORD_STOP_FAILED","录音处理失败。")}
  }
  @ReactMethod fun cancelAudio(promise: Promise) = synchronized(lock){cleanup(true);promise.resolve(null)}
  @ReactMethod fun readCaptureChunk(id:String,offset:Double,length:Double,promise:Promise){
    try{val file=resolve(id);if(!offset.isFinite()||!length.isFinite()||offset%1.0!=0.0||length%1.0!=0.0||offset<0||length<1||length>524288||offset+length>file.length())throw IllegalArgumentException()
      val bytes=ByteArray(length.toInt());RandomAccessFile(file,"r").use{it.seek(offset.toLong());it.readFully(bytes)}
      promise.resolve(android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP));bytes.fill(0)
    }catch(_:Exception){promise.reject("MEDIA_READ_FAILED","录音读取失败。")}
  }
  @ReactMethod fun deleteCapture(id:String,promise:Promise){try{resolve(id).delete();promise.resolve(null)}catch(_:Exception){promise.reject("MEDIA_DELETE_FAILED","录音清理失败。")}}
  private fun resolve(id:String):File{if(!id.matches(Regex("remote-audio-[0-9a-fA-F-]{36}\\.wav")))throw IllegalArgumentException();val file=File(context.cacheDir,id);if(file.canonicalFile.parentFile!=context.cacheDir.canonicalFile||!file.isFile)throw IllegalArgumentException();return file}
  private fun cleanup(delete:Boolean){running=false;try{recorder?.stop()}catch(_:Exception){};try{worker?.join(2000)}catch(_:Exception){};try{recorder?.release()}catch(_:Exception){};recorder=null;worker=null;if(delete)output?.delete();output=null}
  override fun invalidate(){synchronized(lock){cleanup(true)};super.invalidate()}
}
