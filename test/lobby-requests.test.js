const assert=require('node:assert/strict');
const {createLobbyRequests}=require('../public/lobby-requests');
function setup(connected=true){
  const requests=[],handlers={},successes=[];let view,connects=0,disconnects=0;
  const socket={connected,on:(e,fn)=>handlers[e]=fn,timeout(ms){this.ms=ms;return this;},get volatile(){this.lossy=true;return this;},emit(event,payload,callback){requests.push({event,payload,callback,ms:this.ms,volatile:this.lossy});this.lossy=false;},disconnect(){disconnects++;this.connected=false;handlers.disconnect();},connect(){connects++;}};
  const c=createLobbyRequests({socket,onChange:s=>view=s});c.refresh();
  const send=(kind,payload={name:'测试',code:'ABC123'})=>c.send(kind,payload,{success:r=>successes.push(r)});
  const online=()=>{socket.connected=true;handlers.connect();};
  return {c,socket,requests,successes,send,online,failed:()=>handlers.connect_error(),get view(){return view;},get connects(){return connects;},get disconnects(){return disconnects;}};
}
const good={ok:true,code:'ABC123',token:'new-token'};
{
  const f=setup(false);for(const k of ['create','preview','join'])assert.equal(f.send(k),false);
  assert.equal(f.requests.length,0);assert.equal(f.view.pendingKind,'');f.failed();assert.equal(f.view.connection,'failed');
  f.online();assert.equal(f.requests.length,0,'恢复连接不能执行以前点击的操作');assert.equal(f.view.connection,'recovered');assert.doesNotMatch(f.view.message,/尚未连接/);
  f.send('create',{name:'甲',mode:'squid',squidPayment:50,settings:{startChips:3000}});
  assert.equal(f.requests[0].ms,10000);assert.equal(f.requests[0].volatile,true);assert.equal(f.requests[0].payload.squidPayment,50);
  assert.equal(f.send('create'),false);f.requests[0].callback(null,good);assert.equal(f.successes.length,1);
}
{
  const f=setup();f.send('preview',{code:'ABC123'});const old=f.requests[0];assert.equal(old.ms,8000);
  old.callback(new Error('timeout'));assert.equal(f.view.unknown,null);assert.match(f.view.message,/手动重新查询/);
  f.send('preview',{code:'DEF456'});old.callback(null,{ok:true,info:{settings:{}}});assert.equal(f.successes.length,0);assert.equal(f.view.pendingCode,'DEF456');
  f.c.cancelQuery();f.requests[1].callback(null,{ok:true,info:{settings:{}}});assert.equal(f.successes.length,0,'新输入不能被迟到预览覆盖');
  f.send('preview');f.c.leaveView();f.send('create');f.requests[2].callback(null,{ok:true,info:{settings:{}}});assert.equal(f.view.pendingKind,'create');assert.equal(f.successes.length,0);
}
for(const kind of ['create','join']){
  const f=setup();f.send(kind);const old=f.requests[0];old.callback(new Error('timeout'));
  assert.equal(f.view.unknown.kind,kind);assert.match(f.view.message,/结果未确认.*可能已成功/);
  f.c.leaveView();for(const k of ['create','join','preview'])assert.equal(f.send(k),false);
  f.socket.disconnect();f.online();assert.equal(f.requests.length,1);assert.equal(f.view.unknown.kind,kind);
  assert.equal(f.c.abandonForNewRoom(false),false);assert.equal(f.c.abandonForNewRoom(true),true);
  assert.equal(f.requests.length,1,'放弃等待只重建连接，不能连锁建房');assert.equal(f.connects,1);
  assert.equal(f.send('create'),false);f.online();assert.equal(f.send('join'),false,'另建许可不能变成其他加入操作');
  old.callback(null,{...good,token:'old-token'});assert.equal(f.successes.length,0,'放弃的旧回执不能保存token或跳房');
  f.send('create');old.callback(null,{...good,token:'old-token'});assert.equal(f.view.pendingKind,'create');
  f.requests[1].callback(null,good);assert.equal(f.successes.length,1);assert.equal(f.successes[0].token,'new-token');assert.equal(f.view.replacement,false);
}
{
  const f=setup();f.send('create');f.c.leaveView();f.requests[0].callback(null,good);assert.equal(f.successes.length,0);assert.equal(f.view.unknown.kind,'create','返回大厅不解除未知态');
}
{
  const f=setup();f.send('join');f.socket.disconnect();assert.equal(f.view.unknown.kind,'join');f.online();assert.equal(f.requests.length,1,'真实断线恢复不自动重提');
}
{
  const f=setup();f.send('create');f.requests[0].callback(null,{ok:false,err:'已在房间中'});assert.equal(f.view.unknown,null);assert.equal(f.view.pendingKind,'');
  f.send('create');f.requests[1].callback(null,{ok:true,code:'ABC123'});assert.equal(f.successes.length,0,'没有凭证的成功回执不能恢复身份');assert.equal(f.view.unknown.kind,'create');
}
console.log('PASS 大厅：首次连接零业务请求、8/10秒边界、查询取消/旧回执、创建/加入未知防重提、明确另建无自动发送、凭证隔离');
