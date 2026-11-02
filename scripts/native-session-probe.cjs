/* Production Java AES/queues and synthetic Desktop crypto. Never runs a device. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn,spawnSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict'),crypto=require('node:crypto'),readline=require('node:readline');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/internal-test/native-session-probe');
function jar(group,name,version){const dir=path.join(os.homedir(),'.gradle/caches/modules-2/files-2.1',group,name,version);for(const hash of fs.readdirSync(dir)){const p=path.join(dir,hash,`${name}-${version}.jar`);if(fs.existsSync(p))return p;}throw Error('Missing dependency '+name);}
const jars=[jar('com.squareup.okhttp3','okhttp','4.12.0'),jar('com.squareup.okio','okio-jvm','3.6.0'),jar('org.jetbrains.kotlin','kotlin-stdlib','1.9.20'),jar('org.json','json','20180813')];
const java=name=>path.join(process.env.JAVA_HOME||'E:/Program/Java/Java17','bin',name+'.exe');
fs.mkdirSync(out,{recursive:true});
const sources=['GatewayCrypto','GatewaySession','GatewaySocketWriter','GatewayUploads'].map(x=>path.join(root,'android/app/src/main/java/com/anywheremobile',x+'.java')).filter(x=>fs.existsSync(x));
const compile=spawnSync(java('javac'),['-cp',jars.join(path.delimiter),'-d',out,...sources,path.join(root,'tests/native/GatewayCryptoProbe.java')],{cwd:root,stdio:'inherit'});if(compile.status)process.exit(compile.status);
(async()=>{
 const {createRemoteCryptoSession}=await import(pathToFileURL(path.resolve(root,'../Anywhere_desktop/main/core/remote/cryptoSession.js')));
 const child=spawn(java('java'),['-Dfile.encoding=UTF-8','-cp',[out,...jars].join(path.delimiter),'com.anywheremobile.GatewayCryptoProbe'],{cwd:root,stdio:['pipe','pipe','inherit']});
 const pending=[];readline.createInterface({input:child.stdout}).on('line',line=>{const next=pending.shift();if(next)next.resolve(JSON.parse(line));});
 child.on('exit',()=>{for(const p of pending.splice(0))p.reject(Error('Java probe exited'));});
 const rpc=command=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify(command)+'\n');});
 let desktop;
 try{
 const send=crypto.randomBytes(32),receive=crypto.randomBytes(32),id='session-native-crypto-fixture';
 await rpc({op:'install',id,send:send.toString('base64url'),receive:receive.toString('base64url')});
 desktop=createRemoteCryptoSession({sessionId:id,sendKey:Buffer.from(receive),receiveKey:Buffer.from(send),sendDirection:'desktop-to-client',receiveDirection:'client-to-desktop'});
 const payload={kind:'request',requestId:'request-native-vector',method:'remote.ping',params:{text:'中文😀\n"\\$&',value:42}};
 const frame=(await rpc({op:'encrypt',payload})).value;assert.deepEqual(desktop.decrypt(frame),payload);
 const answer={kind:'response',requestId:payload.requestId,ok:true,result:{text:'完整中😀'}};
 const encrypted=desktop.encrypt(answer);assert.deepEqual((await rpc({op:'decrypt',frame:encrypted})).value,answer);
 assert.equal((await rpc({op:'decrypt',frame:encrypted})).ok,false);
 const valid=desktop.encrypt(answer),corrupt=structuredClone(valid);corrupt.tag=(corrupt.tag[0]==='A'?'B':'A')+corrupt.tag.slice(1);
 assert.equal((await rpc({op:'decrypt',frame:corrupt})).code,'remote_frame_auth_failed');assert.deepEqual((await rpc({op:'decrypt',frame:valid})).value,answer);
 await rpc({op:'adaptive'});desktop.enableAdaptiveTransfers();
 for(const size of [512*1024,820*1024,2*1024*1024,8*1024*1024]){const request={...payload,params:{data:Buffer.alloc(size,7).toString('base64url')}};const result=await rpc({op:'encrypt',payload:request});assert.equal(result.ok,true);assert.deepEqual(desktop.decrypt(result.value),request);}
 await rpc({op:'close'});assert.equal((await rpc({op:'encrypt',payload})).ok,false);
 console.log(JSON.stringify({ok:true,suite:'production-java-crypto-desktop-interop',coverage:'UTF8/nonBMP/AAD/tag/replay/sequence/512KiB/820KiB/2MiB/8MiB/close'}));
 }finally{desktop?.close();child.stdin.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
