/* Actual production Java/OkHttp -> validated TLS/WSS -> Desktop crypto/uploads.
 * Only generated certificates, keys and synthetic files in private temp dirs. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const fsp=fs.promises;
const {spawn,spawnSync}=require('node:child_process');
const {pathToFileURL}=require('node:url'),{createRequire}=require('node:module');
const assert=require('node:assert/strict'),crypto=require('node:crypto'),https=require('node:https'),readline=require('node:readline');
const http=require('node:http'),tls=require('node:tls'),net=require('node:net');
const slowProxy=process.argv.includes('--slow-proxy'),legacyControl=process.argv.includes('--legacy-control');
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

 const {createBusinessProtocol}=await import(pathToFileURL(path.join(desktopRoot,'main/core/remote/businessProtocol.js')));
 const {WebSocketServer}=dr('ws'),selfsigned=dr('selfsigned');
 const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'anywhere-native-image-'));
 const certificate=await selfsigned.generate([{name:'commonName',value:'localhost'}],{algorithm:'sha256',keySize:2048,extensions:[{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:true},{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]});
 const certPath=path.join(temp,'fixture.pem');await fsp.writeFile(certPath,certificate.cert);
 const selected=path.join(temp,'selected');await fsp.mkdir(selected);
 const file=path.join(selected,'synthetic.jpg');
 const manager=createRemoteUploadManager({tempRoot:path.join(temp,'desktop-uploads')});await manager.initialize();
 const send=crypto.randomBytes(32),receive=crypto.randomBytes(32),sessionId='session-native-image-loopback-0001',deviceId='device-native-image-loopback-0001';
 const server=slowProxy?http.createServer():https.createServer({key:certificate.private,cert:certificate.cert});
 let proxy;const proxySockets=new Set();
 const chunkSizes=[],chunkElapsed=[];let previousChunkAt=0;let wireBytes=0;
 const proxyRate=24*1024;
 function createSlowProxy(port){
  return tls.createServer({key:certificate.private,cert:certificate.cert},front=>{
   const back=net.connect(port,'127.0.0.1');proxySockets.add(front);proxySockets.add(back);
   let queue=[],queued=0,timer,ended=false;
   const cleanup=()=>{if(ended)return;ended=true;clearTimeout(timer);queue=[];queued=0;front.destroy();back.destroy();proxySockets.delete(front);proxySockets.delete(back);};
   front.on('error',cleanup);back.on('error',cleanup);front.on('close',cleanup);back.on('close',cleanup);
   back.pipe(front);
   function pump(){
    if(ended||!queue.length){timer=undefined;return;}
    const head=queue[0],part=head.subarray(0,Math.min(4096,head.length));
    if(part.length===head.length)queue.shift();else queue[0]=head.subarray(part.length);queued-=part.length;
    timer=setTimeout(()=>{if(ended)return;wireBytes+=part.length;back.write(part);pump();},Math.ceil(part.length/proxyRate*1000));
   }
   // Deliberately accept into a bounded proxy buffer before slow forwarding:
   // unlike rate-limiting the Java socket, native queue drain is not delivery.
   front.on('data',data=>{if(queued+data.length>4*1024*1024){cleanup();return;}queue.push(data);queued+=data.length;if(!timer)pump();});
  });
 }
 const wss=new WebSocketServer({server,maxPayload:16*1024*1024,perMessageDeflate:false});
 const business=createBusinessProtocol({readService:{},getManager:()=>({runtimeSnapshot:()=>({})}),dispatch:(_context,id,method,params)=>dispatchUpload(method,params,id)});
 const context={device:{deviceId},capabilities:['attachment.begin','attachment.chunk','attachment.complete','attachment.abort']};
 business.negotiate(context,{versions:[{major:1,minor:1}]});
 let child,peer,session,mode='normal',chunkCount=0,firstChunk,releaseAck,networkFailure;
 let pongCount=0;const events=[],pending=new Map();let next=0;
 function waitFor(predicate,ms=15000){const existing=events.find(predicate);if(existing)return Promise.resolve(existing);return new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{const found=events.find(predicate);if(found){clearInterval(timer);resolve(found);}else if(Date.now()-started>ms){clearInterval(timer);reject(Error('probe event timeout'));}},10);});}
 wss.on('connection',socket=>{peer=socket;session=createRemoteCryptoSession({sessionId,sendKey:Buffer.from(receive),receiveKey:Buffer.from(send),sendDirection:'desktop-to-client',receiveDirection:'client-to-desktop'});session.enableAdaptiveTransfers();socket.on('ping',()=>pongCount++);
 let binaryEnabled=false;
 socket.on('message',(raw,isBinary)=>{
  let request;try{if(isBinary&&!binaryEnabled)throw Error('binary before negotiation');request=isBinary?session.decryptBinary(raw):session.decrypt(JSON.parse(raw));}catch(error){networkFailure=error;socket.close();return;}
  (async()=>{
   let result;
   if(request.method==='remote.image.binary.negotiate'){binaryEnabled=true;result={ok:true};}
   else result=request.method==='remote.ping'?{ok:true,echo:'native-mixed-ping'}:await business.transfer(context,request.requestId,request.params);
   if(socket.readyState===1)socket.send(JSON.stringify(session.encrypt({kind:'response',requestId:request.requestId,ok:true,result})));
  })().catch(error=>{if(socket.readyState===1)socket.send(JSON.stringify(session.encrypt({kind:'response',requestId:request.requestId,ok:false,error:{code:error.code||'remote_fixture_error'}})));});
 });});
 async function dispatchUpload(method,params,requestId){
   let result;
   if(method==='attachment.begin')result=await manager.begin({deviceId,requestId,params,adaptive:true});
   else if(method==='attachment.chunk'){
    chunkCount++;const now=Date.now();chunkSizes.push(Buffer.from(params.data,'base64url').length);if(previousChunkAt)chunkElapsed.push(now-previousChunkAt);previousChunkAt=now;result=Buffer.isBuffer(params.data)?await manager.chunkBytes({deviceId,params:{uploadId:params.uploadId,index:params.index},data:params.data,adaptive:true}):await manager.chunk({deviceId,params,adaptive:true});
    if(params.index===0 && mode!=='normal'){
     firstChunk?.();
     if(mode==='hold')await new Promise(resolve=>{releaseAck=resolve;});
     else if(mode==='bad')result={...result,upload:{...result.upload,receivedBytes:result.upload.receivedBytes+1}};
    }
   }else if(method==='attachment.complete')result=await manager.complete({deviceId,params});
   else if(method==='attachment.abort')result=await manager.abort({deviceId,params});
   else throw Error('Unexpected method '+method);
   return result;
 }
 try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let port=server.address().port;
 if(slowProxy){proxy=createSlowProxy(port);await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));port=proxy.address().port;}
 child=spawn(java('java'),['-Dfile.encoding=UTF-8','-cp',[out,...jars].join(path.delimiter),'com.anywheremobile.GatewayImageProbe',`wss://127.0.0.1:${port}/api/v2/socket`,certPath,selected,...(slowProxy?['production-ping']:[])],{cwd:root,stdio:['pipe','pipe','inherit']});
 const processExit=new Promise(resolve=>child.once('exit',resolve));
 readline.createInterface({input:child.stdout}).on('line',line=>{try{const value=JSON.parse(line);events.push(value);if(value.id&&pending.has(value.id)){pending.get(value.id).resolve(value);pending.delete(value.id);}}catch(error){networkFailure=error;}});
 function rpc(op,params={}){const id='probe-command-'+(++next);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Java command timeout '+op));},slowProxy?120000:25000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);}});child.stdin.write(JSON.stringify({id,op,...params})+'\n');});}
 await waitFor(x=>x.event==='ready');assert.equal((await rpc('install',{session:sessionId,send:send.toString('base64url'),receive:receive.toString('base64url')})).ok,true);await rpc('adaptive');
 async function register(size){await fsp.writeFile(file,Buffer.alloc(size,0x6c));const result=await rpc('register',{path:file});assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
 if(slowProxy){
  // Start just after a successful native ping, so the old frame spans two
  // production heartbeat deadlines rather than ending before the first ping.
  const limit=Date.now()+20000;while(pongCount<1){if(Date.now()>limit)throw Error('initial proxy heartbeat timeout');await new Promise(resolve=>setTimeout(resolve,50));}
  const started=Date.now(),initialPings=pongCount;
  if(legacyControl){
   const size=707380,sha256=crypto.createHash('sha256').update(Buffer.alloc(size,0x6c)).digest('base64url');
   const begin=await manager.begin({deviceId,requestId:'synthetic-legacy-begin',adaptive:true,params:{name:'synthetic.jpg',type:'image/jpeg',size,sha256}});
   await rpc('legacy',{uploadId:begin.upload.uploadId});
   await waitFor(x=>x.event==='socket-failure',45000);
   assert.equal(chunkCount,0,'old 512KiB message remains incomplete at Desktop');
   assert.equal(pongCount,initialPings,'control ping is behind unfinished old data');
   console.log(JSON.stringify({ok:true,suite:'buffered-proxy-legacy-fails',rateBytes:proxyRate,elapsedMs:Date.now()-started,chunkCount,pingsDuring:pongCount-initialPings,wireBytes}));
  }else{
   const size=707380,handle=await register(size);const result=await rpc('upload',{handle,task:'native-image-slow-proxy'});
   assert.equal(result.ok,true,JSON.stringify(result));const upload=JSON.parse(result.value);
   assert.equal(upload.size,size);assert.equal(upload.sha256,crypto.createHash('sha256').update(Buffer.alloc(size,0x6c)).digest('base64url'));
   const elapsedMs=Date.now()-started;
   assert.equal(chunkSizes[0],128*1024);assert.ok(chunkSizes.every(bytes=>bytes<=128*1024),'slow link must not grow large frames');
   assert.ok(pongCount-initialPings>=1,'actual heartbeat during binary upload');
   assert.ok(elapsedMs<45000,'binary should beat prior 53.6s text baseline');
   const after=pongCount,postLimit=Date.now()+35000;while(pongCount<after+2){if(Date.now()>postLimit)throw Error('post upload heartbeat timeout');await new Promise(resolve=>setTimeout(resolve,100));}
   assert.equal((await rpc('ping')).ok,true);assert.ok(!events.some(x=>x.event==='socket-failure'||x.event==='failure'));
   console.log(JSON.stringify({ok:true,suite:'buffered-proxy-native-image',rateBytes:proxyRate,rawBytes:size,elapsedMs,chunkSizes,chunkElapsed,pingsDuring:after-initialPings,pingsAfter:pongCount-after,wireBytes}));
  }
  await rpc('close');child.stdin.end();await processExit;return;
 }
 for(const size of [820*1024,5*1024*1024+17]){
  mode='normal';chunkCount=0;chunkSizes.length=0;chunkElapsed.length=0;previousChunkAt=0;const started=Date.now();const handle=await register(size);const task='native-image-task-'+size;
  // Mutating the originally selected file cannot alter the immutable snapshot.
  await fsp.writeFile(file,'source changed after registration');
  const result=await rpc('upload',{handle,task});assert.equal(result.ok,true,JSON.stringify(result));const uploaded=JSON.parse(result.value);assert.equal(uploaded.size,size);assert.equal(uploaded.sha256,crypto.createHash('sha256').update(Buffer.alloc(size,0x6c)).digest('base64url'));assert.ok(chunkCount>=2);
  assert.equal(chunkSizes[0],128*1024);if(size>5*1024*1024)assert.ok(Math.max(...chunkSizes)>=1024*1024,'fast link grows beyond small chunks');
  console.log(JSON.stringify({ok:true,suite:'native-image-fast-throughput',rawBytes:size,elapsedMs:Date.now()-started,chunkSizes,chunkElapsed}));
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
 const trace=JSON.parse((await rpc('diagnostics')).value);
 assert.ok(trace.length<=256);assert.ok(trace.some(row=>row.event==='submitted'));assert.ok(trace.some(row=>row.event==='drained'));assert.ok(trace.some(row=>row.event==='ack_failed'));
 for(const row of trace)assert.ok(Object.keys(row).every(key=>['atMs','generation','event','bytes','elapsedMs','code'].includes(key)));
 assert.ok(!JSON.stringify(trace).includes(temp));assert.ok(!JSON.stringify(trace).includes('native-image-'));

 child.stdin.end();await processExit;assert.equal(networkFailure,undefined);const snapshots=await fsp.readdir(path.join(selected,'snapshots'));assert.equal(snapshots.length,0);
 console.log(JSON.stringify({ok:true,suite:'production-java-image-tls-wss',coverage:'820KiB/5MiB/immutable snapshot/SHA/first ACK gate/mixed ping/native pong/cancel/bad ACK/private path/no replay/cleanup',pongCount}));
 }finally{
  for(const socket of proxySockets)socket.destroy();if(proxy)await new Promise(resolve=>proxy.close(resolve));
  releaseAck?.();child?.stdin.end();if(child&&child.exitCode===null)child.kill();peer?.terminate();for(const socket of wss.clients)socket.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));session?.close();await manager.stop();send.fill(0);receive.fill(0);await fsp.rm(temp,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
