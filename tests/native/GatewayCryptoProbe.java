package com.anywheremobile;
import java.io.*;
import org.json.JSONObject;
public final class GatewayCryptoProbe {
 public static void main(String[] args) throws Exception {
  GatewayCrypto session = null;
  try(BufferedReader input = new BufferedReader(new InputStreamReader(System.in, java.nio.charset.StandardCharsets.UTF_8))) {
   for(String line;(line=input.readLine())!=null;) {
    JSONObject command = new JSONObject(line);
    try {
     Object value;
     switch(command.getString("op")) {
      case "install": if(session!=null)session.close();session=new GatewayCrypto(command.getString("id"),GatewayCrypto.decode(command.getString("send"),32,32),GatewayCrypto.decode(command.getString("receive"),32,32));value=true;break;
      case "adaptive":session.enableAdaptive();value=true;break;
      case "encrypt":value=new JSONObject(session.encrypt(command.getJSONObject("payload").toString()));break;
      case "binary":value=session.encryptBinary("request-native-binary",command.getString("uploadId"),command.optInt("index"),GatewayCrypto.decode(command.getString("data"),1,2*1024*1024)).base64();break;

case "decrypt":value=new JSONObject(session.decrypt(command.getJSONObject("frame").toString()));break;
      case "close":session.close();value=true;break;
      default:throw new Exception("unknown");
     }
     System.out.println(new JSONObject().put("ok",true).put("value",value));
    }catch(Exception e){System.out.println(new JSONObject().put("ok",false).put("code",e instanceof javax.crypto.AEADBadTagException?"remote_frame_auth_failed":String.valueOf(e.getMessage())));}
   }
  } finally {if(session!=null)session.close();}
 }
}
