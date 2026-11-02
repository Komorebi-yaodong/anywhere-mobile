/* Actual production Java/OkHttp -> validated TLS/WSS -> Desktop crypto/uploads.
 * Only generated certificates, keys and synthetic files in private temp dirs. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const fsp=fs.promises;
const {spawn,spawnSync}=require('node:child_process');
const {pathToFileURL}=require('node:url'),{createRequire}=require('node:module');
const assert=require('node:assert/strict'),crypto=require('node:crypto'),https=require('node:https'),readline=require('node:readline');
const root=path.resolve(__dirname,'..'),desktopRoot=path.resolve(root,'../Anywhere_desktop'),dr=createRequire(path.join(desktopRoot,'package.json'));
const out=path.join(root,'build/internal-test/native-image-probe');
function jar(group,name,version){const dir=path.join(os.homedir(),'.gradle/caches/modules-2/files-2.1',group,name,version);for(const hash of fs.readdirSync(dir)){const p=path.join(dir,hash,`${name}-${version}.jar`);if(fs.existsSync(p))return p;}throw Error('Missing '+name);}
const jars=[jar('com.squareup.okhttp3','okhttp','4.12.0'),jar('com.squareup.okio','okio-jvm','3.6.0'),jar('org.jetbrains.kotlin','kotlin-stdlib','1.9.20'),jar('org.json','json','20180813')];
const java=name=>path.join(process.env.JAVA_HOME||'E:/Program/Java/Java17','bin',name+'.exe');
fs.mkdirSync(out,{recursive:true});
const sources=['GatewayCrypto','GatewaySession','GatewaySocketWriter','GatewayUploads'].map(x=>path.join(root,'android/app/src/main/java/com/anywheremobile',x+'.java'));
const compile=spawnSync(java('javac'),['-cp',jars.join(path.delimiter),'-d',out,...sources,path.join(root,'tests/native/GatewayImageProbe.java')],{cwd:root,stdio:'inherit',timeout:15000});if(compile.status!==0)throw Error('Java compile failed');
(async()=>{
 const {createRemoteCryptoSession}=await import(pathToFileURL(path.join(desktopRoot,'main/core/remote/cryptoSession.js')));
 const {createRemoteUploadManager}=await import(pathToFileURL(path.join(desktopRoot,'main/core/remote/uploadManager.js')));
 const {WebSocketServer}=dr('ws'),selfsigned=dr('selfsigned');
 const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'anywhere-native-image-'));
 const certificate=await selfsigned.generate([{name:'commonName',value:'localhost'}],{algorithm:'sha256',keySize:2048,extensions:[{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:true},{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]});
 const certPath=path.join(temp,'fixture.pem');await fsp.writeFile(certPath,certificate.cert);
 const selected=path.join(temp,'selected');await fsp.mkdir(selected);
 const file=path.join(selected,'synthetic.jpg');
 const manager=createRemoteUploadManager({tempRoot:path.join(temp,'desktop-uploads')});await manager.initialize();
 const send=crypto.randomBytes(32),receive=crypto.randomBytes(32),sessionId='session-native-image-loopback-0001',deviceId='device-native-image-loopback-0001';
 const server=https.createServer({key:certificate.private,cert:certificate.cert});
 const wss=new WebSocketServer({server,maxPayload:16*1024*1024,perMessageDeflate:false});
 let child,peer,session,mode='normal',chunkCount=0,firstChunk,releaseAck,networkFailure;
 let pongCount=0;const events=[],pending=new Map();let next=0;
 function waitFor(predicate,ms=15000){const existing=events.find(predicate);if(existing)return Promise.resolve(existing);return new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{const found=events.find(predicate);if(found){clearInterval(timer);resolve(found);}else if(Date.now()-started>ms){clearInterval(timer);reject(Error('probe event timeout'));}},10);});}
 wss.on('connection',socket=>{peer=socket;session=createRemoteCryptoSession({sessionId,sendKey:Buffer.from(receive),receiveKey:Buffer.from(send),sendDirection:'desktop-to-client',receiveDirection:'client-to-desktop'});session.enableAdaptiveTransfers();socket.on('ping',()=>pongCount++);
 socket.on('message',raw=>{
  let request;try{request=session.decrypt(JSON.parse(raw));}catch(error){networkFailure=error;socket.close();return;}
  (async()=>{
   let method=request.method,params=request.params;
   if(method==='transfer.request'){method=params.method;params=params.params;}
   let result;
   if(method==='remote.ping')result={ok:true,echo:'native-mixed-ping'};
   else if(method==='attachment.begin')result=await manager.begin({deviceId,requestId:request.requestId,params,adaptive:true});
   else if(method==='attachment.chunk'){
    chunkCount++;result=await manager.chunk({deviceId,params,adaptive:true});
    if(params.index===0 && mode!=='normal'){
     firstChunk?.();
     if(mode==='hold')await new Promise(resolve=>{releaseAck=resolve;});
     else if(mode==='bad')result={...result,upload:{...result.upload,receivedBytes:result.upload.receivedBytes+1}};
    }
   }else if(method==='attachment.complete')result=await manager.complete({deviceId,params});
   else if(method==='attachment.abort')result=await manager.abort({deviceId,params});
   else throw Error('Unexpected method '+method);
   if(socket.readyState===1)socket.send(JSON.stringify(session.encrypt({kind:'response',requestId:request.requestId,ok:true,result})));
  })().catch(error=>{if(socket.readyState===1)socket.send(JSON.stringify(session.encrypt({kind:'response',requestId:request.requestId,ok:false,error:{code:error.code||'remote_fixture_error'}})));});
 });});
 try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 child=spawn(java('java'),['-Dfile.encoding=UTF-8','-cp',[out,...jars].join(path.delimiter),'com.anywheremobile.GatewayImageProbe',`wss://127.0.0.1:${server.address().port}/api/v2/socket`,certPath,selected],{cwd:root,stdio:['pipe','pipe','inherit']});
 const processExit=new Promise(resolve=>child.once('exit',resolve));
 readline.createInterface({input:child.stdout}).on('line',line=>{try{const value=JSON.parse(line);events.push(value);if(value.id&&pending.has(value.id)){pending.get(value.id).resolve(value);pending.delete(value.id);}}catch(error){networkFailure=error;}});
 function rpc(op,params={}){const id='probe-command-'+(++next);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Java command timeout '+op));},25000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);}});child.stdin.write(JSON.stringify({id,op,...params})+'\n');});}
 await waitFor(x=>x.event==='ready');assert.equal((await rpc('install',{session:sessionId,send:send.toString('base64url'),receive:receive.toString('base64url')})).ok,true);await rpc('adaptive');
 async function register(size){await fsp.writeFile(file,Buffer.alloc(size,0x6c));const result=await rpc('register',{path:file});assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
 for(const size of [820*1024,5*1024*1024+17]){
  mode='normal';chunkCount=0;const handle=await register(size);const task='native-image-task-'+size;
  // Mutating the originally selected file cannot alter the immutable snapshot.
  await fsp.writeFile(file,'source changed after registration');
  const result=await rpc('upload',{handle,task});assert.equal(result.ok,true,JSON.stringify(result));const uploaded=JSON.parse(result.value);assert.equal(uploaded.size,size);assert.equal(uploaded.sha256,crypto.createHash('sha256').update(Buffer.alloc(size,0x6c)).digest('base64url'));assert.ok(chunkCount>=2);
 }
 mode='hold';chunkCount=0;let entered=new Promise(resolve=>{firstChunk=resolve;});let handle=await register(820*1024);const held=rpc('upload',{handle,task:'native-image-held-task'});await entered;
 const ping=await rpc('ping');assert.equal(ping.ok,true);await waitFor(x=>x.event==='payload'&&x.value.requestId===ping.id);
 await new Promise(resolve=>setTimeout(resolve,1200));assert.equal(chunkCount,1,'no next chunk before ACK');assert.ok(pongCount>=1,'OkHttp transport ping continues while awaiting ACK');releaseAck();assert.equal((await held).ok,true);
 mode='hold';chunkCount=0;entered=new Promise(resolve=>{firstChunk=resolve;});handle=await register(820*1024);const cancelled=rpc('upload',{handle,task:'native-image-cancel-task'});await entered;await rpc('cancel',{task:'native-image-cancel-task'});assert.equal((await cancelled).code,'remote_upload_cancelled');releaseAck();await new Promise(resolve=>setTimeout(resolve,200));assert.equal(chunkCount,1,'cancel never emits next chunk');
 mode='bad';chunkCount=0;handle=await register(820*1024);const bad=await rpc('upload',{handle,task:'native-image-badack-task'});assert.equal(bad.code,'remote_upload_response_invalid');assert.equal(chunkCount,1);
 const invalid=await rpc('register',{path:certPath});assert.equal(invalid.code,'remote_upload_source_invalid');
 mode='hold';chunkCount=0;entered=new Promise(resolve=>{firstChunk=resolve;});handle=await register(820*1024);
 const disconnected=rpc('upload',{handle,task:'native-image-disconnect-task'});await entered;
 await rpc('close');assert.equal((await disconnected).code,'remote_client_closed');releaseAck();
 child.stdin.end();await processExit;assert.equal(networkFailure,undefined);const snapshots=await fsp.readdir(path.join(selected,'snapshots'));assert.equal(snapshots.length,0);
 console.log(JSON.stringify({ok:true,suite:'production-java-image-tls-wss',coverage:'820KiB/5MiB/immutable snapshot/SHA/first ACK gate/mixed ping/native pong/cancel/bad ACK/private path/no replay/cleanup',pongCount}));
 }finally{
  releaseAck?.();child?.stdin.end();if(child&&child.exitCode===null)child.kill();peer?.terminate();for(const socket of wss.clients)socket.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));session?.close();await manager.stop();send.fill(0);receive.fill(0);await fsp.rm(temp,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
